/**
 * СЛИПШИЕСЯ КУСКИ ОДНОЙ СТРОКИ.
 *
 * Разметка `<span><a>Merge pull request</a> <a>#16</a> <span>from …</span></span>`
 * рисуется браузером с промежутками: пробел между строчными элементами —
 * такой же значимый символ, как буква. Слипается он — и выходит
 * «request#16from», «0stars», «Contributors◯», «97ad298·Aug 6».
 *
 * ТРИ ПРЕДЫДУЩИЕ ВЕРСИИ СТЕНДА БЫЛИ НЕВЕРНЫ, и это стоит записать:
 *  1. Первая искала склейку В ТЕКСТЕ одного узла — куски остаются РАЗНЫМИ
 *     узлами сцены, находила ноль.
 *  2. Вторая сравнивала просвет у пар СОСЕДНИХ ПО СПИСКУ узлов, взятых из
 *     трассы импорта. Она тоже давала ноль на gh-plexus — по двум причинам:
 *     куски собственного текста родителя (то самое «stars», «·») в трассе
 *     НЕ ЛЕЖАТ вовсе (у текстового узла нет своего прямоугольника в снимке),
 *     а пары брались только вплотную по отсортированному списку, так что
 *     любой не-текстовый узел между ними разрывал пару.
 *  3. И ни та, ни другая не смотрели на ЭКСПОРТ, где просвет выражен левым
 *     отступом, — а именно там он и обнулялся (`margin: 0` у надписи).
 *
 * Здесь три отдельные мерки, и каждая ловит свой род склейки:
 *
 *  ▸ ХОЛСТ. Пары соседей по строке ищутся в НАШЕЙ раскладке (по y и x
 *    посчитанных коробок), а не в снимке: слипание — это свойство нашего
 *    результата. Пара засчитана слипшейся, когда просвет между коробками
 *    меньше пробела этого кегля, а на стыке стоят два «словесных» знака
 *    (буква/цифра/знак пунктуации) — то есть глифы читаются одним словом.
 *    Ground truth: у пары, ОБА конца которой измерены (есть в трассе),
 *    просвет сверяется с измеренным; у куска собственного текста
 *    измеренного прямоугольника нет, поэтому доказательством служит
 *    ПРОБЕЛ В ТЕКСТЕ — сборщик пишет его ровно там, где он значим
 *    (см. `ownText`), и стирать его в раскладке нельзя.
 *
 *  ▸ ЭКСПОРТ. В сгенерированном CSS у надписи может стоять `margin: 0`
 *    после вычисленного отступа: по каскаду ноль побеждает, и просвет,
 *    восстановленный на холсте, в коде исчезает. Считаем такие класcы.
 *
 *  ▸ ТЕКСТ. Сколько узлов сохранили значимый краевой пробел — прямая
 *    мера того, доехал ли символ из снимка до сцены.
 *
 *   npx tsx tools/harness/glue.ts fixtures/snapshots/<имя>.json
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
g.DOMParser = dom.window.DOMParser;
g.Node = dom.window.Node;
g.Element = dom.window.Element;
g.document = dom.window.document;
g.window = dom.window;

const { importSnapshotToDoc } = await import("../../src/core/importSnapshot");
const { computeLayout } = await import("../../src/core/layout");
const { createStarterDocument } = await import("../../src/core/scene");
const { generateProject } = await import("../../src/core/codegen");
const { measureStub } = await import("./measure-stub");
type PageSnapshot = import("../../src/core/snapshot").PageSnapshot;
type SceneNode = import("../../src/core/types").SceneNode;

const path = process.argv[2] ?? "fixtures/snapshots/gh-plexus.json";
const snap = JSON.parse(readFileSync(path, "utf8")) as PageSnapshot;

const doc = createStarterDocument();
doc.nodes = {};
doc.rootFrames = [];
doc.wires = [];
const out = importSnapshotToDoc(doc, { snapshot: snap, pageName: "проверка", trace: true });
const rects = computeLayout(doc, measureStub);
const frame = doc.nodes[out.frameId]!;

interface Item {
  text: string;
  /** Полный текст — по нему видно краевой пробел. */
  full: string;
  size: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Измеренный прямоугольник, если узел есть в трассе. */
  sx?: number;
  sw?: number;
  /** Ширина из модели: число означает жёсткую, заданную по просвету. */
  width?: number | string;
}
const items: Item[] = [];
let edgeSpaceNodes = 0;
for (const node of Object.values(doc.nodes) as SceneNode[]) {
  if (!node.text) continue;
  const r = rects.get(node.id);
  if (!r || r.w <= 0) continue;
  const idx = out.trace?.get(node.id);
  const s = idx === undefined ? undefined : snap.nodes[idx];
  if (/^[  ]|[  ]$/.test(node.text)) edgeSpaceNodes += 1;
  items.push({
    text: node.text.slice(0, 22).replace(/\n/g, "⏎"),
    full: node.text,
    size: node.style.fontSize || 16,
    x: r.x - frame.layout.x,
    y: r.y - frame.layout.y,
    w: r.w,
    h: r.h,
    sx: s && s.r[2] > 0 ? s.r[0] : undefined,
    sw: s && s.r[2] > 0 ? s.r[2] : undefined,
    width: node.layout.width,
  });
}

/* ──────────────── МЕРКА 1: ПРОСВЕТ ПОТЕРЯН НА ХОЛСТЕ ────────────────
   Пары соседей по строке ищем в НАШЕЙ раскладке: слипание — свойство
   нашего результата, а не снимка. Разрыв по списку не годится (между
   двумя надписями законно стоит картинка), поэтому для каждого узла
   берём ближайшего справа на той же строке. Судим только пары, у
   которых ОБА конца измерены: тогда «сколько должно быть» — не оценка. */
items.sort((a, b) => a.y - b.y || a.x - b.x);
const WORD = /[\p{L}\p{N}\p{P}]/u;
const lost: Array<{ a: Item; b: Item; ours: number; src: number }> = [];
const touching: Array<{ a: Item; b: Item }> = [];
for (let i = 0; i < items.length; i += 1) {
  const a = items[i];
  let b: Item | null = null;
  for (let j = i + 1; j < items.length; j += 1) {
    const c = items[j];
    if (c.y > a.y + a.h * 0.6) break;
    /* На одной строке — по пересечению вертикальных полос, а не по равенству
       верхних краёв: у соседей разный кегль. */
    if (Math.min(a.y + a.h, c.y + c.h) - Math.max(a.y, c.y) < Math.min(a.h, c.h) * 0.5) continue;
    if (c.x + 0.5 < a.x + a.w) continue; // левее правого края — не сосед справа
    if (!b || c.x < b.x) b = c;
  }
  if (!b) continue;
  const gap = b.x - (a.x + a.w);
  if (a.sx !== undefined && a.sw !== undefined && b.sx !== undefined) {
    const srcGap = b.sx - (a.sx + a.sw);
    if (srcGap >= 2 && srcGap <= 40 && gap < srcGap - 1.5) lost.push({ a, b, ours: gap, src: srcGap });
  }
  /* Глифы вплотную: коробки встык И ни один край текста не несёт пробела.
     Это то, что видно глазом как «0stars». */
  const lastCh = a.full.slice(-1);
  const firstCh = b.full.slice(0, 1);
  if (gap < 1.5 && WORD.test(lastCh) && WORD.test(firstCh)) touching.push({ a, b });
}

/* ─────── МЕРКА 2: ДОЕХАЛ ЛИ ЗНАЧИМЫЙ КРАЕВОЙ ПРОБЕЛ ИЗ СНИМКА ───────
   Сборщик пишет пробел на краю куска собственного текста ровно там, где
   он значим (см. `ownText`): поток строчный и сосед по стыку строчного
   уровня. Значит в снимке есть СПИСОК кусков, которые обязаны прийти в
   сцену с пробелом на краю. Проверяем по этому списку: кусок найден в
   сцене по своему ядру, и либо пробел при нём, либо он стёрт. */
const MARK = String.fromCharCode(0);
const sceneByCore = new Map<string, string[]>();
for (const it of items) {
  /* Только НЕизмеренные узлы: у элемента снимка просвет к соседу измерен и
     восстанавливается отступом (мерка 1), а вот кусок собственного текста
     родителя своего прямоугольника не имеет — там пробел обязан приехать
     символом, и другого носителя у него нет. */
  if (it.sx !== undefined) continue;
  /* …и только те куски, что стоят НА ОДНОЙ СТРОКЕ с детьми: импорт даёт им
     жёсткую ширину по измеренному просвету (`addOwnText`, ветка `!roomy`).
     У куска со своими строками краевой пробел схлопывается законно — это
     начало и конец строки, — и в знаменателе ему не место. */
  if (typeof it.width !== "number") continue;
  const core = it.full.replace(/\s+/g, " ").trim();
  if (!core) continue;
  const list = sceneByCore.get(core) ?? [];
  list.push(it.full);
  sceneByCore.set(core, list);
}
let expected = 0;
let delivered = 0;
const wiped: string[] = [];
for (const n of snap.nodes) {
  if (!n.xm) continue;
  const segs = n.xm.split(MARK);
  for (const seg of segs) {
    const core = seg.replace(/\s+/g, " ").trim();
    if (!core) continue;
    if (!/^[ \u00a0]|[ \u00a0]$/.test(seg)) continue;
    const got = sceneByCore.get(core);
    if (!got) continue; // кусок в сцену не попал — это не про пробел
    expected += 1;
    if (got.some((t) => /^[ \u00a0]|[ \u00a0]$/.test(t))) delivered += 1;
    else if (wiped.length < 8) wiped.push(core.slice(0, 30));
  }
}

/* ─────────── МЕРКА 3: ДОЖИЛ ЛИ ПРОСВЕТ ДО ЭКСПОРТА ───────────
   Просвет между строчными соседями выражен ЛЕВЫМ ОТСТУПОМ (`noteInlineLead`):
   пробел разметки не описан ни одним свойством, он измерен. В CSS у одного
   класса объявлений `margin` может быть несколько, и побеждает ПОСЛЕДНЕЕ.
   Считаем не по шаблону, а по каскаду: сколько узлов сцены имеют отступ в
   модели и сколько из них теряют его в сгенерированном CSS. */
const css = generateProject(doc, "проверка").files["site/styles.css"] ?? "";
const cssMarginOf = new Map<string, string>();
for (const block of css.split("}")) {
  const sel = /\.([\w-]+)\s*\{/.exec(block);
  if (!sel) continue;
  const ms = [...block.matchAll(/margin:\s*([^;]+);/g)].map((m) => m[1]);
  if (ms.length) cssMarginOf.set(sel[1], ms[ms.length - 1]);
}
/* Класс узла в экспорте выводится из HTML по data-plx-id. */
const html = generateProject(doc, "проверка").files["site/index.html"] ?? "";
const clsOf = new Map<string, string>();
for (const m of html.matchAll(/class="([^"]+)"[^>]*data-plx-id="([^"]+)"/g)) clsOf.set(m[2], m[1].split(/\s+/)[0]);
let withMargin = 0;
let clobbered = 0;
for (const node of Object.values(doc.nodes) as SceneNode[]) {
  const mg = node.layout.margin;
  if (!mg || !(mg.t || mg.r || mg.b || mg.l)) continue;
  withMargin += 1;
  const cls = clsOf.get(node.id);
  const declared = cls === undefined ? undefined : cssMarginOf.get(cls);
  if (declared !== undefined && /^0(px)?$/.test(declared.trim())) clobbered += 1;
}

console.log(`\n▸ СЛИПШИЕСЯ КУСКИ СТРОКИ — ${basename(path)}`);
console.log(`  текстовых узлов в сцене            ${items.length}`);
console.log(`  просвет потерян (измеренные пары)  ${lost.length}`);
for (const p of lost.slice(0, 8)) {
  console.log(`   «${p.a.text}»+«${p.b.text}»  снимок ${p.src}px → наш ${p.ours.toFixed(1)}px`);
}
console.log(`  глифы вплотную (коробки встык)     ${touching.length}`);
for (const p of touching.slice(0, 8)) console.log(`   «${p.a.text}»+«${p.b.text}»`);
console.log(`  краевой пробел доехал              ${delivered} из ${expected}`);
if (wiped.length) console.log(`   стёрт у: ${wiped.join(" · ")}`);
console.log(`  отступ узла в модели / затёрт в CSS ${withMargin} / ${clobbered}`);
console.log(
  `\nJSON ${JSON.stringify({ nodes: items.length, lostGaps: lost.length, touching: touching.length, edgeExpected: expected, edgeDelivered: delivered, marginNodes: withMargin, cssClobbered: clobbered })}\n`,
);

/**
 * УСЕЧЕНИЕ МНОГОТОЧИЕМ: ДОЕХАЛ ЛИ ИЗМЕРЕННЫЙ ФАКТ ДО МОДЕЛИ И КОДА.
 *
 * Браузер сообщает про элемент две вещи: обрезка объявлена
 * (`text-overflow: ellipsis`) и обрезка СЛУЧИЛАСЬ (`scrollWidth >
 * clientWidth`). Сборщик пишет вторую в поле `tr`. Здесь проверяется весь
 * остаток пути:
 *
 *  1. НАСКОЛЬКО НАДПИСЬ ВЫЛЕЗАЕТ ЗА СВОЮ КОРОБКУ. Прямая мера дефекта: у
 *     обрезанного узла измеренный прямоугольник — это ширина НЕВИДИМОГО
 *     содержимого (у сообщения коммита GitHub 474px против видимых 389),
 *     и раскладка, взявшая его за истину, наезжает на соседнюю колонку.
 *     Считаем сумму и максимум перебора по всем усечённым узлам.
 *  2. НАЛОЖЕНИЯ. Та же мерка, что в `overlap.ts`: пара текстов
 *     пересекается в НАШЕЙ раскладке и не пересекается в снимке.
 *  3. МОДЕЛЬ. Сколько узлов сцены несут `ellipsis`, и у всех ли при нём
 *     стоит запрет переноса и потолок ширины.
 *  4. ЭКСПОРТ. У всех ли таких классов в CSS честная тройка
 *     `overflow: hidden` + `text-overflow: ellipsis` + `white-space: nowrap`.
 *
 *   npx tsx tools/harness/ellipsis.ts fixtures/snapshots/<имя>.json
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

/** Строка, урезанная под ширину так же, как это делает холст. */
function fit(
  text: string,
  style: SceneNode["style"],
  fam: string,
  width: number,
  extra: { letterSpacing?: number; lineHeight?: number; uppercase?: boolean },
): string {
  const w = (t: string) => measureStub(t, style.fontSize, style.fontWeight, fam, undefined, extra).w;
  if (!text || w(text) <= width) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (w(`${text.slice(0, mid)}…`) <= width) lo = mid;
    else hi = mid - 1;
  }
  return lo <= 0 ? "…" : `${text.slice(0, lo)}…`;
}

/* Помеченные снимком узлы и их поддеревья: обрезка блока действует на всё
   строчное содержимое, поэтому режущую ширину наследуют дети. */
const kids = new Map<number, number[]>();
snap.nodes.forEach((n, i) => {
  const a = kids.get(n.p);
  if (a) a.push(i);
  else kids.set(n.p, [i]);
});
const clipOf = new Map<number, number>();
const spread = (idx: number, w: number): void => {
  const prev = clipOf.get(idx);
  if (prev !== undefined && prev <= w) return;
  clipOf.set(idx, w);
  for (const c of kids.get(idx) ?? []) spread(c, w);
};
const declared = snap.nodes.filter((n) => (n.s["text-overflow"] ?? "").includes("ellipsis")).length;
const flagged = snap.nodes.filter((n) => n.tr === 1).length;
snap.nodes.forEach((n, idx) => {
  if (n.tr !== 1) return;
  const px = parseFloat(n.s["padding-left"] ?? "0") + parseFloat(n.s["padding-right"] ?? "0");
  const inner = Math.round(n.r[2] - (Number.isFinite(px) ? px : 0));
  if (inner > 0) spread(idx, inner);
});

/* ── 1. Сколько надписи рисуется ЗА своей коробкой ──
   У обрезанного узла коробка измерена верно (389px) — врёт не она, а
   ТЕКСТ: в модели он лежит целиком, и рисуется целиком. Меряем ровно то,
   что видно глазом: насколько глифы одной строки уходят правее коробки
   (перебор по X — наезд на соседнюю колонку) и насколько перенесённый по
   ширине коробки текст уходит ниже её (перебор по Y — наезд на строку
   снизу; именно так рисовал холст, потому что перенос на экране не
   спрашивал про `noWrap`). У честно усечённого узла оба нуля. */
let overflowSum = 0;
let overflowMax = 0;
let overflowNodes = 0;
let spillY = 0;
let modelEllipsis = 0;
let modelSound = 0;
const sample: string[] = [];
for (const node of Object.values(doc.nodes) as SceneNode[]) {
  if (!node.text) continue;
  const r = rects.get(node.id);
  if (!r) continue;
  if (node.layout.ellipsis) {
    modelEllipsis += 1;
    /* Полный флаг — это запрет переноса И потолок по ширине. Потолком
       годится и жёсткая ширина: она держит строку строже, чем max-width. */
    const capped = node.layout.maxWidth !== undefined || typeof node.layout.width === "number";
    if (node.layout.noWrap && capped) modelSound += 1;
  }
  const idx = out.trace?.get(node.id);
  if (idx === undefined) continue;
  const clip = clipOf.get(idx);
  if (clip === undefined) continue;
  const extra = {
    letterSpacing: node.style.letterSpacing,
    lineHeight: node.style.lineHeight,
    uppercase: node.style.uppercase,
  };
  const fam = node.style.fontFamily ?? "Inter, sans-serif";
  /* Что реально нарисуется: усечённая строка или полная. */
  const shown = node.layout.ellipsis ? fit(node.text, node.style, fam, r.w, extra) : node.text;
  const oneLine = measureStub(shown, node.style.fontSize, node.style.fontWeight, fam, undefined, extra);
  const wrapped = measureStub(shown, node.style.fontSize, node.style.fontWeight, fam, Math.max(24, r.w), extra);
  const overX = Math.round(oneLine.w - r.w);
  const overY = Math.round(wrapped.h - r.h);
  if (overX > 1 || overY > 1) {
    overflowNodes += 1;
    overflowSum += Math.max(0, overX);
    spillY += Math.max(0, overY);
    overflowMax = Math.max(overflowMax, Math.max(0, overX));
    if (sample.length < 6) {
      sample.push(`«${node.text.slice(0, 26)}» коробка ${Math.round(r.w)}×${Math.round(r.h)}, текст ${Math.round(oneLine.w)}px в одну строку / ${wrapped.h}px с переносом`);
    }
  }
}

/* ── 2. Наложения текстов (мерка `overlap.ts`) ── */
const ob: Array<{ x: number; y: number; w: number; h: number; sx: number; sy: number; sw: number; sh: number }> = [];
for (const node of Object.values(doc.nodes) as SceneNode[]) {
  if (!node.text) continue;
  const r = rects.get(node.id);
  const idx = out.trace?.get(node.id);
  if (!r || idx === undefined) continue;
  const s = snap.nodes[idx];
  if (!s || s.r[2] <= 1 || s.r[3] <= 1) continue;
  ob.push({ x: r.x - frame.layout.x, y: r.y - frame.layout.y, w: r.w, h: r.h, sx: s.r[0], sy: s.r[1], sw: s.r[2], sh: s.r[3] });
}
const seg = (a: number, b: number, c: number, d: number) => Math.max(0, Math.min(a + b, c + d) - Math.max(a, c));
ob.sort((p, q) => p.y - q.y);
let over = 0;
for (let i = 0; i < ob.length; i += 1) {
  for (let j = i + 1; j < ob.length; j += 1) {
    const a = ob[i];
    const b = ob[j];
    if (b.y > a.y + a.h) break;
    const ours = seg(a.x, a.w, b.x, b.w) * seg(a.y, a.h, b.y, b.h);
    if (ours <= 0) continue;
    const src = seg(a.sx, a.sw, b.sx, b.sw) * seg(a.sy, a.sh, b.sy, b.sh);
    const minArea = Math.min(a.w * a.h, b.w * b.h);
    if (ours > minArea * 0.25 && src <= minArea * 0.05) over += 1;
  }
}

/* ── 4. Экспорт: честная тройка свойств ── */
const files = generateProject(doc, "проверка").files;
const css = files["site/styles.css"] ?? "";
const html = files["site/index.html"] ?? "";
const clsOf = new Map<string, string>();
for (const m of html.matchAll(/class="([^"]+)"[^>]*data-plx-id="([^"]+)"/g)) clsOf.set(m[2], m[1].split(/\s+/)[0]);
const blockOf = new Map<string, string>();
for (const block of css.split("}")) {
  const sel = /\.([\w-]+)\s*\{/.exec(block);
  if (sel) blockOf.set(sel[1], block);
}
let cssSound = 0;
for (const node of Object.values(doc.nodes) as SceneNode[]) {
  if (!node.layout.ellipsis) continue;
  const b = blockOf.get(clsOf.get(node.id) ?? "") ?? "";
  if (/text-overflow:\s*ellipsis/.test(b) && /overflow:\s*hidden/.test(b) && /white-space:\s*nowrap/.test(b)) cssSound += 1;
}

console.log(`\n▸ УСЕЧЕНИЕ МНОГОТОЧИЕМ — ${basename(path)}`);
console.log(`  объявлено в снимке / измеренно обрезано  ${declared} / ${flagged}`);
console.log(`  надписей внутри режущих коробок          ${clipOf.size ? [...clipOf.keys()].length : 0}`);
console.log(`  ТЕКСТ ВЫЛЕЗАЕТ за коробку               ${overflowNodes} узлов · по X ${overflowSum}px (макс ${overflowMax}) · по Y ${spillY}px`);
for (const s of sample) console.log(`   ${s}`);
console.log(`  наложения текстов (мерка overlap)        ${over}`);
console.log(`  в модели ellipsis / из них полных        ${modelEllipsis} / ${modelSound}`);
console.log(`  в CSS честная тройка свойств            ${cssSound} из ${modelEllipsis}`);
console.log(
  `\nJSON ${JSON.stringify({
    declared, flagged, overflowNodes, overflowSum, overflowMax, spillY, overlaps: over, modelEllipsis, modelSound, cssSound,
  })}\n`,
);

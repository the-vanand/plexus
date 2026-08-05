/**
 * ДИАГНОСТИКА ОДНОГО СНИМКА.
 *
 * Прибор (`snapshot-check.ts`) отвечает на вопрос «насколько плохо», этот
 * стенд — на вопрос «где именно». Отличие одно, но решающее: импорт
 * запускается с `trace`, поэтому сверить с измеренной геометрией можно
 * ЛЮБОЙ узел, а не только текстовый. Ошибка высоты копится в контейнерах,
 * а у контейнеров текста нет — без трассы их не видно вовсе.
 *
 *   npx tsx tools/harness/diag.ts fixtures/snapshots/guardian-1440.json h
 *
 * Режимы: `h` — кто выше измеренного, `y` — кто съехал вниз,
 * `x` — кто съехал вбок, сгруппировано по цепочке предков.
 */
import { readFileSync } from "node:fs";
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
const { measureStub } = await import("./measure-stub");
type PageSnapshot = import("../../src/core/snapshot").PageSnapshot;
type SceneNode = import("../../src/core/types").SceneNode;

const path = process.argv[2];
const mode = process.argv[3] ?? "h";
const top = parseInt(process.argv[4] ?? "25", 10);
const snap = JSON.parse(readFileSync(path, "utf8")) as PageSnapshot;

const doc = createStarterDocument();
doc.nodes = {};
doc.rootFrames = [];
doc.wires = [];
const out = importSnapshotToDoc(doc, { snapshot: snap, pageName: "diag", trace: true });
const rects = computeLayout(doc, measureStub);
const frameX = doc.nodes[out.frameId]!.layout.x;
const frameY = doc.nodes[out.frameId]!.layout.y;
const trace = out.trace!;

const tag = (n: SceneNode): string => {
  const l = n.layout;
  const bits = [n.type, l.preset ?? l.direction];
  if (l.gridTracks) bits.push(`T${l.gridTracks.length}`);
  if (l.gridColumn) bits.push(`c${l.gridColumn}/${l.gridSpan}`);
  if (l.gridRow) bits.push(`r${l.gridRow}+${l.gridRowSpan ?? 1}`);
  if (typeof l.height === "number") bits.push(`h=${l.height}`);
  if (l.position === "absolute") bits.push("abs");
  return `${n.name.slice(0, 18)}{${bits.join(",")}}`;
};

const chainOf = (n: SceneNode, depth = 5): string => {
  const out: string[] = [];
  let p = n.parent;
  while (p && out.length < depth) {
    const pn = doc.nodes[p];
    if (!pn) break;
    out.push(tag(pn));
    p = pn.parent;
  }
  return out.join(" < ");
};

interface Row {
  node: SceneNode;
  si: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  sh: number;
  gh: number;
}
const rows: Row[] = [];
for (const node of Object.values(doc.nodes) as SceneNode[]) {
  const si = trace.get(node.id);
  if (si === undefined) continue;
  const r = rects.get(node.id);
  const src = snap.nodes[si];
  if (!r || !src) continue;
  rows.push({
    node,
    si,
    dx: Math.round(r.x - frameX - src.r[0]),
    dy: Math.round(r.y - frameY - src.r[1]),
    dw: Math.round(r.w - src.r[2]),
    dh: Math.round(r.h - src.r[3]),
    sh: src.r[3],
    gh: Math.round(r.h),
  });
}

const byId = new Map(rows.map((r) => [r.node.id, r]));

if (mode === "h") {
  /* СОБСТВЕННЫЙ перебор высоты: превышение узла минус максимум превышения
     детей. Без этого верхние контейнеры просто повторяют ошибку потомков и
     список забивается предками одного и того же виновника. */
  const own = rows.map((r) => {
    const kid = Math.max(0, ...r.node.children.map((c) => byId.get(c)?.dh ?? 0));
    return { r, own: r.dh - kid };
  });
  own.sort((a, b) => b.own - a.own);
  console.log(`высота: свой перебор (всего узлов с трассой ${rows.length})`);
  for (const { r, own: o } of own.slice(0, top)) {
    console.log(
      `  +${String(o).padStart(6)}  h ${String(r.sh).padStart(6)}→${String(r.gh).padEnd(7)} ${tag(r.node)}\n            < ${chainOf(r.node, 3)}`,
    );
  }
} else if (mode === "hd") {
  /* Обратная сторона того же счёта: НЕДОБОР высоты. Схлопнутый баннер в
     списке `h` не виден вовсе, а именно он и съедает страницу. */
  const own = rows.map((r) => {
    const kid = Math.min(0, ...r.node.children.map((c) => byId.get(c)?.dh ?? 0));
    return { r, own: r.dh - kid };
  });
  own.sort((a, b) => a.own - b.own);
  console.log(`высота: свой НЕДОБОР (всего узлов с трассой ${rows.length})`);
  for (const { r, own: o } of own.slice(0, top)) {
    console.log(
      `  ${String(o).padStart(7)}  h ${String(r.sh).padStart(6)}→${String(r.gh).padEnd(7)} ${tag(r.node)}\n            < ${chainOf(r.node, 3)}`,
    );
  }
} else if (mode === "y") {
  const s = [...rows].sort((a, b) => Math.abs(b.dy) - Math.abs(a.dy));
  for (const r of s.slice(0, top)) {
    console.log(`  dy${String(r.dy).padStart(7)} dh${String(r.dh).padStart(6)} ${tag(r.node)}\n        < ${chainOf(r.node, 3)}`);
  }
} else if (mode === "x") {
  const bad = rows.filter((r) => Math.abs(r.dx) > 4 && r.node.text);
  console.log(`по X мимо: ${bad.length} из ${rows.filter((r) => r.node.text).length} текстовых`);
  const groups = new Map<string, Row[]>();
  for (const r of bad) {
    const k = chainOf(r.node, 2);
    const a = groups.get(k);
    if (a) a.push(r);
    else groups.set(k, [r]);
  }
  for (const [k, arr] of [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
    console.log(`\n── ${arr.length} шт · ${k}`);
    for (const r of arr.slice(0, 3)) {
      const src = snap.nodes[r.si];
      console.log(
        `   dx${String(r.dx).padStart(6)} dw${String(r.dw).padStart(6)} src x=${src.r[0]} w=${src.r[2]} · «${(r.node.text ?? "").slice(0, 30).replace(/\n/g, "⏎")}»`,
      );
    }
  }
}

if (mode === "t") {
  /* Расхождение ВЫСОТЫ по типам узлов: где копится лишняя высота. */
  const groups = new Map<string, { n: number; sum: number; over: number; under: number }>();
  for (const r of rows) {
    const k = r.node.type === "text" ? "текст" : r.node.type;
    const g = groups.get(k) ?? { n: 0, sum: 0, over: 0, under: 0 };
    g.n += 1;
    g.sum += Math.abs(r.dh);
    if (r.dh > 2) g.over += r.dh;
    if (r.dh < -2) g.under += r.dh;
    groups.set(k, g);
  }
  for (const [k, g] of [...groups].sort((a, b) => b[1].sum - a[1].sum)) {
    console.log(`${k.padEnd(12)} n=${String(g.n).padStart(5)} |dh|=${String(Math.round(g.sum)).padStart(8)} выше=${String(Math.round(g.over)).padStart(8)} ниже=${String(Math.round(g.under)).padStart(8)}`);
  }
  const t = rows.filter((r) => r.node.type === "text");
  const s = [...t].sort((a, b) => Math.abs(b.dh) - Math.abs(a.dh));
  console.log(`\nхудший текст по высоте:`);
  for (const r of s.slice(0, top)) {
    const src = snap.nodes[r.si];
    console.log(`  dh${String(r.dh).padStart(6)} h ${r.sh}→${r.gh} w ${src.r[2]}→${Math.round(rects.get(r.node.id)!.w)} fs=${r.node.style.fontSize} lh=${r.node.style.lineHeight} «${(r.node.text ?? "").slice(0, 40).replace(/\n/g, "⏎")}»`);
  }
}

if (mode === "cx") {
  /* СОБСТВЕННЫЙ промах по X: dx узла минус dx его родителя. Так видно, где
     именно ошибка ВОЗНИКАЕТ, а не куда она унаследована. */
  const own = rows
    .map((r) => {
      const p = r.node.parent ? byId.get(r.node.parent) : undefined;
      return { r, own: r.dx - (p?.dx ?? 0), parent: p };
    })
    .filter((o) => Math.abs(o.own) > 2);
  const groups = new Map<string, { n: number; sum: number; ex: string[] }>();
  for (const o of own) {
    const pn = o.r.node.parent ? doc.nodes[o.r.node.parent] : null;
    const k = pn ? `${pn.layout.preset ?? pn.layout.direction}${pn.layout.gridTracks ? "+tracks" : ""}${pn.layout.wrap ? "+wrap" : ""} / ${o.r.node.type}${o.r.node.layout.position === "absolute" ? "+abs" : ""}` : "корень";
    const gg = groups.get(k) ?? { n: 0, sum: 0, ex: [] };
    gg.n += 1;
    gg.sum += Math.abs(o.own);
    if (gg.ex.length < 3) gg.ex.push(`own${Math.round(o.own)} dw${o.r.dw} «${(o.r.node.text ?? o.r.node.name).slice(0, 24)}» < ${pn?.name.slice(0, 16)}`);
    groups.set(k, gg);
  }
  console.log(`узлов с собственным промахом по X: ${own.length} из ${rows.length}`);
  for (const [k, gg] of [...groups].sort((a, b) => b[1].sum - a[1].sum).slice(0, top)) {
    console.log(`\n── ${String(gg.n).padStart(4)} шт · сумма ${Math.round(gg.sum)} · ${k}`);
    for (const e of gg.ex) console.log(`     ${e}`);
  }
}

if (mode === "w") {
  /* Промах по ШИРИНЕ: где коробка шире или уже измеренной. */
  const bad = rows.filter((r) => Math.abs(r.dw) > 4);
  console.log(`по ширине мимо: ${bad.length} из ${rows.length}`);
  const groups = new Map<string, Row[]>();
  for (const r of bad) {
    const p = r.node.parent ? doc.nodes[r.node.parent] : null;
    const k = `${p ? (p.layout.preset ?? p.layout.direction) + (p.layout.wrap ? "+wrap" : "") : "корень"} / ${r.node.type} w=${JSON.stringify(r.node.layout.width)}${r.node.layout.maxWidth ? " mw" : ""}`;
    const a = groups.get(k);
    if (a) a.push(r); else groups.set(k, [r]);
  }
  for (const [k, arr] of [...groups].sort((a, b) => b[1].reduce((s, r) => s + Math.abs(r.dw), 0) - a[1].reduce((s, r) => s + Math.abs(r.dw), 0)).slice(0, top)) {
    console.log(`\n── ${arr.length} шт · ${Math.round(arr.reduce((s, r) => s + Math.abs(r.dw), 0))}px · ${k}`);
    for (const r of arr.slice(0, 3)) {
      const src = snap.nodes[r.si];
      console.log(`   dw${String(r.dw).padStart(6)} dx${String(r.dx).padStart(6)} src w=${src.r[2]} · «${(r.node.text ?? r.node.name).slice(0, 30).replace(/\n/g, "⏎")}» < ${doc.nodes[r.node.parent!]?.name.slice(0, 18)}`);
    }
  }
}

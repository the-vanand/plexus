/**
 * ДИАГНОСТИКА НАЛОЖЕНИЙ: какие узлы снимка наезжают и их цепочки предков.
 * Временный инструмент для отладки, не входит в арбитр.
 *
 *   npx tsx tools/harness/overlap-diag.ts fixtures/snapshots/<имя>.json
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

const path = process.argv[2] ?? "fixtures/snapshots/yt-watch.json";
const snap = JSON.parse(readFileSync(path, "utf8")) as PageSnapshot;

const doc = createStarterDocument();
doc.nodes = {};
doc.rootFrames = [];
doc.wires = [];
const out = importSnapshotToDoc(doc, { snapshot: snap, pageName: "проверка", trace: true });
const rects = computeLayout(doc, measureStub);
const frame = doc.nodes[out.frameId]!;

interface Box { id: string; idx: number; y: number; h: number; sy: number; sh: number; x: number; w: number; sx: number; sw: number }
const boxes: Box[] = [];
const parentOf = new Map<string, string | null>();
for (const node of Object.values(doc.nodes)) parentOf.set(node.id, node.parent ?? null);
const isAncestor = (a: string, b: string): boolean => {
  let p = parentOf.get(b) ?? null;
  while (p) { if (p === a) return true; p = parentOf.get(p) ?? null; }
  return false;
};

for (const node of Object.values(doc.nodes)) {
  if (node.type === "frame") continue;
  const r = rects.get(node.id);
  const idx = out.trace?.get(node.id);
  if (!r || idx === undefined) continue;
  const s = snap.nodes[idx];
  if (!s || s.r[2] <= 1 || s.r[3] <= 1) continue;
  boxes.push({
    id: node.id, idx,
    x: r.x - frame.layout.x, y: r.y - frame.layout.y, w: r.w, h: r.h,
    sx: s.r[0], sy: s.r[1], sw: s.r[2], sh: s.r[3],
  });
}

const inter = (a: number, b: number, c: number, d: number) => Math.max(0, Math.min(a + b, c + d) - Math.max(a, c));
const areaOurs = (p: Box, q: Box) => inter(p.x, p.w, q.x, q.w) * inter(p.y, p.h, q.y, q.h);
const areaSrc = (p: Box, q: Box) => inter(p.sx, p.sw, q.sx, q.sw) * inter(p.sy, p.sh, q.sy, q.sh);

const bad: Array<{ a: Box; b: Box; ours: number }> = [];
boxes.sort((p, q) => p.y - q.y);
for (let i = 0; i < boxes.length; i += 1) {
  for (let j = i + 1; j < boxes.length; j += 1) {
    const a = boxes[i], b = boxes[j];
    if (b.y > a.y + a.h) break;
    if (isAncestor(a.id, b.id) || isAncestor(b.id, a.id)) continue;
    const ours = areaOurs(a, b);
    if (ours <= 0) continue;
    const src = areaSrc(a, b);
    const minArea = Math.min(a.w * a.h, b.w * b.h);
    if (ours > minArea * 0.25 && src <= minArea * 0.05) bad.push({ a, b, ours });
  }
}

const KEYS = ["display", "position", "float", "overflow", "flex-wrap", "flex-direction", "grid-template-columns", "white-space"];
const line = (i: number, pad: string) => {
  const n = snap.nodes[i];
  const st = KEYS.map((k) => (n.s[k] ? `${k}=${n.s[k]}` : "")).filter(Boolean).join(" ");
  return `${pad}#${i} ${n.t}${n.c ? "." + n.c.split(" ").slice(0, 2).join(".") : ""} r=[${n.r.join(",")}] ${st} «${(n.x ?? "").slice(0, 25).replace(/\n/g, "⏎")}»`;
};
const chainOf = (i: number): number[] => {
  const chain: number[] = [];
  for (let p = i; p >= 0; p = snap.nodes[p].p) chain.unshift(p);
  return chain;
};

bad.sort((p, q) => q.ours - p.ours);
const seen = new Set<string>();
let shown = 0;
for (const p of bad) {
  const key = `${chainOf(p.a.idx).slice(0, -1).join(",")}|${chainOf(p.b.idx).slice(0, -1).join(",")}`;
  if (seen.has(key)) continue;
  seen.add(key);
  shown += 1;
  if (shown > 6) break;
  console.log(`\n═══ ${Math.round(p.ours)}px²  наш A y=${Math.round(p.a.y)}..${Math.round(p.a.y + p.a.h)}  B y=${Math.round(p.b.y)}..${Math.round(p.b.y + p.b.h)}  снимок A y=${p.a.sy}..${p.a.sy + p.a.sh}  B y=${p.b.sy}..${p.b.sy + p.b.sh}`);
  console.log(`  A цепочка:`);
  chainOf(p.a.idx).forEach((c, d) => console.log(line(c, "  ".repeat(d + 1))));
  console.log(`  B цепочка:`);
  chainOf(p.b.idx).forEach((c, d) => console.log(line(c, "  ".repeat(d + 1))));
}
console.log(`\nвсего наложений: ${bad.length}, уникальных пар родителей: ${seen.size}`);

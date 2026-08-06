/**
 * НАЛОЖЕНИЕ ТЕКСТОВ ДРУГ НА ДРУГА.
 *
 * Метрики dx/dy/dw меряют смещение каждого узла по отдельности и наложения
 * не видят вовсе: два абзаца могут стоять каждый «почти на месте» и при этом
 * лежать друг на друге. Для глаза это самый заметный дефект импорта.
 *
 * Здесь наложение считается ЧЕСТНО: пара засчитывается только если в
 * ПОСЧИТАННОЙ раскладке прямоугольники пересекаются заметной площадью, а в
 * ИЗМЕРЕННОМ снимке — нет. То есть это наша ошибка, а не свойство страницы.
 *
 *   npx tsx tools/harness/overlap.ts fixtures/snapshots/<имя>.json
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
const { measureStub } = await import("./measure-stub");
type PageSnapshot = import("../../src/core/snapshot").PageSnapshot;

const path = process.argv[2] ?? "fixtures/snapshots/cospex-1920.json";
const snap = JSON.parse(readFileSync(path, "utf8")) as PageSnapshot;

const doc = createStarterDocument();
doc.nodes = {};
doc.rootFrames = [];
doc.wires = [];
const out = importSnapshotToDoc(doc, { snapshot: snap, pageName: "проверка", trace: true });
const rects = computeLayout(doc, measureStub);
const frame = doc.nodes[out.frameId]!;

interface Box { id: string; text: string; x: number; y: number; w: number; h: number; sx: number; sy: number; sw: number; sh: number }
const boxes: Box[] = [];
for (const node of Object.values(doc.nodes)) {
  if (!node.text) continue;
  const r = rects.get(node.id);
  const idx = out.trace?.get(node.id);
  if (!r || idx === undefined) continue;
  const s = snap.nodes[idx];
  if (!s || s.r[2] <= 1 || s.r[3] <= 1) continue;
  boxes.push({
    id: node.id,
    text: (node.text ?? "").slice(0, 28).replace(/\n/g, "⏎"),
    x: r.x - frame.layout.x, y: r.y - frame.layout.y, w: r.w, h: r.h,
    sx: s.r[0], sy: s.r[1], sw: s.r[2], sh: s.r[3],
  });
}

/** Площадь пересечения двух прямоугольников. */
const inter = (a: number, b: number, c: number, d: number) => Math.max(0, Math.min(a + b, c + d) - Math.max(a, c));
const areaOurs = (p: Box, q: Box) => inter(p.x, p.w, q.x, q.w) * inter(p.y, p.h, q.y, q.h);
const areaSrc = (p: Box, q: Box) => inter(p.sx, p.sw, q.sx, q.sw) * inter(p.sy, p.sh, q.sy, q.sh);

const bad: Array<{ a: Box; b: Box; ours: number; src: number }> = [];
/* Сравниваем только близких по вертикали: полный квадрат на 4000 узлах
   лишний, а наложение всегда локально. */
boxes.sort((p, q) => p.y - q.y);
for (let i = 0; i < boxes.length; i += 1) {
  for (let j = i + 1; j < boxes.length; j += 1) {
    const a = boxes[i], b = boxes[j];
    if (b.y > a.y + a.h) break;
    const ours = areaOurs(a, b);
    if (ours <= 0) continue;
    const src = areaSrc(a, b);
    const minArea = Math.min(a.w * a.h, b.w * b.h);
    // наложение считаем значимым от четверти меньшего прямоугольника
    if (ours > minArea * 0.25 && src <= minArea * 0.05) bad.push({ a, b, ours, src });
  }
}

console.log(`\n▸ НАЛОЖЕНИЯ — ${basename(path)}`);
console.log(`  текстовых узлов сверено   ${boxes.length}`);
console.log(`  наложений (у нас есть, в оригинале нет)  ${bad.length}`);
if (bad.length) {
  console.log(`\n  ХУДШИЕ:`);
  bad.sort((p, q) => q.ours - p.ours).slice(0, 8).forEach((p) => {
    console.log(`   ${Math.round(p.ours)}px²  «${p.a.text}» × «${p.b.text}»`);
    console.log(`        наш  y=${Math.round(p.a.y)}..${Math.round(p.a.y + p.a.h)} и y=${Math.round(p.b.y)}..${Math.round(p.b.y + p.b.h)}`);
    console.log(`        снимок y=${p.a.sy}..${p.a.sy + p.a.sh} и y=${p.b.sy}..${p.b.sy + p.b.sh}`);
  });
}
console.log(`\nJSON ${JSON.stringify({ texts: boxes.length, overlaps: bad.length })}\n`);

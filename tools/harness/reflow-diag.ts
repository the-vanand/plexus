/**
 * ОТЗЫВЧИВОСТЬ ИМПОРТА: следит ли страница за шириной рамки.
 *
 * Импортируем снимок, считаем раскладку при исходной ширине, затем меняем
 * ширину рамки и считаем снова. Узел «следит», если его ширина изменилась.
 * Отдельно печатаются ТОЧКИ ЗАМОРОЗКИ: узлы, чей родитель за рамкой
 * следит, а они сами — нет (с фиксированной шириной в раскладке).
 *
 *   npx tsx tools/harness/reflow-diag.ts fixtures/snapshots/<имя>.json [новая ширина]
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
g.DOMParser = dom.window.DOMParser; g.Node = dom.window.Node; g.Element = dom.window.Element;
g.document = dom.window.document; g.window = dom.window;
const { importSnapshotToDoc } = await import("../../src/core/importSnapshot");
const { computeLayout } = await import("../../src/core/layout");
const { createStarterDocument } = await import("../../src/core/scene");
const { measureStub } = await import("./measure-stub");
type PageSnapshot = import("../../src/core/snapshot").PageSnapshot;

const path = process.argv[2] ?? "fixtures/snapshots/yt-watch.json";
const newW = Number(process.argv[3] ?? 1000);
const snap = JSON.parse(readFileSync(path, "utf8")) as PageSnapshot;
const doc = createStarterDocument();
doc.nodes = {}; doc.rootFrames = []; doc.wires = [];
const out = importSnapshotToDoc(doc, { snapshot: snap, pageName: "проверка" });
const frame = doc.nodes[out.frameId]!;
const r1 = computeLayout(doc, measureStub);
const origW = frame.layout.width;
frame.layout.width = newW;
const r2 = computeLayout(doc, measureStub);

let total = 0, moved = 0;
const freezePoints = new Map<string, { n: number; ex: string }>();
for (const node of Object.values(doc.nodes)) {
  if (node.type === "frame" || !node.parent) continue;
  const a = r1.get(node.id), b = r2.get(node.id);
  if (!a || !b) continue;
  total += 1;
  const reacted = Math.abs(a.w - b.w) > 1 || Math.abs(a.x - b.x) > 1;
  if (reacted) { moved += 1; continue; }
  const p = doc.nodes[node.parent];
  const pa = p ? r1.get(p.id) : undefined;
  const pb = p ? r2.get(p.id) : undefined;
  const parentReacted = p?.type === "frame" || (pa && pb && (Math.abs(pa.w - pb.w) > 1 || Math.abs(pa.x - pb.x) > 1));
  if (parentReacted) {
    const key = `${node.type} w=${typeof node.layout.width === "number" ? "px" : node.layout.width} pos=${node.layout.position}`;
    const cur = freezePoints.get(key) ?? { n: 0, ex: "" };
    cur.n += 1;
    if (!cur.ex) cur.ex = `${node.name ?? node.id} [${Math.round(a.w)}px]`;
    freezePoints.set(key, cur);
  }
}
console.log(`▸ ОТЗЫВЧИВОСТЬ — ${basename(path)}: ширина ${String(origW)} -> ${newW}`);
console.log(`  узлов              ${total}`);
console.log(`  следят за рамкой   ${moved} (${Math.round((moved / Math.max(1, total)) * 100)}%)`);
console.log(`  ТОЧКИ ЗАМОРОЗКИ (родитель следит, узел нет):`);
[...freezePoints.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10).forEach(([k, v]) => {
  console.log(`   ${String(v.n).padStart(4)}  ${k}  напр. ${v.ex}`);
});
console.log(`JSON ${JSON.stringify({ total, moved, pct: Math.round((moved / Math.max(1, total)) * 100) })}`);

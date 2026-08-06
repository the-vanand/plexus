/**
 * МУСОР В СЦЕНЕ: пустые контейнеры, безликие обёртки с одним ребёнком,
 * глубина дерева. Мера того, насколько удобно РЕДАКТИРОВАТЬ импорт.
 *
 *   npx tsx tools/harness/junk-diag.ts fixtures/snapshots/<имя>.json
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
type SceneNode = import("../../src/core/types").SceneNode;

const path = process.argv[2] ?? "fixtures/snapshots/yt-watch.json";
const snap = JSON.parse(readFileSync(path, "utf8")) as PageSnapshot;
const doc = createStarterDocument();
doc.nodes = {}; doc.rootFrames = []; doc.wires = [];
const out = importSnapshotToDoc(doc, { snapshot: snap, pageName: "проверка", trace: true });
const rects = computeLayout(doc, measureStub);

const hasVisual = (n: SceneNode): boolean => {
  if (n.type === "text" || n.type === "image") return true;
  const s = n.style ?? {};
  if (s.fill && s.fill !== "transparent") return true;
  if (s.strokeWidth && s.strokeWidth > 0) return true;
  if (s.radius) return true;
  if ((s as Record<string, unknown>)["shadow"]) return true;
  return false;
};

let total = 0, emptyLeaf = 0, blandWrap = 0, maxDepth = 0;
const depths: number[] = [];
const walk = (id: string, d: number): void => {
  const n = doc.nodes[id];
  if (!n) return;
  total += 1;
  maxDepth = Math.max(maxDepth, d);
  depths.push(d);
  const kids = n.children ?? [];
  if (n.type !== "frame") {
    if (kids.length === 0 && !hasVisual(n)) emptyLeaf += 1;
    if (kids.length === 1 && !hasVisual(n)) {
      const c = doc.nodes[kids[0]];
      const r = rects.get(id), cr = rects.get(kids[0]);
      if (c && r && cr && Math.abs(r.x - cr.x) <= 2 && Math.abs(r.y - cr.y) <= 2 &&
          Math.abs(r.w - cr.w) <= 2 && Math.abs(r.h - cr.h) <= 2) blandWrap += 1;
    }
  }
  for (const k of kids) walk(k, d + 1);
};
walk(out.frameId, 0);
depths.sort((a, b) => a - b);
console.log(`▸ МУСОР — ${basename(path)}`);
console.log(`  узлов в сцене        ${total}`);
console.log(`  пустых листьев       ${emptyLeaf} (без текста, картинки, фона, рамки)`);
console.log(`  безликих обёрток     ${blandWrap} (один ребёнок той же геометрии, без своего вида)`);
console.log(`  глубина: медиана ${depths[Math.floor(depths.length / 2)]}, максимум ${maxDepth}`);
console.log(`JSON ${JSON.stringify({ total, emptyLeaf, blandWrap, medDepth: depths[Math.floor(depths.length / 2)], maxDepth })}`);

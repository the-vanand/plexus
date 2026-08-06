/**
 * ВЕРХНИЕ УРОВНИ СЦЕНЫ: режимы ширины/высоты у корня — кто заморожен.
 *   npx tsx tools/harness/tree-top.ts fixtures/snapshots/<имя>.json [глубина]
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
g.DOMParser = dom.window.DOMParser; g.Node = dom.window.Node; g.Element = dom.window.Element;
g.document = dom.window.document; g.window = dom.window;
const { importSnapshotToDoc } = await import("../../src/core/importSnapshot");
const { createStarterDocument } = await import("../../src/core/scene");
type PageSnapshot = import("../../src/core/snapshot").PageSnapshot;

const snap = JSON.parse(readFileSync(process.argv[2], "utf8")) as PageSnapshot;
const maxD = Number(process.argv[3] ?? 4);
const doc = createStarterDocument();
doc.nodes = {}; doc.rootFrames = []; doc.wires = [];
const out = importSnapshotToDoc(doc, { snapshot: snap, pageName: "x" });
const walk = (id: string, d: number): void => {
  if (d > maxD) return;
  const n = doc.nodes[id];
  if (!n) return;
  console.log(
    "  ".repeat(d) + (n.name || n.type),
    "w=" + JSON.stringify(n.layout.width),
    "h=" + JSON.stringify(n.layout.height),
    "pos=" + n.layout.position,
    "dir=" + n.layout.direction,
    n.layout.maxWidth !== undefined ? "maxW=" + n.layout.maxWidth : "",
  );
  (n.children ?? []).slice(0, 8).forEach((c) => walk(c, d + 1));
};
walk(out.frameId, 0);

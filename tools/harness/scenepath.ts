/**
 * ГДЕ ОКАЗАЛСЯ УЗЕЛ В НАШЕЙ РАСКЛАДКЕ.
 *
 * Печатает цепочку предков узла сцены с посчитанными и измеренными
 * координатами — видно, на каком уровне разошлось.
 *
 *   npx tsx tools/harness/scenepath.ts <снимок> "<кусок текста>"
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

const snap = JSON.parse(readFileSync(process.argv[2], "utf8")) as PageSnapshot;
const needle = process.argv[3] ?? "";

const doc = createStarterDocument();
doc.nodes = {};
doc.rootFrames = [];
doc.wires = [];
const out = importSnapshotToDoc(doc, { snapshot: snap, pageName: "проба", trace: true });
const rects = computeLayout(doc, measureStub);
const parentOf = new Map<string, string>();
for (const n of Object.values(doc.nodes) as SceneNode[]) for (const c of n.children) parentOf.set(c, n.id);

let shown = 0;
for (const n of Object.values(doc.nodes) as SceneNode[]) {
  if (shown >= 2) break;
  if (!(n.text ?? "").includes(needle)) continue;
  shown += 1;
  const chain: string[] = [];
  for (let id: string | undefined = n.id; id; id = parentOf.get(id)) chain.unshift(id);
  console.log("");
  chain.forEach((id, d) => {
    const k = doc.nodes[id]!;
    const r = rects.get(id)!;
    const si = out.trace?.get(id);
    const s = si === undefined ? null : snap.nodes[si];
    console.log(
      `${"  ".repeat(d)}${k.type}/${k.name} pos=${k.layout.position} dir=${k.layout.direction} preset=${k.layout.preset} w=${JSON.stringify(k.layout.width)} h=${JSON.stringify(k.layout.height)} maxH=${k.layout.maxHeight} наш=[${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}] снимок=${s ? `[${s.r.join(",")}]` : "—"}`,
    );
  });
}

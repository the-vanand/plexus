/**
 * СРАВНЕНИЕ ЦЕПОЧКИ: наш rect против измеренного для узла снимка и предков.
 *   npx tsx tools/harness/chain-diag.ts fixtures/snapshots/<имя>.json <индекс>
 */
import { readFileSync } from "node:fs";
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

const snap = JSON.parse(readFileSync(process.argv[2], "utf8")) as PageSnapshot;
const target = Number(process.argv[3]);

const doc = createStarterDocument();
doc.nodes = {}; doc.rootFrames = []; doc.wires = [];
const out = importSnapshotToDoc(doc, { snapshot: snap, pageName: "проверка", trace: true });
const rects = computeLayout(doc, measureStub);
const frame = doc.nodes[out.frameId]!;

// обратная карта: индекс снимка -> id сцены
const byIdx = new Map<number, string>();
for (const [id, idx] of out.trace ?? []) if (!byIdx.has(idx)) byIdx.set(idx, id);

const chain: number[] = [];
for (let p = target; p >= 0; p = snap.nodes[p].p) chain.unshift(p);
for (const i of chain) {
  const n = snap.nodes[i];
  const id = byIdx.get(i);
  const node = id ? doc.nodes[id] : undefined;
  const r = id ? rects.get(id) : undefined;
  const ours = r ? `наш=[${Math.round(r.x - frame.layout.x)},${Math.round(r.y - frame.layout.y)},${Math.round(r.w)},${Math.round(r.h)}]` : "наш=<нет в сцене>";
  const lay = node ? ` pos=${node.layout.position ?? "flow"} dir=${node.layout.direction ?? "-"} x=${node.layout.x ?? "-"} y=${node.layout.y ?? "-"} h=${node.layout.height ?? "-"}` : "";
  console.log(`#${i} ${n.t} снимок=[${n.r.join(",")}] ${ours}${lay}`);
}

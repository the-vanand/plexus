/**
 * ЧТО ИМЕННО ПОТЕРЯЛОСЬ ИЗ ТЕКСТА.
 *
 * Доля «текст%» в сводке говорит сколько, но не что: без разбивки по тегу и
 * причине непонятно, косметическая это потеря (служебная подпись, дубль
 * заголовка) или пропал абзац статьи. К5 шкалы различает именно это.
 *
 *   npx tsx tools/harness/lost.ts w-mdngrid
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
type SceneNode = import("../../src/core/types").SceneNode;

for (const name of process.argv.slice(2)) {
  const snap = JSON.parse(readFileSync(`fixtures/snapshots/${name}.json`, "utf8")) as PageSnapshot;
  const doc = createStarterDocument(); doc.nodes = {}; doc.rootFrames = []; doc.wires = [];
  importSnapshotToDoc(doc, { snapshot: snap, pageName: name });
  const nodes = Object.values(doc.nodes) as SceneNode[];
  const hay = " " + nodes.map((n) => (n.text ?? "").replace(/\s+/g, " ").trim()).join(" ") + " ";
  const byTag = new Map<string, { n: number; ex: string[] }>();
  let total = 0, lost = 0;
  for (const sn of snap.nodes) {
    const t = (sn.x ?? "").replace(/\s+/g, " ").trim();
    if (t.length < 2) continue;
    total += 1;
    if (hay.includes(t)) continue;
    lost += 1;
    const key = `${sn.t} ${sn.r[2]}x${sn.r[3]} ${(sn.s["display"] ?? "").trim()}`;
    const e = byTag.get(key) ?? { n: 0, ex: [] };
    e.n += 1;
    if (e.ex.length < 2) e.ex.push(t.slice(0, 44));
    byTag.set(key, e);
  }
  console.log(`${name}: текстовых узлов ${total}, потеряно ${lost} (${Math.round((lost / Math.max(1, total)) * 100)}%)`);
  for (const [k, v] of [...byTag].sort((a, b) => b[1].n - a[1].n).slice(0, 12)) {
    console.log(`   ${String(v.n).padStart(4)}  ${k.padEnd(28)} ${v.ex.map((s) => `«${s}»`).join(" ")}`);
  }
}

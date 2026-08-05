/**
 * ГДЕ ВОЗНИКАЕТ ПРОМАХ ПО X — СРАЗУ ПО ВСЕМ СНИМКАМ.
 *
 * `diag.ts cx` отвечает на этот вопрос по одному снимку, но правку судят по
 * медиане, а медиана считается по разным сайтам. Здесь те же собственные
 * промахи (dx узла минус dx родителя) складываются по всем фикстурам и
 * группируются по ПРИЧИНЕ: раскладка родителя и вид ребёнка. Так видно, что
 * чинить первым, а не какой сайт громче кричит.
 */
import { readFileSync, readdirSync } from "node:fs";
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

const DIR = "fixtures/snapshots";
const filter = process.argv.slice(2);
const names = readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5))
  .filter((n) => filter.length === 0 || filter.some((f) => n.includes(f))).sort();

const groups = new Map<string, { n: number; sum: number; ex: string[] }>();
let total = 0;
let counted = 0;
for (const name of names) {
  const snap = JSON.parse(readFileSync(`${DIR}/${name}.json`, "utf8")) as PageSnapshot;
  const doc = createStarterDocument(); doc.nodes = {}; doc.rootFrames = []; doc.wires = [];
  const out = importSnapshotToDoc(doc, { snapshot: snap, pageName: name, trace: true });
  const rects = computeLayout(doc, measureStub);
  const fx = doc.nodes[out.frameId]!.layout.x;
  const trace = out.trace!;
  const dxOf = new Map<string, number>();
  for (const n of Object.values(doc.nodes) as SceneNode[]) {
    const si = trace.get(n.id); if (si === undefined) continue;
    const r = rects.get(n.id); if (!r) continue;
    dxOf.set(n.id, Math.round(r.x - fx - snap.nodes[si].r[0]));
  }
  /* Для КАЖДОГО текстового узла, промахнувшегося мимо допуска прибора,
     ищем предка, В КОТОРОМ ошибка возникла: первый по пути вверх, чей
     собственный промах сравним с итоговым. Группировка по нему отвечает на
     вопрос «какое правило раскладки виновато», а не «где видно последствие». */
  for (const n of Object.values(doc.nodes) as SceneNode[]) {
    const d = dxOf.get(n.id);
    if (d === undefined || !n.text) continue;
    counted += 1;
    if (Math.abs(d) <= 4) continue;
    total += Math.abs(d);
    let cur: SceneNode = n;
    let blame: SceneNode = n;
    let best = 0;
    while (cur) {
      const cd = dxOf.get(cur.id) ?? 0;
      const pd = cur.parent ? dxOf.get(cur.parent) ?? 0 : 0;
      const own = Math.abs(cd - pd);
      if (own > best) { best = own; blame = cur; }
      if (!cur.parent) break;
      cur = doc.nodes[cur.parent]!;
    }
    const p = blame.parent ? doc.nodes[blame.parent] : null;
    const pl = p?.layout;
    const key = p
      ? `${pl!.preset ?? pl!.direction}${pl!.gridTracks ? "+tracks" : ""}${pl!.wrap ? "+wrap" : ""}` +
        ` / ${blame.type}${blame.layout.position === "absolute" ? "+abs" : ""}${blame.layout.centered ? "+centered" : ""}`
      : "корень";
    const gg = groups.get(key) ?? { n: 0, sum: 0, ex: [] };
    gg.n += 1; gg.sum += Math.abs(d);
    if (gg.ex.length < 4) gg.ex.push(`${name} dx${d} вина ${blame.name.slice(0, 18)} (${Math.round(best)}) «${(n.text ?? "").slice(0, 22).replace(/\n/g, "⏎")}» < ${p?.name.slice(0, 16)}`);
    groups.set(key, gg);
  }
}
console.log(`узлов с трассой ${counted}, суммарный собственный промах ${Math.round(total)}px\n`);
for (const [k, gg] of [...groups].sort((a, b) => b[1].sum - a[1].sum).slice(0, 14)) {
  console.log(`── ${String(gg.n).padStart(5)} шт · ${String(Math.round(gg.sum)).padStart(7)}px (${Math.round((gg.sum / total) * 100)}%) · ${k}`);
  for (const e of gg.ex) console.log(`      ${e}`);
}

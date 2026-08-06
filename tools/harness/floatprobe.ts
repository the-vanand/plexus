/**
 * РАЗБОР ОДНОГО СНИМКА ВОКРУГ ПЛАВАЮЩИХ БЛОКОВ.
 *
 * Стенд для поиска причины: печатает плавающие блоки, их родителей и тех
 * соседей в потоке, чья измеренная коробка пересекается с плавающей по
 * вертикали. Нужен, чтобы решать по данным, а не по догадке.
 *
 *   npx tsx tools/harness/floatprobe.ts fixtures/snapshots/wiki-airbnb.json
 */
import { readFileSync } from "node:fs";
type PageSnapshot = import("../../src/core/snapshot").PageSnapshot;

const path = process.argv[2] ?? "fixtures/snapshots/wiki-airbnb.json";
const snap = JSON.parse(readFileSync(path, "utf8")) as PageSnapshot;

const kids = new Map<number, number[]>();
snap.nodes.forEach((n, i) => {
  const a = kids.get(n.p) ?? [];
  a.push(i);
  kids.set(n.p, a);
});

const desc = (i: number) => {
  const n = snap.nodes[i];
  return `#${i} ${n.t}${n.c ? "." + n.c.split(" ")[0] : ""} r=[${n.r.join(",")}] fl=${n.s["float"] ?? "-"} pos=${n.s["position"] ?? "-"} «${(n.x ?? "").slice(0, 24).replace(/\n/g, "⏎")}»`;
};

snap.nodes.forEach((n, i) => {
  const fl = (n.s["float"] ?? "none").trim();
  if (fl !== "left" && fl !== "right") return;
  if (n.r[2] <= 1 || n.r[3] <= 1) return;
  console.log(`\nFLOAT ${desc(i)}`);
  console.log(`  родитель ${n.p >= 0 ? desc(n.p) : "(корень)"}`);
  const sibs = (kids.get(n.p) ?? []).filter((c) => c !== i);
  for (const c of sibs) {
    const s = snap.nodes[c];
    if (s.r[2] <= 1 || s.r[3] <= 1) continue;
    const vy = Math.min(n.r[1] + n.r[3], s.r[1] + s.r[3]) - Math.max(n.r[1], s.r[1]);
    const hx = Math.min(n.r[0] + n.r[2], s.r[0] + s.r[2]) - Math.max(n.r[0], s.r[0]);
    console.log(`   сосед ${desc(c)}  vy=${Math.round(vy)} hx=${Math.round(hx)}`);
  }
});

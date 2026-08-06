/**
 * ПОИСК УЗЛА СНИМКА ПО ТЕКСТУ И РАСПЕЧАТКА ЕГО ЦЕПОЧКИ ПРЕДКОВ.
 *
 *   npx tsx tools/harness/nodeinfo.ts <снимок> "<кусок текста>"
 */
import { readFileSync } from "node:fs";
type PageSnapshot = import("../../src/core/snapshot").PageSnapshot;

const snap = JSON.parse(readFileSync(process.argv[2], "utf8")) as PageSnapshot;
const needle = process.argv[3] ?? "";
const KEYS = ["display", "position", "float", "column-count", "columns", "overflow", "flex-wrap", "grid-template-columns"];

const line = (i: number, pad: string) => {
  const n = snap.nodes[i];
  const st = KEYS.map((k) => (n.s[k] ? `${k}=${n.s[k]}` : "")).filter(Boolean).join(" ");
  return `${pad}#${i} ${n.t}${n.c ? "." + n.c.split(" ").slice(0, 2).join(".") : ""} r=[${n.r.join(",")}] ${st} «${(n.x ?? "").slice(0, 30).replace(/\n/g, "⏎")}»`;
};

let shown = 0;
snap.nodes.forEach((n, i) => {
  if (shown >= 3) return;
  if (!(n.x ?? "").includes(needle)) return;
  shown += 1;
  const chain: number[] = [];
  for (let p = i; p >= 0; p = snap.nodes[p].p) chain.unshift(p);
  console.log("");
  chain.forEach((c, d) => console.log(line(c, "  ".repeat(d))));
});

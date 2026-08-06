/**
 * ДЕТИ УЗЛА СНИМКА С ИХ КОРОБКАМИ И КЛЮЧЕВЫМИ СТИЛЯМИ.
 *
 *   npx tsx tools/harness/kidsof.ts <снимок> <индекс>
 */
import { readFileSync } from "node:fs";
type PageSnapshot = import("../../src/core/snapshot").PageSnapshot;

const snap = JSON.parse(readFileSync(process.argv[2], "utf8")) as PageSnapshot;
const idx = Number(process.argv[3]);
const n = snap.nodes[idx];
console.log(`#${idx} ${n.t}.${n.c} r=[${n.r.join(",")}]`);
console.log(JSON.stringify(n.s));
snap.nodes.forEach((c, i) => {
  if (c.p !== idx) return;
  console.log(`  #${i} ${c.t}${c.c ? "." + c.c.split(" ")[0] : ""} r=[${c.r.join(",")}] disp=${c.s["display"]} pos=${c.s["position"]} ovf=${c.s["overflow"]} «${(c.x ?? "").slice(0, 30)}»`);
});

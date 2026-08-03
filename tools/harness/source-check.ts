/**
 * ПРОВЕРКА ДИАГНОСТИКИ ИСТОЧНИКА на реальных страницах.
 *
 *   npx tsx tools/harness/source-check.ts /tmp/music.yandex.ru.html …
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
g.DOMParser = dom.window.DOMParser;
g.Node = dom.window.Node;
g.Element = dom.window.Element;
g.document = dom.window.document;
g.window = dom.window;

const { analyzeSource, formatSourceReport } = await import("../../src/core/css/source");
const { importHtmlToDoc } = await import("../../src/core/importer");
const { createStarterDocument } = await import("../../src/core/scene");

for (const path of process.argv.slice(2)) {
  const html = readFileSync(path, "utf8");
  const r = analyzeSource(html);

  console.log(`\n${"═".repeat(72)}`);
  console.log(`  ${basename(path)}`);
  console.log("═".repeat(72));
  console.log(`  ${formatSourceReport(r)}`);
  console.log(`  вердикт: ${r.kind}`);
  console.log(`  → ${r.advice}`);
  for (const m of r.markers) console.log(`    признак: ${m}`);
  for (const st of r.embeddedState) console.log(`    данные: ${st.name} — ${st.kilobytes} КБ JSON`);

  const doc = createStarterDocument();
  doc.nodes = {};
  doc.rootFrames = [];
  doc.wires = [];
  const out = importHtmlToDoc(doc, { html, css: "", pageName: "Проба", viewportWidth: 1440 } as never);
  const byType = new Map<string, number>();
  for (const n of Object.values(doc.nodes)) byType.set(n.type, (byType.get(n.type) ?? 0) + 1);
  console.log(`\n  импортировано узлов: ${out.nodesAdded} → ${[...byType].map(([t, c]) => `${t}:${c}`).join(" ")}`);
  if (out.widgets.length) console.log(`  виджеты: ${out.widgets.join("; ")}`);
}
console.log("");

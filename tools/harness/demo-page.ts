/**
 * ДЕМО: собирает лендинг из блоков каталога и выгружает готовый сайт.
 * Проверка того, что каталог даёт не набор рамок, а работающую страницу.
 *
 *   npx tsx tools/harness/demo-page.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
g.DOMParser = dom.window.DOMParser;
g.Node = dom.window.Node;
g.Element = dom.window.Element;
g.document = dom.window.document;
g.window = dom.window;

const { BLOCK_BY_TYPE } = await import("../../src/core/blocks");
type BlockType = import("../../src/core/blocks").BlockType;
const { createStarterDocument, materialize } = await import("../../src/core/scene");
const { generateProject } = await import("../../src/core/codegen");
const { computeLayout } = await import("../../src/core/layout");
const { measureStub } = await import("./measure-stub");

const PAGE: BlockType[] = [
  "header", "hero", "features", "stats", "cards", "gallery",
  "pricing", "steps", "testimonials", "faq", "team", "logos",
  "cta", "form", "contacts", "footer",
];

const doc = createStarterDocument();
const frameId = doc.rootFrames[0]!;
doc.nodes[frameId]!.children = [];
doc.nodes[frameId]!.layout.width = 1440;
doc.nodes[frameId]!.layout.height = "hug";
doc.nodes[frameId]!.name = "Каталог блоков";
for (const id of Object.keys(doc.nodes)) if (id !== frameId) delete doc.nodes[id];

for (const type of PAGE) {
  const def = BLOCK_BY_TYPE.get(type);
  if (!def) continue;
  materialize(doc, def.build(), frameId);
}

const rects = computeLayout(doc, measureStub);
const frameRect = rects.get(frameId)!;
console.log(`\n  Собрано блоков: ${PAGE.length}`);
console.log(`  Узлов в документе: ${Object.keys(doc.nodes).length}`);
console.log(`  Страница: ${Math.round(frameRect.w)}×${Math.round(frameRect.h)}px по расчёту решателя`);

const project = generateProject(doc, "Каталог блоков Plexus");
const outDir = resolve("out/demo");
mkdirSync(outDir, { recursive: true });

const entries = Object.entries(project.files);
const cssEntry = entries.find(([p]) => p.endsWith(".css"));
let html = entries.find(([p]) => /\.html?$/.test(p))?.[1] ?? "";
if (cssEntry) {
  html = html.replace(/<link[^>]+href="[^"]*\.css"[^>]*>/, `<style>\n${cssEntry[1]}\n</style>`);
}
// картинок в демо нет — подставляем нейтральные заглушки, чтобы видеть раскладку
html = html.replace(/src="https:\/\/placehold\.co\/600x400"/g, 'src="https://placehold.co/1200x800/2c333a/9aa4ae?text=+"');
writeFileSync(resolve(outDir, "index.html"), html, "utf8");

const css = cssEntry?.[1] ?? "";
const count = (re: RegExp) => (css.match(re) ?? []).length;
console.log(`\n  В выводе: grid ${count(/display:\s*grid/g)} · auto-fit ${count(/auto-fit/g)} · ` +
  `columns ${count(/^\s*columns:/gm)} · flex-wrap ${count(/flex-wrap/g)} · max-width ${count(/max-width/g)}`);
console.log(`  Файл: out/demo/index.html (${(html.length / 1024).toFixed(0)} КБ)\n`);

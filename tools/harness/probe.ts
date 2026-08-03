/**
 * ТОЧЕЧНАЯ СВЕРКА: печатает узлы по имени/тексту с полным стилем и рамкой.
 * Нужна, чтобы сверять конкретные значения с оригиналом, а не «на глаз».
 *
 *   npx tsx tools/harness/probe.ts hero-shade "Where Football"
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
g.DOMParser = dom.window.DOMParser;
g.Node = dom.window.Node;
g.Element = dom.window.Element;
g.document = dom.window.document;
g.window = dom.window;

const { importHtmlToDoc } = await import("../../src/core/importer");
const { computeLayout } = await import("../../src/core/layout");
const { createStarterDocument } = await import("../../src/core/scene");
const { measureStub } = await import("./measure-stub");
type SceneNode = import("../../src/core/types").SceneNode;

const htmlPath = resolve("fixtures/cospex-site/index.html");
const dir = dirname(htmlPath);
const html = readFileSync(htmlPath, "utf8");
let css = "";
for (const m of html.matchAll(/<link[^>]+href=["']([^"']+\.css)["'][^>]*>/g)) {
  const p = resolve(dir, m[1].replace(/^\.?\//, ""));
  if (existsSync(p)) css += `\n${readFileSync(p, "utf8")}`;
}

const doc = createStarterDocument();
doc.nodes = {};
doc.rootFrames = [];
doc.wires = [];
importHtmlToDoc(doc, { html, css, pageName: "COSPEX", sourceDir: dir, viewportWidth: 1440 } as never);
const rects = computeLayout(doc, measureStub);

const needles = process.argv.slice(2);
const nodes = Object.values(doc.nodes) as SceneNode[];

for (const needle of needles) {
  const hits = nodes.filter(
    (n) => n.name.toLowerCase().includes(needle.toLowerCase()) || (n.text ?? "").toLowerCase().includes(needle.toLowerCase()),
  );
  console.log(`\n━━━ «${needle}» → ${hits.length} узл(ов)`);
  for (const n of hits.slice(0, 4)) {
    const r = rects.get(n.id);
    const L = n.layout as Record<string, unknown>;
    const S = n.style as Record<string, unknown>;
    const clean = (o: Record<string, unknown>, skip: string[]) =>
      Object.fromEntries(
        Object.entries(o).filter(([k, v]) => v !== undefined && v !== null && !skip.includes(k) && v !== 0 && v !== false),
      );
    console.log(`  ${n.type} «${n.name}» ${r ? `${Math.round(r.w)}×${Math.round(r.h)} @ ${Math.round(r.x)},${Math.round(r.y)}` : ""}`);
    if (n.text) console.log(`    text: ${JSON.stringify(n.text.slice(0, 72))}`);
    console.log(`    layout: ${JSON.stringify(clean(L, ["rotation", "position", "x", "y"]))}`);
    console.log(`    style:  ${JSON.stringify(clean(S, []))}`);
  }
}
console.log("");

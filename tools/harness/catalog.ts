/**
 * СТЕНД КАТАЛОГА: вставляет каждый блок реестра, гоняет через решатель
 * и кодоген и проверяет результат числами.
 *
 * Смысл: каталог из 28 блоков нельзя проверить глазами — нужен прогон,
 * который поймает схлопнутые секции, переполнения и потерянную разметку.
 *
 *   npx tsx tools/harness/catalog.ts
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
g.DOMParser = dom.window.DOMParser;
g.Node = dom.window.Node;
g.Element = dom.window.Element;
g.document = dom.window.document;
g.window = dom.window;

const { BLOCKS, ELEMENTS } = await import("../../src/core/blocks");
const { createStarterDocument, materialize, padBox } = await import("../../src/core/scene");
const { computeLayout } = await import("../../src/core/layout");
const { generateProject } = await import("../../src/core/codegen");
const { validateNode, inferLayoutPreset } = await import("../../src/core/layoutPresets");
const { measureStub } = await import("./measure-stub");
type SceneNode = import("../../src/core/types").SceneNode;

const PAGE_W = 1200;
let failures = 0;

console.log(`\n${"═".repeat(76)}`);
console.log(`  КАТАЛОГ: ${BLOCKS.length} блоков, ${ELEMENTS.length} элементов @ страница ${PAGE_W}px`);
console.log("═".repeat(76));
console.log(
  `\n  ${"блок".padEnd(20)}${"узлов".padStart(6)}${"размер".padStart(13)}${"переполн.".padStart(11)}` +
    `${"раскладка".padStart(12)}  замечания`,
);
console.log("  " + "─".repeat(72));

for (const def of BLOCKS) {
  const doc = createStarterDocument();
  // чистая страница нужной ширины
  const frameId = doc.rootFrames[0]!;
  doc.nodes[frameId]!.children = [];
  doc.nodes[frameId]!.layout.width = PAGE_W;
  doc.nodes[frameId]!.layout.height = "hug";
  for (const id of Object.keys(doc.nodes)) if (id !== frameId) delete doc.nodes[id];

  const rootId = materialize(doc, def.build(), frameId);
  const rects = computeLayout(doc, measureStub);
  const nodes = Object.values(doc.nodes) as SceneNode[];
  const r = rects.get(rootId)!;

  /* переполнения относительно родителя */
  let over = 0;
  let worst = 0;
  for (const n of nodes) {
    if (!n.parent) continue;
    const cr = rects.get(n.id);
    const pr = rects.get(n.parent);
    if (!cr || !pr) continue;
    const pad = padBox(doc.nodes[n.parent]!.layout.padding);
    const right = cr.x + cr.w - (pr.x + pr.w - pad.r);
    const bottom = cr.y + cr.h - (pr.y + pr.h);
    const left = pr.x + pad.l - cr.x;
    const m = Math.max(right, bottom, left);
    if (m > 1) {
      over += 1;
      worst = Math.max(worst, Math.round(m));
    }
  }

  /* валидация по правилам каталога */
  const issues: string[] = [];
  const walk = (id: string, depth: number): void => {
    const n = doc.nodes[id];
    if (!n) return;
    for (const i of validateNode(n, depth)) if (i.level === "err") issues.push(i.message);
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(rootId, 0);

  /* кодоген не должен падать и должен дать непустую разметку */
  let html = "";
  let css = "";
  try {
    const project = generateProject(doc, "Каталог");
    const entries = Object.entries(project.files);
    html = entries.find(([p]) => /\.html?$/.test(p))?.[1] ?? "";
    css = entries.find(([p]) => p.endsWith(".css"))?.[1] ?? "";
  } catch (e) {
    issues.push(`кодоген упал: ${String(e).slice(0, 60)}`);
  }

  const bad: string[] = [];
  // разделитель и распорка по определению плоские — для них порог не применяем
  const flat = def.type === "divider" || def.type === "spacer";
  if (!flat && r.h < 20) bad.push("секция схлопнулась");
  if (r.w < PAGE_W * 0.5) bad.push("секция слишком узкая");
  if (over > 0) bad.push(`выход за рамку ${worst}px`);
  if (!html.includes("data-plx-id")) bad.push("нет якорей в разметке");
  if (css.length < 200) bad.push("пустой CSS");
  bad.push(...issues);
  if (bad.length > 0) failures += 1;

  const preset = inferLayoutPreset(doc.nodes[rootId]!.layout);
  const mark = bad.length === 0 ? "✓" : "✗";
  console.log(
    `${mark} ${def.label.padEnd(20)}${String(nodes.length - 1).padStart(6)}` +
      `${`${Math.round(r.w)}×${Math.round(r.h)}`.padStart(13)}${String(over).padStart(11)}` +
      `${preset.padStart(12)}  ${bad.join("; ")}`,
  );
}

/* ---------- элементы по отдельности ---------- */
console.log("\n  ЭЛЕМЕНТЫ");
console.log("  " + "─".repeat(72));
const elemDoc = createStarterDocument();
const elemFrame = elemDoc.rootFrames[0]!;
elemDoc.nodes[elemFrame]!.children = [];
elemDoc.nodes[elemFrame]!.layout.width = PAGE_W;
for (const id of Object.keys(elemDoc.nodes)) if (id !== elemFrame) delete elemDoc.nodes[id];

const elemIds: Array<[string, string]> = [];
for (const el of ELEMENTS) {
  const spec = el.build ? el.build() : { type: el.kind, name: el.label };
  elemIds.push([el.label, materialize(elemDoc, spec, elemFrame)]);
}
const elemRects = computeLayout(elemDoc, measureStub);
let elemBad = 0;
const zero = elemIds.filter(([, id]) => {
  const rr = elemRects.get(id);
  return !rr || rr.h < 1 || rr.w < 1;
});
for (const [label] of zero) {
  console.log(`  ✗ ${label}: нулевой размер`);
  elemBad += 1;
}
console.log(`  ${zero.length === 0 ? "✓" : "·"} ${ELEMENTS.length - elemBad} из ${ELEMENTS.length} элементов дали ненулевой размер`);

try {
  const project = generateProject(elemDoc, "Элементы");
  const html = Object.entries(project.files).find(([p]) => /\.html?$/.test(p))?.[1] ?? "";
  const tags = ["<hr", "<ul", "<ol", "<blockquote", "<iframe", "<input", "<img", "<button"];
  const found = tags.filter((t) => html.includes(t));
  console.log(`  ✓ семантические теги в выводе: ${found.join(" ")}`);
} catch (e) {
  console.log(`  ✗ кодоген элементов упал: ${String(e).slice(0, 80)}`);
  elemBad += 1;
}

console.log(
  `\n  ИТОГ: блоков с замечаниями ${failures} из ${BLOCKS.length}; элементов с ошибками ${elemBad}\n`,
);
process.exit(failures + elemBad > 0 ? 1 : 0);

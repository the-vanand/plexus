/**
 * СТЕНД ШАБЛОНОВ СТРАНИЦ: разворачивает каждый шаблон в документ,
 * гоняет через решатель и кодоген, проверяет результат числами.
 *
 * Проверки для каждого шаблона:
 *  - Все узлы имеют ненулевой размер (> 1 × 1 px).
 *  - Ни один узел не выходит за правую границу фрейма по горизонтали.
 *  - Высота страницы правдоподобна (> 1000 px для полного шаблона).
 *  - Кодоген не падает и выдаёт непустой HTML с семантическими тегами.
 *  - CSS достаточного размера.
 *
 *   npx tsx tools/harness/templates.ts
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
g.DOMParser = dom.window.DOMParser;
g.Node = dom.window.Node;
g.Element = dom.window.Element;
g.document = dom.window.document;
g.window = dom.window;

const { PAGE_TEMPLATES } = await import("../../src/core/pageTemplates");
const { createStarterDocument, materialize } = await import("../../src/core/scene");
const { computeLayout } = await import("../../src/core/layout");
const { generateProject } = await import("../../src/core/codegen");
const { measureStub } = await import("./measure-stub");
type SceneNode = import("../../src/core/types").SceneNode;

let failures = 0;

console.log(`\n${"═".repeat(82)}`);
console.log(`  ШАБЛОНЫ СТРАНИЦ: ${PAGE_TEMPLATES.length} шаблонов`);
console.log("═".repeat(82));
console.log(
  `\n  ${"шаблон".padEnd(26)}${"секций".padStart(8)}${"узлов".padStart(7)}${"ширина".padStart(8)}` +
    `${"высота".padStart(8)}${"переп.".padStart(7)}${"CSS КБ".padStart(8)}  замечания`,
);
console.log("  " + "─".repeat(78));

for (const tmpl of PAGE_TEMPLATES) {
  /* Создаём чистый документ и разворачиваем шаблон */
  const doc = createStarterDocument();
  const frameId = doc.rootFrames[0]!;
  doc.nodes[frameId]!.children = [];
  doc.nodes[frameId]!.layout.width = tmpl.pageWidth;
  doc.nodes[frameId]!.layout.height = "hug";
  for (const id of Object.keys(doc.nodes)) if (id !== frameId) delete doc.nodes[id];

  const sections = tmpl.sections();
  const sectionIds: string[] = [];
  for (const spec of sections) {
    const id = materialize(doc, spec, frameId);
    sectionIds.push(id);
  }

  /* Решатель раскладки */
  const rects = computeLayout(doc, measureStub);
  const nodes = Object.values(doc.nodes) as SceneNode[];
  const frameRect = rects.get(frameId)!;

  /* Число узлов с нулевым размером */
  let zeroNodes = 0;
  for (const n of nodes) {
    if (n.id === frameId) continue;
    const r = rects.get(n.id);
    if (!r || r.w < 1 || r.h < 1) zeroNodes += 1;
  }

  /* Узлы, вышедшие за правую границу фрейма (переполнение по горизонтали) */
  let overflowCount = 0;
  let overflowWorst = 0;
  const frameRight = frameRect ? frameRect.x + frameRect.w : tmpl.pageWidth;
  for (const n of nodes) {
    if (n.id === frameId || !n.parent) continue;
    const r = rects.get(n.id);
    if (!r) continue;
    const excess = r.x + r.w - frameRight;
    if (excess > 2) {
      overflowCount += 1;
      overflowWorst = Math.max(overflowWorst, Math.round(excess));
    }
  }

  /* Ширина фоновых секций (role="section") — обязана совпадать с шириной фрейма.
     Шапка/подвал без двойной обёртки намеренно могут иметь ограниченный контент —
     проверяем только узлы с role="section", которые создаются через section(). */
  let bgNarrowCount = 0;
  for (const id of sectionIds) {
    const n = doc.nodes[id];
    if (!n || n.role !== "section") continue;
    if (!n.style?.fill || n.style.fill === "transparent") continue;
    const r = rects.get(id);
    if (!r) continue;
    const fw = frameRect ? frameRect.w : tmpl.pageWidth;
    if (r.w < fw - 2) bgNarrowCount += 1;
  }

  /* Высота страницы */
  const pageH = frameRect ? frameRect.h : 0;

  /* Кодоген */
  let html = "";
  let cssKb = 0;
  let codegenErr = "";
  try {
    const project = generateProject(doc, tmpl.name);
    const entries = Object.entries(project.files);
    html = entries.find(([p]) => /\.html?$/.test(p))?.[1] ?? "";
    const css = entries.find(([p]) => p.endsWith(".css"))?.[1] ?? "";
    cssKb = Math.round(css.length / 1024);
  } catch (e) {
    codegenErr = String(e).slice(0, 60);
  }

  /* Семантические теги.
     Порог «хотя бы два» ничего не проверял: два тега набирает даже одна
     секция с шапкой, поэтому проверка молча пропускала страницу без подвала.
     Целая страница обязана иметь каркас — шапку, подвал и секции, — поэтому
     требуем и количество, и присутствие обеих обязательных частей. */
  const semanticTags = ["<header", "<footer", "<section", "<main", "<article", "<nav"];
  const foundTags = semanticTags.filter((t) => html.includes(t));
  const REQUIRED = ["<header", "<footer", "<section"];
  const missingRequired = REQUIRED.filter((t) => !html.includes(t));
  const hasSemantics = foundTags.length >= 4 && missingRequired.length === 0;

  /* Итоговые замечания */
  const bad: string[] = [];
  if (zeroNodes > 0) bad.push(`нулевых узлов: ${zeroNodes}`);
  if (overflowCount > 0) bad.push(`за рамку по X: ${overflowCount} (${overflowWorst}px)`);
  if (bgNarrowCount > 0) bad.push(`фонов обрезаны по колонке: ${bgNarrowCount}`);
  if (pageH < 1000) bad.push(`высота подозрительна: ${Math.round(pageH)}px`);
  if (codegenErr) bad.push(`кодоген упал: ${codegenErr}`);
  if (!hasSemantics) {
    bad.push(
      missingRequired.length > 0
        ? `нет обязательных тегов: ${missingRequired.join(" ")}`
        : `мало семантических тегов (${foundTags.length} из 4)`,
    );
  }
  if (cssKb < 5) bad.push(`CSS подозрительно мал: ${cssKb} КБ`);

  if (bad.length > 0) failures += 1;

  const mark = bad.length === 0 ? "✓" : "✗";
  console.log(
    `${mark} ${tmpl.name.padEnd(26)}` +
      `${String(sections.length).padStart(8)}` +
      `${String(nodes.length - 1).padStart(7)}` +
      `${String(Math.round(frameRect?.w ?? 0)).padStart(8)}` +
      `${String(Math.round(pageH)).padStart(8)}` +
      `${String(overflowCount).padStart(7)}` +
      `${String(cssKb).padStart(8)}` +
      `  ${bad.length === 0 ? "—" : bad.join("; ")}`,
  );

  /* Детали семантики и размера (только при успехе — нет замечаний) */
  if (bad.length === 0) {
    console.log(
      `  ${"".padEnd(26)}${"теги:".padStart(26)} ${foundTags.slice(0, 4).join(" ")}`,
    );
  }
}

console.log("\n" + "─".repeat(82));
console.log(
  `  ИТОГ: шаблонов с замечаниями ${failures} из ${PAGE_TEMPLATES.length}\n`,
);
process.exit(failures > 0 ? 1 : 0);

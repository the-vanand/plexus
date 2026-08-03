/**
 * СТЕНД ИМПОРТА: прогон importHtmlToDoc + computeLayout вне UI.
 *
 * Задача — мерить импорт числами, а не глазами. Отчёт печатает то, на что
 * жалуется заказчик: ширину страницы, переполнения (текст «съезжает»),
 * покрытие стилей и число дошедших картинок.
 *
 *   npx tsx tools/harness/report.ts fixtures/cospex-site/index.html [ширина]
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
type SceneDocument = import("../../src/core/types").SceneDocument;
type SceneNode = import("../../src/core/types").SceneNode;
type Rect = import("../../src/core/types").Rect;

/* ------------------------------------------------------------------ */
/* Загрузка фикстуры                                                   */
/* ------------------------------------------------------------------ */

const htmlPath = resolve(process.argv[2] ?? "fixtures/cospex-site/index.html");
const viewport = Number(process.argv[3] ?? 1440);
const dir = dirname(htmlPath);
const html = readFileSync(htmlPath, "utf8");

let css = "";
for (const m of html.matchAll(/<link[^>]+href=["']([^"']+\.css)(?:\?[^"']*)?["'][^>]*>/g)) {
  if (/^https?:/.test(m[1])) continue;
  const p = resolve(dir, m[1].replace(/^\.?\//, ""));
  if (existsSync(p)) css += `\n${readFileSync(p, "utf8")}`;
}

/* ------------------------------------------------------------------ */
/* Что есть в источнике (ground truth)                                 */
/* ------------------------------------------------------------------ */

const srcDoc = new dom.window.DOMParser().parseFromString(html, "text/html");
const srcImgs = srcDoc.querySelectorAll("img").length;
const srcSvg = srcDoc.querySelectorAll("svg").length;
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
const srcBgImgs = [...cssNoComments.matchAll(/background(?:-image)?\s*:[^;}]*url\(/g)].length;
const srcGradients = [...cssNoComments.matchAll(/linear-gradient|radial-gradient/g)].length;

const visibleText = (): string => {
  const clone = srcDoc.body.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("script,style,.sr-only,.skip-link,option").forEach((n) => n.remove());
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
};
const srcTextLen = visibleText().length;

/** Свойства, ради которых сайт выглядит как сайт. */
const PROPS = [
  "font-family", "max-width", "margin", "background-image", "grid-template-columns",
  "object-fit", "inset", "clamp(", "position:fixed", "letter-spacing", "min-height",
] as const;
const srcPropCount = Object.fromEntries(
  PROPS.map((p) => [p, [...cssNoComments.matchAll(new RegExp(p.replace(/[().]/g, "\\$&"), "g"))].length]),
) as Record<string, number>;

/* ------------------------------------------------------------------ */
/* Импорт                                                              */
/* ------------------------------------------------------------------ */

const doc: SceneDocument = createStarterDocument();
doc.nodes = {};
doc.rootFrames = [];
doc.wires = [];

const t0 = Date.now();
const outcome = importHtmlToDoc(doc, { html, css, pageName: "COSPEX", sourceDir: dir, viewportWidth: viewport } as never);
const importMs = Date.now() - t0;
const rects = computeLayout(doc, measureStub);

/* ------------------------------------------------------------------ */
/* Метрики                                                             */
/* ------------------------------------------------------------------ */

const nodes = Object.values(doc.nodes) as SceneNode[];
const frame = doc.nodes[outcome.frameId]!;
const frameRect = rects.get(outcome.frameId)!;

const byType = new Map<string, number>();
for (const n of nodes) byType.set(n.type, (byType.get(n.type) ?? 0) + 1);

/** Переполнения: ребёнок вылез за содержимое родителя (допуск 1px). */
const TOL = 1;
type Overflow = { id: string; name: string; side: string; by: number };
const overflows: Overflow[] = [];
for (const n of nodes) {
  if (!n.parent) continue;
  const r = rects.get(n.id);
  const p = rects.get(n.parent);
  if (!r || !p) continue;
  const pad = (doc.nodes[n.parent] as SceneNode).layout.padding;
  const padL = typeof pad === "number" ? pad : (pad as { l: number }).l;
  const padR = typeof pad === "number" ? pad : (pad as { r: number }).r;
  if (r.x < p.x + padL - TOL) overflows.push({ id: n.id, name: n.name, side: "слева", by: Math.round(p.x + padL - r.x) });
  if (r.x + r.w > p.x + p.w - padR + TOL) overflows.push({ id: n.id, name: n.name, side: "справа", by: Math.round(r.x + r.w - (p.x + p.w - padR)) });
  if (r.y + r.h > p.y + p.h + TOL) overflows.push({ id: n.id, name: n.name, side: "снизу", by: Math.round(r.y + r.h - (p.y + p.h)) });
}

const imageNodes = nodes.filter((n) => n.type === "image");
const withSrc = imageNodes.filter((n) => n.src && n.src.trim() !== "").length;
const withBg = nodes.filter((n) => (n.style as { backgroundImage?: string }).backgroundImage).length;
const fonts = new Set(
  nodes.map((n) => (n.style as { fontFamily?: string }).fontFamily).filter((f): f is string => !!f),
);
const sceneTextLen = nodes.reduce((a, n) => a + (n.text?.length ?? 0), 0);
const truncated = nodes.filter((n) => (n.text?.length ?? 0) >= 320).length;
const emptyContainers = nodes.filter((n) => n.type === "container" && n.children.length === 0).length;

const maxWidths = nodes.filter((n) => (n.layout as { maxWidth?: number }).maxWidth !== undefined).length;
const gridCols = nodes.filter((n) => (n.layout as { gridTracks?: unknown[] }).gridTracks?.length).length;
const absolutes = nodes.filter((n) => n.layout.position === "absolute").length;
const gradients = nodes.filter((n) => (n.style as { backgroundGradient?: string }).backgroundGradient).length;
const sidedPadding = nodes.filter((n) => typeof n.layout.padding === "object").length;
const stretched = nodes.filter((n) => n.layout.right != null || n.layout.bottom != null).length;

/* ------------------------------------------------------------------ */
/* Печать                                                              */
/* ------------------------------------------------------------------ */

const pct = (a: number, b: number) => (b === 0 ? "—" : `${Math.round((a / b) * 100)}%`);
const line = (k: string, v: string | number, note = "") =>
  console.log(`  ${k.padEnd(34)} ${String(v).padEnd(14)} ${note}`);

console.log(`\n${"═".repeat(78)}`);
console.log(`  ОТЧЁТ ИМПОРТА — ${htmlPath.split("/").pop()} @ вьюпорт ${viewport}px   (${importMs} мс)`);
console.log("═".repeat(78));

console.log("\n▸ РАЗМЕР СТРАНИЦЫ");
line("ширина фрейма", `${frameRect.w}px`, frameRect.w === viewport ? "✓ совпала с вьюпортом" : `✗ ожидалось ${viewport}px`);
line("высота фрейма", `${Math.round(frameRect.h)}px`);
line("узлов с max-width", maxWidths, maxWidths === 0 ? "✗ колонка страницы не перенесена" : "");
line("узлов-сеток (grid)", gridCols, gridCols === 0 ? "✗ grid не распознан" : "");
line("absolute-оверлеев", absolutes, `растянутых по inset: ${stretched}`);
line("узлов с padding по сторонам", sidedPadding, sidedPadding === 0 ? "✗ отступы схлопнуты" : "");

console.log("\n▸ ТЕКСТ");
line("узлов вне рамки родителя", overflows.length, overflows.length === 0 ? "✓" : "✗ текст «съезжает»");
line("символов в сцене", sceneTextLen, `из ${srcTextLen} в источнике (${pct(sceneTextLen, srcTextLen)})`);
line("узлов, обрезанных по 320", truncated, truncated > 0 ? "✗ текст режется" : "✓");

console.log("\n▸ СТИЛИ");
line("семейств шрифтов в сцене", fonts.size, fonts.size === 0 ? "✗ шрифт не переносится вовсе" : [...fonts].join(", "));
for (const p of PROPS) {
  if (srcPropCount[p] > 0 && ["font-family", "max-width", "grid-template-columns", "background-image", "object-fit", "clamp("].includes(p)) {
    line(`  «${p}» в источнике`, srcPropCount[p], "");
  }
}

console.log("\n▸ ФОТОГРАФИИ");
line("узлов-картинок в сцене", imageNodes.length, `в источнике <img>: ${srcImgs}`);
line("  из них с непустым src", withSrc, withSrc < srcImgs ? "✗ часть картинок пустая" : "✓");
line("узлов с фоновой картинкой", withBg, `в CSS background url(): ${srcBgImgs}`);
line("inline <svg> в источнике", srcSvg, srcSvg > 0 ? "→ узлов-иконок в сцене" : "");
line("градиентов перенесено", gradients, `в CSS: ${srcGradients}`);

console.log("\n▸ СТРУКТУРА");
line("узлов всего", outcome.nodesAdded);
line("по типам", [...byType].map(([t, c]) => `${t}:${c}`).join(" "));
line("пустых контейнеров", emptyContainers);
if (outcome.warnings.length) line("замечания импортёра", [...new Set(outcome.warnings)].join("; "));

if (overflows.length) {
  console.log("\n▸ ТОП-12 ПЕРЕПОЛНЕНИЙ");
  overflows
    .sort((a, b) => b.by - a.by)
    .slice(0, 12)
    .forEach((o) => console.log(`  ${String(o.by).padStart(6)}px ${o.side.padEnd(7)} ${o.name}`));
}

/* Дерево верхнего уровня — видно, во что превратились секции. */
console.log("\n▸ ДЕРЕВО (2 уровня)");
const walk = (id: string, depth: number): void => {
  const n = doc.nodes[id];
  if (!n || depth > 2) return;
  const r = rects.get(id);
  const size = r ? `${Math.round(r.w)}×${Math.round(r.h)}` : "—";
  const dir = n.type === "container" || n.type === "frame" ? ` ${n.layout.direction}` : "";
  const cols = (n.layout as { gridTracks?: unknown[] }).gridTracks?.length;
  console.log(
    `  ${"  ".repeat(depth)}${n.type.padEnd(9)} ${size.padEnd(11)}${dir.padEnd(8)}${cols ? `cols:${cols} ` : ""}${n.name.slice(0, 34)}`,
  );
  for (const c of n.children) walk(c, depth + 1);
};
walk(outcome.frameId, 0);
console.log("");

/** Машиночитаемая сводка — для сравнения до/после. */
const summary = {
  frameW: frameRect.w,
  frameH: Math.round(frameRect.h),
  overflows: overflows.length,
  overflowWorst: overflows.length ? Math.max(...overflows.map((o) => o.by)) : 0,
  textCoverage: Math.round((sceneTextLen / srcTextLen) * 100),
  truncated,
  fonts: fonts.size,
  images: withSrc,
  bgImages: withBg,
  maxWidths,
  gridCols,
  gradients,
  sidedPadding,
  nodes: outcome.nodesAdded,
};
console.log(`JSON ${JSON.stringify(summary)}\n`);

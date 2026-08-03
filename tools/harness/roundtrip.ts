/**
 * СКВОЗНАЯ ПРОВЕРКА: HTML → scene graph → кодоген → HTML.
 *
 * Импорт бесполезен, если экспорт теряет то, что импорт донёс. Скрипт
 * прогоняет полный круг и пишет результат на диск, чтобы его можно было
 * открыть рядом с оригиналом. Картинки инлайнятся в data-URI — файл
 * самодостаточный, его можно открыть где угодно.
 *
 *   npx tsx tools/harness/roundtrip.ts [ширина] [--inline]
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, extname } from "node:path";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
g.DOMParser = dom.window.DOMParser;
g.Node = dom.window.Node;
g.Element = dom.window.Element;
g.document = dom.window.document;
g.window = dom.window;

const { importHtmlToDoc } = await import("../../src/core/importer");
const { createStarterDocument } = await import("../../src/core/scene");
const { generateProject } = await import("../../src/core/codegen");

const viewport = Number(process.argv[2] ?? 1440);
const inline = process.argv.includes("--inline");
const htmlPath = resolve(process.env.FIXTURE ?? "fixtures/cospex-lite/index.html");
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
importHtmlToDoc(doc, { html, css, pageName: "COSPEX", sourceDir: dir, viewportWidth: viewport } as never);

const project = generateProject(doc, "COSPEX");
const outDir = resolve("out/roundtrip");
mkdirSync(outDir, { recursive: true });

const MIME: Record<string, string> = {
  ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".gif": "image/gif",
};

/** Заменяет ссылки на локальные ассеты их base64-содержимым. */
function inlineAssets(text: string): string {
  return text.replace(/(src|href)="([^"]*\/)?assets\/([^"]+)"/g, (whole, attr: string, _p: string, file: string) => {
    const src = resolve(dir, "assets", file);
    if (!existsSync(src)) return whole;
    const mime = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    return `${attr}="data:${mime};base64,${readFileSync(src).toString("base64")}"`;
  });
}

const entries = Object.entries(project.files);
let written = 0;
for (const [path, raw] of entries) {
  let content = raw;
  if (inline && /\.html?$/.test(path)) {
    // css вшиваем в страницу, чтобы файл был один
    const cssEntry = entries.find(([p]) => p.endsWith(".css"));
    if (cssEntry) {
      content = content.replace(
        /<link[^>]+href="[^"]*\.css"[^>]*>/,
        `<style>\n${inlineAssets(cssEntry[1])}\n</style>`,
      );
    }
    content = inlineAssets(content);
  }
  const target = resolve(outDir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
  written += 1;
}

/* ---------- что попало в вывод ---------- */
const page = entries.find(([p]) => /\.html?$/.test(p))?.[1] ?? "";
const sheet = entries.find(([p]) => p.endsWith(".css"))?.[1] ?? "";
const count = (re: RegExp, text: string) => (text.match(re) ?? []).length;

const checks: Array<[string, number, string]> = [
  ["display:grid", count(/display:\s*grid/g, sheet), "сетки сохранены"],
  ["grid-template-columns", count(/grid-template-columns/g, sheet), ""],
  ["grid-column: 1 / -1", count(/grid-column:\s*1 \/ -1/g, sheet), "элементы на всю строку"],
  ["font-family Georgia", count(/Georgia/g, sheet), "типографика оригинала"],
  ["max-width", count(/max-width/g, sheet), "колонки текста"],
  ["padding по 4 сторонам", count(/padding:\s*\d+px \d+px \d+px \d+px/g, sheet), ""],
  ["background-image", count(/background-image/g, sheet), "фоны и градиенты"],
  ["linear-gradient", count(/linear-gradient/g, sheet), ""],
  ["object-fit", count(/object-fit/g, sheet), ""],
  ["rgba() с альфой", count(/rgba\(/g, sheet), "полупрозрачность"],
  ["<img", count(/<img/g, page), "картинки в разметке"],
  ["семантические теги", count(/<(header|footer|nav|section)[\s>]/g, page), ""],
];

console.log(`\n▸ КОДОГЕН: файлов ${written} → out/roundtrip`);
for (const [name, n, note] of checks) {
  const mark = n > 0 ? "✓" : "·";
  console.log(`  ${mark} ${name.padEnd(26)} ${String(n).padStart(4)}  ${note}`);
}
console.log(`\n  страница: ${(page.length / 1024).toFixed(1)} КБ, стили: ${(sheet.length / 1024).toFixed(1)} КБ\n`);

/* Машиночитаемая строка для CI. Стенд сознательно НЕ решает сам, регрессия
   это или нет: эталонные значения лежат в tools/ci/baseline.json и меняются
   осознанной правкой в PR. Иначе гейт незаметно стареет вместе с кодом. */
console.log(
  `JSON ${JSON.stringify({
    grid: count(/display:\s*grid/g, sheet),
    gridTemplate: count(/grid-template-columns/g, sheet),
    gridFullRow: count(/grid-column:\s*1\s*\/\s*-1/g, sheet),
    georgia: count(/Georgia/g, sheet),
    maxWidth: count(/max-width/g, sheet),
    images: count(/<img/g, page),
    semanticTags: count(/<(header|footer|nav|section)[\s>]/g, page),
    pageBytes: page.length,
    cssBytes: sheet.length,
  })}\n`,
);

/**
 * СТЕНД ДЕТЕРМИНИРОВАННОСТИ ИМПОРТА.
 *
 * Проверяет свойство, без которого невозможны ни побайтовая сверка вывода в
 * CI, ни хранение сохранённых проектов в git: разбор одного и того же
 * исходника обязан давать один и тот же документ.
 *
 * Но у свойства есть обратная сторона, которую тоже надо проверять: если
 * сделать id зависимыми ТОЛЬКО от исходника, два импорта одного сайта в один
 * документ получат одинаковые id и документ разрушится. Поэтому здесь
 * проверяются оба края: повторяемость между прогонами и уникальность внутри
 * документа.
 *
 *   npx tsx tools/harness/determinism.ts
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
g.DOMParser = dom.window.DOMParser;
g.Node = dom.window.Node;
g.Element = dom.window.Element;
g.document = dom.window.document;
g.window = dom.window;

const { importHtmlToDoc } = await import("../../src/core/importer");
const { importSnapshotToDoc } = await import("../../src/core/importSnapshot");
const { createStarterDocument } = await import("../../src/core/scene");
const { generateProject } = await import("../../src/core/codegen");
const { uid } = await import("../../src/core/ids");
type SceneDocument = import("../../src/core/types").SceneDocument;
type PageSnapshot = import("../../src/core/snapshot").PageSnapshot;

const FIXTURE = process.env.FIXTURE ?? "fixtures/cospex-lite/index.html";
const html = readFileSync(FIXTURE, "utf8");
const css = readFileSync(FIXTURE.replace(/index\.html$/, "styles.css"), "utf8");
const snap = JSON.parse(readFileSync("fixtures/snapshots/cospex-1920.json", "utf8")) as PageSnapshot;

const empty = (): SceneDocument => {
  const d = createStarterDocument();
  d.nodes = {};
  d.rootFrames = [];
  d.wires = [];
  return d;
};

let failed = 0;
const check = (name: string, ok: boolean, detail: string): void => {
  console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(46)} ${detail}`);
  if (!ok) failed += 1;
};

console.log(`\n${"═".repeat(74)}`);
console.log("  ДЕТЕРМИНИРОВАННОСТЬ ИМПОРТА");
console.log("═".repeat(74));

/* ---------- 1. Разбор HTML: два прогона ---------- */
console.log("\n▸ РАЗБОР HTML");

const idsOf = (d: SceneDocument): string[] => Object.keys(d.nodes).sort();

const docA = empty();
importHtmlToDoc(docA, { html, css, pageName: "Тест", viewportWidth: 1440, sourceDir: "fixtures/cospex-lite" });
const docB = empty();
importHtmlToDoc(docB, { html, css, pageName: "Тест", viewportWidth: 1440, sourceDir: "fixtures/cospex-lite" });

const idsA = idsOf(docA);
const idsB = idsOf(docB);
check("узлов создано одинаково", idsA.length === idsB.length, `${idsA.length} и ${idsB.length}`);
check("все id совпали", JSON.stringify(idsA) === JSON.stringify(idsB), `${idsA.length} id`);

/* ---------- 2. Кодоген: побайтово ---------- */
console.log("\n▸ ВЫВОД КОДОГЕНА");

const codeOf = (d: SceneDocument): string => {
  const files = generateProject(d, "Тест").files;
  return Object.keys(files).sort().map((k) => `${k}\n${files[k]}`).join("\n");
};
const codeA = codeOf(docA);
const codeB = codeOf(docB);
check("вывод идентичен побайтово", codeA === codeB, `${(codeA.length / 1024).toFixed(1)} КБ`);

/* ---------- 3. Другая ширина — другой документ ---------- */
const docC = empty();
importHtmlToDoc(docC, { html, css, pageName: "Тест", viewportWidth: 1280, sourceDir: "fixtures/cospex-lite" });
check(
  "иная ширина даёт иные id (затравка учитывает ширину)",
  JSON.stringify(idsOf(docC)) !== JSON.stringify(idsA),
  `1280 против 1440`,
);

/* ---------- 4. Уникальность внутри документа ---------- */
console.log("\n▸ УНИКАЛЬНОСТЬ");

const docD = empty();
importHtmlToDoc(docD, { html, css, pageName: "Тест", viewportWidth: 1440, sourceDir: "fixtures/cospex-lite" });
const afterFirst = Object.keys(docD.nodes).length;
importHtmlToDoc(docD, { html, css, pageName: "Тест", viewportWidth: 1440, sourceDir: "fixtures/cospex-lite" });
const afterSecond = Object.keys(docD.nodes).length;
check(
  "повторный импорт в тот же документ не затирает узлы",
  afterSecond === afterFirst * 2,
  `${afterFirst} → ${afterSecond} (ожидалось ${afterFirst * 2})`,
);

/* ---------- 5. Снимок ---------- */
console.log("\n▸ ИМПОРТ ПО СНИМКУ");

const snapA = empty();
importSnapshotToDoc(snapA, { snapshot: snap, pageName: "Снимок" });
const snapB = empty();
importSnapshotToDoc(snapB, { snapshot: snap, pageName: "Снимок" });
check("все id совпали", JSON.stringify(idsOf(snapA)) === JSON.stringify(idsOf(snapB)), `${idsOf(snapA).length} id`);
check("вывод идентичен побайтово", codeOf(snapA) === codeOf(snapB), `${(codeOf(snapA).length / 1024).toFixed(1)} КБ`);

/* ---------- 6. Редактор остаётся случайным ---------- */
console.log("\n▸ ИНТЕРАКТИВНОЕ СОЗДАНИЕ");
const fresh = new Set([uid("node"), uid("node"), uid("node"), uid("node"), uid("node")]);
check("вне импорта id случайны и уникальны", fresh.size === 5, `${fresh.size} различных из 5`);

console.log(
  failed === 0
    ? `\n  ИТОГ: провалено 0 из ${8}\n`
    : `\n  ИТОГ: провалено ${failed} из ${8}\n`,
);
console.log(`JSON ${JSON.stringify({ checks: 8, failed, nodes: idsA.length, codeBytes: codeA.length })}\n`);
process.exit(failed > 0 ? 1 : 0);

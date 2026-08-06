/**
 * ЭКСПОРТ СНИМКА В HTML-ФАЙЛЫ: импорт -> generateProject -> файлы на диск.
 *   npx tsx tools/harness/export-page.ts fixtures/snapshots/<имя>.json /tmp/out
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>");
const g = globalThis as Record<string, unknown>;
g.DOMParser = dom.window.DOMParser; g.Node = dom.window.Node; g.Element = dom.window.Element;
g.document = dom.window.document; g.window = dom.window;
const { importSnapshotToDoc } = await import("../../src/core/importSnapshot");
const { createStarterDocument } = await import("../../src/core/scene");
const { generateProject } = await import("../../src/core/codegen");
type PageSnapshot = import("../../src/core/snapshot").PageSnapshot;

const snap = JSON.parse(readFileSync(process.argv[2], "utf8")) as PageSnapshot;
const outDir = process.argv[3] ?? "/tmp/export-out";
const doc = createStarterDocument();
doc.nodes = {}; doc.rootFrames = []; doc.wires = [];
importSnapshotToDoc(doc, { snapshot: snap, pageName: "проверка" });
const project = generateProject(doc, "проверка");
mkdirSync(outDir, { recursive: true });
for (const [path, contents] of Object.entries(project.files)) {
  writeFileSync(join(outDir, path.replace(/\//g, "_")), contents);
  console.log(path, contents.length, "байт");
}

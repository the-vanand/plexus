/**
 * СТЕНД ИМПОРТА ПО СНИМКУ.
 *
 * Ключевая проверка, которой раньше не существовало: снимок содержит
 * ИЗМЕРЕННЫЕ браузером прямоугольники, поэтому расчёт решателя можно
 * сравнить с истиной поэлементно. Это не эвристика «вылез за рамку» —
 * это расхождение в пикселях против настоящего рендера.
 *
 *   npx tsx tools/harness/snapshot-check.ts fixtures/snapshots/cospex-1920.json
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

const { importSnapshotToDoc } = await import("../../src/core/importSnapshot");
const { computeLayout } = await import("../../src/core/layout");
const { createStarterDocument } = await import("../../src/core/scene");
const { generateProject } = await import("../../src/core/codegen");
const { measureStub } = await import("./measure-stub");
type PageSnapshot = import("../../src/core/snapshot").PageSnapshot;
type SceneNode = import("../../src/core/types").SceneNode;

const path = process.argv[2] ?? "fixtures/snapshots/cospex-1920.json";
const snap = JSON.parse(readFileSync(path, "utf8")) as PageSnapshot;

const doc = createStarterDocument();
doc.nodes = {};
doc.rootFrames = [];
doc.wires = [];

const t0 = Date.now();
const out = importSnapshotToDoc(doc, { snapshot: snap, pageName: "COSPEX (снимок)" });
const ms = Date.now() - t0;
const rects = computeLayout(doc, measureStub);

const nodes = Object.values(doc.nodes) as SceneNode[];
const frameRect = rects.get(out.frameId)!;
const byType = new Map<string, number>();
for (const n of nodes) byType.set(n.type, (byType.get(n.type) ?? 0) + 1);

console.log(`\n${"═".repeat(74)}`);
console.log(`  ИМПОРТ ПО СНИМКУ — ${basename(path)}`);
console.log("═".repeat(74));
console.log(`\n▸ ИСТОЧНИК (замерено браузером)`);
console.log(`  узлов в снимке          ${snap.nodes.length}`);
console.log(`  скрытых пропущено       ${snap.skipped}`);
console.log(`  вьюпорт                 ${snap.viewportWidth}×${snap.viewportHeight}`);
console.log(`  высота документа        ${snap.documentHeight}px`);
console.log(`  шрифты                  ${snap.fonts.join(" · ")}`);
console.log(`  ждали сборки            ${snap.settleMs} мс`);

console.log(`\n▸ РЕЗУЛЬТАТ (${ms} мс)`);
console.log(`  узлов в сцене           ${out.nodesAdded}`);
console.log(`  обёрток свёрнуто        ${out.collapsed}`);
console.log(`  по типам                ${[...byType].map(([t, c]) => `${t}:${c}`).join(" ")}`);
console.log(`  шрифтов перенесено      ${out.fontFamilies.length}`);
console.log(`  ширина фрейма           ${Math.round(frameRect.w)}px  (вьюпорт ${snap.viewportWidth})`);
console.log(`  высота фрейма           ${Math.round(frameRect.h)}px  (документ ${snap.documentHeight})`);
const heightErr = Math.abs(frameRect.h - snap.documentHeight) / snap.documentHeight;
console.log(`  расхождение высоты      ${(heightErr * 100).toFixed(1)}%`);
if (out.widgets.length) console.log(`  виджеты                 ${out.widgets.join("; ")}`);
for (const w of out.warnings) console.log(`  ! ${w}`);

/* ------------------------------------------------------------------ */
/* Поэлементная сверка с измеренной геометрией                         */
/* ------------------------------------------------------------------ */

/**
 * Сопоставляем узел сцены с узлом снимка по тексту и типу: id снимка в
 * сцену не переносятся, а текст уникален почти всегда.
 */
const snapByText = new Map<string, number[]>();
snap.nodes.forEach((n, i) => {
  if (!n.x) return;
  const key = n.x.slice(0, 60);
  const arr = snapByText.get(key);
  if (arr) arr.push(i);
  else snapByText.set(key, [i]);
});

interface Diff {
  name: string;
  text: string;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}
const diffs: Diff[] = [];
const frameX = doc.nodes[out.frameId]!.layout.x;
const frameY = doc.nodes[out.frameId]!.layout.y;

for (const node of nodes) {
  if (!node.text) continue;
  const key = node.text.slice(0, 60);
  const candidates = snapByText.get(key);
  if (!candidates || candidates.length === 0) continue;
  const src = snap.nodes[candidates.shift()!];
  const r = rects.get(node.id);
  if (!r) continue;
  diffs.push({
    name: node.name,
    text: node.text.slice(0, 34).replace(/\n/g, "⏎"),
    dx: Math.round(r.x - frameX - src.r[0]),
    dy: Math.round(r.y - frameY - src.r[1]),
    dw: Math.round(r.w - src.r[2]),
    dh: Math.round(r.h - src.r[3]),
  });
}

const stat = (vals: number[]) => {
  if (vals.length === 0) return { mean: 0, med: 0, p90: 0, max: 0 };
  const abs = vals.map(Math.abs).sort((a, b) => a - b);
  return {
    mean: Math.round(abs.reduce((a, b) => a + b, 0) / abs.length),
    med: abs[Math.floor(abs.length / 2)],
    p90: abs[Math.floor(abs.length * 0.9)],
    max: abs[abs.length - 1],
  };
};

console.log(`\n▸ СВЕРКА С ИЗМЕРЕННОЙ ГЕОМЕТРИЕЙ (${diffs.length} текстовых узлов)`);
console.log(`  ${"величина".padEnd(16)}${"среднее".padStart(9)}${"медиана".padStart(9)}${"p90".padStart(7)}${"макс".padStart(7)}`);
console.log("  " + "─".repeat(48));
for (const [label, vals] of [
  ["по X", diffs.map((d) => d.dx)],
  ["по Y", diffs.map((d) => d.dy)],
  ["ширина", diffs.map((d) => d.dw)],
  ["высота", diffs.map((d) => d.dh)],
] as Array<[string, number[]]>) {
  const s = stat(vals);
  console.log(
    `  ${label.padEnd(16)}${String(s.mean).padStart(8)}px${String(s.med).padStart(8)}px${String(s.p90).padStart(6)}px${String(s.max).padStart(6)}px`,
  );
}

const withinX = diffs.filter((d) => Math.abs(d.dx) <= 4).length;
const withinW = diffs.filter((d) => Math.abs(d.dw) <= 8).length;
const pct = (n: number) => `${Math.round((n / Math.max(1, diffs.length)) * 100)}%`;
console.log(`\n  по X точнее 4px:  ${withinX} из ${diffs.length}  (${pct(withinX)})`);
console.log(`  по ширине точнее 8px: ${withinW} из ${diffs.length}  (${pct(withinW)})`);

const worst = [...diffs].sort((a, b) => Math.abs(b.dx) + Math.abs(b.dw) - Math.abs(a.dx) - Math.abs(a.dw)).slice(0, 8);
if (worst.length) {
  console.log(`\n▸ ХУДШИЕ РАСХОЖДЕНИЯ`);
  for (const d of worst) {
    console.log(`  dx${String(d.dx).padStart(6)} dw${String(d.dw).padStart(6)} dy${String(d.dy).padStart(6)}  «${d.text}»`);
  }
}

/* кодоген обязан переварить результат */
try {
  const project = generateProject(doc, "COSPEX по снимку");
  const entries = Object.entries(project.files);
  const html = entries.find(([p]) => /\.html?$/.test(p))?.[1] ?? "";
  const css = entries.find(([p]) => p.endsWith(".css"))?.[1] ?? "";
  console.log(`\n▸ КОДОГЕН: страница ${(html.length / 1024).toFixed(0)} КБ, стили ${(css.length / 1024).toFixed(0)} КБ`);
  const count = (re: RegExp) => (css.match(re) ?? []).length;
  console.log(`  grid ${count(/display:\s*grid/g)} · Georgia ${count(/Georgia/g)} · max-width ${count(/max-width/g)} · rgba ${count(/rgba\(/g)}`);
} catch (e) {
  console.log(`\n▸ КОДОГЕН УПАЛ: ${String(e).slice(0, 120)}`);
}

console.log(
  `\nJSON ${JSON.stringify({
    snapNodes: snap.nodes.length,
    sceneNodes: out.nodesAdded,
    collapsed: out.collapsed,
    frameW: frameRect.w,
    frameH: Math.round(frameRect.h),
    docH: snap.documentHeight,
    heightErrPct: Math.round(heightErr * 1000) / 10,
    matched: diffs.length,
    dxMean: stat(diffs.map((d) => d.dx)).mean,
    dwMean: stat(diffs.map((d) => d.dw)).mean,
    withinX4: withinX,
    withinW8: withinW,
  })}\n`,
);

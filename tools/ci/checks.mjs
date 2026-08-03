/**
 * АРБИТР СБОРКИ.
 *
 * Зачем отдельный раннер, а не список шагов в workflow: когда над проектом
 * работают несколько агентов параллельно, ревью 11 тысяч строк глазами
 * невозможно. Решение «можно мержить» должна принимать машина по числам,
 * и одинаково — что в CI, что локально одной командой.
 *
 *   node tools/ci/checks.mjs
 *
 * Два вида проверок, и разница принципиальная:
 *
 *  1. САМОСУДЯЩИЕ стенды (`catalog`, `templates`, `breakpoints`) сами знают,
 *     что считать браком, и падают кодом возврата. Раннер только запускает.
 *  2. МЕТРИЧЕСКИЕ стенды (`roundtrip`, `snapshot-check`) печатают строку
 *     `JSON {...}` и НЕ судят себя сами: эталон лежит в baseline.json.
 *     Так порог виден в диффе PR и меняется осознанно, а не подгоняется
 *     под текущий результат.
 *
 * Стенды, которых нет в дереве, пропускаются. Это нужно для стековых ветвей:
 * `breakpoints.ts` и `templates.ts` появляются вместе со своими PR, и до их
 * слияния CI не должен падать на отсутствующем файле.
 *
 * Допуски в baseline.json читаются так:
 *   нет ключа  → требуется точное совпадение;
 *   +N         → рост не более чем на N (улучшение вниз разрешено всегда);
 *   -N         → падение не более чем на N (рост разрешён всегда).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const baseline = JSON.parse(readFileSync("tools/ci/baseline.json", "utf8"));
const tol = baseline.tolerance ?? {};
const results = [];
let failed = 0;

const run = (cmd, args) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};

const record = (name, ok, note) => {
  results.push({ name, ok, note });
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(26)} ${note}`);
};

console.log("\n════ ПРОВЕРКИ СБОРКИ ════\n");

/* ---------- типы и сборка ---------- */
{
  const r = run("npx", ["tsc", "--noEmit"]);
  record("tsc --noEmit", r.ok, r.ok ? "без ошибок" : r.out.split("\n").filter(Boolean).slice(0, 3).join(" | "));
}
{
  const r = run("npx", ["vite", "build"]);
  const built = /built in/.test(r.out);
  record("vite build", r.ok && built, built ? "собралось" : r.out.split("\n").filter(Boolean).slice(-2).join(" | "));
}

/* ---------- самосудящие стенды ---------- */
for (const [file, label] of [
  ["tools/harness/catalog.ts", "catalog"],
  ["tools/harness/templates.ts", "templates"],
  ["tools/harness/breakpoints.ts", "breakpoints"],
  ["tools/harness/determinism.ts", "determinism"],
]) {
  if (!existsSync(file)) {
    console.log(`· ${label.padEnd(26)} нет в дереве, пропуск`);
    continue;
  }
  const r = run("npx", ["tsx", file]);
  const verdict = (r.out.match(/ИТОГ:.*/) ?? ["код возврата"])[0].trim();
  record(label, r.ok, verdict);
}

/* ---------- метрические стенды ---------- */
const metricRuns = [
  ["roundtrip", "tools/harness/roundtrip.ts", []],
  ["snapshot-check", "tools/harness/snapshot-check.ts", ["fixtures/snapshots/cospex-1920.json"]],
];

for (const [label, file, args] of metricRuns) {
  if (!existsSync(file)) {
    console.log(`· ${label.padEnd(26)} нет в дереве, пропуск`);
    continue;
  }
  const r = run("npx", ["tsx", file, ...args]);
  if (!r.ok) {
    record(label, false, "стенд упал");
    continue;
  }
  const line = r.out.split("\n").reverse().find((l) => l.startsWith("JSON "));
  if (!line) {
    record(label, false, "стенд не напечатал строку JSON");
    continue;
  }
  const got = JSON.parse(line.slice(5));
  const want = baseline[label] ?? {};
  const bad = [];
  for (const [k, expected] of Object.entries(want)) {
    const actual = got[k];
    if (actual === undefined) {
      bad.push(`${k}: нет в выводе`);
      continue;
    }
    const t = tol[k];
    const okKey =
      t === undefined ? actual === expected
      : t >= 0 ? actual <= expected + t
      : actual >= expected + t;
    if (!okKey) bad.push(`${k}: ${actual} против эталона ${expected}`);
  }
  record(label, bad.length === 0, bad.length === 0 ? `${Object.keys(want).length} метрик совпали` : bad.join("; "));
}

console.log(
  failed === 0
    ? `\nИТОГ: все проверки прошли (${results.length})\n`
    : `\nИТОГ: провалено ${failed} из ${results.length}\n`,
);
process.exit(failed > 0 ? 1 : 0);

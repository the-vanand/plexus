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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const baseline = JSON.parse(readFileSync("tools/ci/baseline.json", "utf8"));
const tol = baseline.tolerance ?? {};
const results = [];
let failed = 0;

/**
 * Путь к исполняемому файлу пакета, объявленному в его package.json.
 *
 * Раньше раннер звал `npx`, и на Windows это ломало ВСЁ разом: там `npx` —
 * это `npx.cmd`, а Node начиная с 18.20/20.12 отказывается запускать `.cmd`
 * без оболочки (защита от CVE-2024-27980) и падает с EINVAL ещё ДО запуска
 * команды. Все восемь проверок сваливались одновременно и молча.
 *
 * Запуск через сам Node (`process.execPath`) не зависит ни от оболочки, ни
 * от платформы, ни от содержимого PATH.
 */
function binOf(pkg, name = pkg) {
  const dir = join(process.cwd(), "node_modules", pkg);
  const pj = join(dir, "package.json");
  if (!existsSync(pj)) throw new Error(`не найден пакет ${pkg} — выполните npm install`);
  const bin = JSON.parse(readFileSync(pj, "utf8")).bin;
  const rel = typeof bin === "string" ? bin : bin?.[name];
  if (!rel) throw new Error(`пакет ${pkg} не объявляет исполняемый файл ${name}`);
  return join(dir, rel);
}

const NODE = process.execPath;

/**
 * Запуск команды. Возвращает не только вывод, но и причину сбоя ЗАПУСКА.
 *
 * `e.stdout`/`e.stderr` равны undefined, когда процесс не удалось запустить
 * (ENOENT, EINVAL), — в отличие от ненулевого кода возврата, где вывод есть.
 * Прежняя версия склеивала их через `?? ""` и печатала пустое место вместо
 * причины: проверка падала, не сообщая ничего. Молчащий гейт немногим лучше
 * отсутствующего, поэтому ошибка запуска теперь видна в таблице.
 */
const run = (cmd, args) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }) };
  } catch (e) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    const launchError = out.trim() ? "" : `не удалось запустить: ${[e.code, e.message].filter(Boolean).join(" ")}`;
    return { ok: false, out, launchError };
  }
};

/** Короткая причина для таблицы: вывод команды либо ошибка запуска. */
const reason = (r, lines = 3) =>
  r.launchError || r.out.split("\n").filter(Boolean).slice(0, lines).join(" | ") || "код возврата";

/**
 * Запуск инструмента из node_modules. Отсутствие пакета — это тоже
 * результат проверки, а не повод уронить весь раннер стеком: иначе одна
 * непоставленная зависимость скрывает состояние всех остальных проверок.
 */
const runBin = (pkg, name, args) => {
  try {
    return run(NODE, [binOf(pkg, name), ...args]);
  } catch (e) {
    return { ok: false, out: "", launchError: String(e.message ?? e) };
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
  const r = runBin("typescript", "tsc", ["--noEmit"]);
  record("tsc --noEmit", r.ok, r.ok ? "без ошибок" : reason(r));
}
{
  const r = runBin("vite", "vite", ["build"]);
  const built = /built in/.test(r.out);
  record("vite build", r.ok && built, built ? "собралось" : reason(r, 2));
}

/* ---------- баланс блочных комментариев в Rust ---------- */
{
  /**
   * Единственная проверка Rust, возможная без тулчейна — и она поймала бы
   * настоящую поломку сборки. Блочные комментарии в Rust ВЛОЖЕННЫЕ, поэтому
   * запись схемы со звёздочкой внутри комментария (двойной слэш плюс
   * звёздочка) открывает вложенный комментарий: внешний остаётся незакрытым
   * и съедает файл. Компилятор падает с E0758, но в песочнице компилятора
   * нет, и до этой проверки ошибка доезжала до чужой машины.
   */
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "target" && e.name !== "gen") walk(full);
      } else if (e.name.endsWith(".rs")) files.push(full);
    }
  };
  const bad = [];
  if (existsSync("src-tauri")) {
    walk("src-tauri");
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      let depth = 0;
      let line = 1;
      const opens = [];
      for (let i = 0; i < src.length - 1; ) {
        if (src[i] === "\n") line += 1;
        const two = src.slice(i, i + 2);
        if (two === "/*") { depth += 1; opens.push(line); i += 2; continue; }
        if (two === "*/") { depth -= 1; opens.pop(); i += 2; continue; }
        i += 1;
      }
      if (depth !== 0) bad.push(`${f}: глубина ${depth}, не закрыт со строк ${opens.join(", ")}`);
    }
  }
  record("rust: комментарии", bad.length === 0, bad.length === 0 ? `${files.length} файлов сбалансированы` : bad.join(" | "));
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
  const r = runBin("tsx", "tsx", [file]);
  const verdict = (r.out.match(/ИТОГ:.*/) ?? [reason(r, 2)])[0].trim();
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
  const r = runBin("tsx", "tsx", [file, ...args]);
  if (!r.ok) {
    record(label, false, `стенд упал: ${reason(r, 2)}`);
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

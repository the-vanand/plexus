/**
 * ИКОНКИ ПРИЛОЖЕНИЯ — АРТЕФАКТ, А НЕ СОДЕРЖИМОЕ РЕПОЗИТОРИЯ.
 *
 * Задача: `git clone` → `npm install` → `npm run tauri dev` должно работать
 * без единого ручного шага. До этого скрипта не работало: `tauri-build`
 * останавливал сборку сообщением
 *
 *     `icons/icon.ico` not found; required for generating a Windows Resource
 *
 * потому что шести бинарных иконок в репозитории не было. Причина не в
 * забывчивости: файлы заливались через мост, передающий содержимое как
 * UTF-8, и любой PNG/ICO/ICNS он бы разрушил. Заливать битые бинарники
 * хуже, чем не заливать вовсе.
 *
 * Решение: держать в репозитории ИСТОЧНИК — `design/icon.svg`, обычный
 * текстовый файл, — и порождать из него все форматы командой `tauri icon`.
 * Так репозиторий самодостаточен, иконки нельзя рассинхронизировать с
 * источником, и в истории не хранятся бинарные копии.
 *
 * Скрипт вызывается автоматически из `postinstall` и вручную:
 *
 *     npm run icons          # только если чего-то не хватает
 *     npm run icons -- --force   # перегенерировать после правки SVG
 *
 * Два правила, важных для postinstall:
 *  1. Идемпотентность: если все нужные файлы на месте, скрипт молча выходит.
 *     Иначе каждая установка тратила бы секунду впустую.
 *  2. Скрипт НИКОГДА не валит `npm install`. Отсутствие иконок — это
 *     проблема только для десктоп-сборки; тот, кому нужен веб-режим или
 *     прогон стендов, не должен получить обрыв установки. Поэтому при сбое
 *     печатается внятное предупреждение и возвращается ноль.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SOURCE = join(ROOT, "design", "icon.svg");
const ICONS_DIR = join(ROOT, "src-tauri", "icons");

/** Ровно то, что перечислено в bundle.icon у tauri.conf.json. */
const REQUIRED = [
  "32x32.png",
  "128x128.png",
  "128x128@2x.png",
  "icon.icns",
  "icon.ico",
  "icon.png",
];

const force = process.argv.includes("--force");
const missing = REQUIRED.filter((f) => !existsSync(join(ICONS_DIR, f)));

if (!force && missing.length === 0) process.exit(0);

const warn = (msg) => {
  console.warn(`\n[иконки] ${msg}`);
  console.warn("[иконки] Десктоп-сборка (npm run tauri dev) без них не запустится.");
  console.warn("[иконки] Веб-режим (npm run dev) и стенды (npm run check) работают.\n");
  process.exit(0);
};

if (!existsSync(SOURCE)) warn(`не найден источник ${SOURCE}`);

/**
 * Путь к CLI Tauri берём из его package.json и запускаем самим Node.
 * Через `npx` нельзя: на Windows это `npx.cmd`, а Node с 18.20/20.12
 * отказывается запускать `.cmd` без оболочки (CVE-2024-27980) — тот же
 * дефект уже ломал арбитра сборки, повторять его не будем.
 */
let cli;
try {
  const pkgDir = join(ROOT, "node_modules", "@tauri-apps", "cli");
  const bin = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).bin;
  cli = join(pkgDir, typeof bin === "string" ? bin : bin.tauri);
} catch {
  warn("не найден пакет @tauri-apps/cli — выполните npm install");
}

console.log(
  force
    ? "[иконки] Перегенерация из design/icon.svg…"
    : `[иконки] Не хватает файлов (${missing.join(", ")}), генерирую из design/icon.svg…`,
);

try {
  execFileSync(process.execPath, [cli, "icon", SOURCE], { stdio: ["ignore", "ignore", "pipe"] });
} catch (e) {
  const detail = `${e.stderr ?? ""}`.trim() || e.message || String(e);
  warn(`не удалось сгенерировать: ${detail.split("\n").slice(0, 3).join(" | ")}`);
}

const still = REQUIRED.filter((f) => !existsSync(join(ICONS_DIR, f)));
if (still.length > 0) warn(`после генерации всё ещё нет: ${still.join(", ")}`);

console.log(`[иконки] Готово: ${REQUIRED.length} файлов в src-tauri/icons\n`);

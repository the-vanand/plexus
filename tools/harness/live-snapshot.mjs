/**
 * СНИМОК ЖИВОГО САЙТА НАСТОЯЩИМ БРАУЗЕРОМ.
 *
 * Зачем нужен отдельно от приложения: путь «снимок → сцена» до сих пор
 * проверялся на одном замороженном файле `fixtures/snapshots/cospex-1920.json`.
 * Сам СБОРЩИК при этом не проверялся никогда — он исполняется внутри чужой
 * страницы, а в стенде подставлялся уже готовый результат. То есть половина
 * пути была вне досягаемости проверок, и ошибка в ней выглядела бы как
 * «снимок не получается», без единой цифры.
 *
 * Этот скрипт запускает Chromium, исполняет в нём РОВНО ТОТ ЖЕ текст
 * сборщика, что уходит в webview приложения (`collectorScript()`), и
 * сохраняет результат как фикстуру. Дальше её разбирает `snapshot-check.ts`.
 *
 * Инструмент не входит в `npm run check`: он требует браузера (~115 МБ) и
 * сети, а арбитр обязан работать всюду и быстро. Ставится отдельно:
 *
 *   npx playwright-core install chromium
 *   node tools/harness/live-snapshot.mjs https://example.com [ширина] [имя]
 *
 * Результат: fixtures/snapshots/<имя>.json + краткая сводка в консоль.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

/* Текст сборщика берём из исходника проекта, а не копируем: копия
   разошлась бы с приложением, и стенд проверял бы не то, что работает. */
const { collectorScript } = await import("tsx/esm/api").then(async (api) => {
  const unregister = api.register();
  try {
    return await import(new URL("../../src/core/snapshot.ts", import.meta.url).href);
  } finally {
    unregister();
  }
});

const url = process.argv[2];
if (!url) {
  console.error("Использование: node tools/harness/live-snapshot.mjs <url> [ширина] [имя]");
  process.exit(2);
}
const width = Number(process.argv[3] || 1440);
const name = process.argv[4] || new URL(url).hostname.replace(/[^\w.-]/g, "_") + `-${width}`;
const out = join(process.cwd(), "fixtures", "snapshots", `${name}.json`);

const t0 = Date.now();
const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({
  viewport: { width, height: 900 },
  /* Тема берётся из окружения: PLX_SCHEME=dark снимает тёмную схему.
     Webview в приложении следует теме СИСТЕМЫ пользователя, и снимок
     стенда обязан уметь то же — иначе дефекты тёмных фонов не
     воспроизводятся. */
  colorScheme: process.env.PLX_SCHEME === "dark" ? "dark" : "light",
  /* Реальный UA: часть сайтов отдаёт headless-браузеру урезанную версию,
     и тогда снимок описывал бы не ту страницу, которую увидит человек. */
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
});

let snapshot;
let error = "";
try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  /* Сборщик сам ждёт шрифты и гидратацию; здесь только страхуем сеть. */
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  snapshot = await page.evaluate(collectorScript({ maxNodes: 4000, settleMs: 1200 }));
} catch (e) {
  error = String(e?.message ?? e);
} finally {
  await browser.close();
}

if (error || !snapshot) {
  console.error(`\n✗ Снимок не получен: ${error || "сборщик вернул пустоту"}\n`);
  process.exit(1);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(snapshot));

const kb = (n) => `${(n / 1024).toFixed(0)} КБ`;
console.log(`\n▸ СНИМОК ${url}`);
console.log(`  узлов              ${snapshot.nodes.length}`);
console.log(`  пропущено скрытых  ${snapshot.skipped}`);
console.log(`  вьюпорт            ${snapshot.viewportWidth}×${snapshot.viewportHeight}`);
console.log(`  высота документа   ${snapshot.documentHeight}px`);
console.log(`  шрифты             ${snapshot.fonts.slice(0, 4).join(" · ") || "—"}`);
console.log(`  ждали сборки       ${snapshot.settleMs} мс`);
console.log(`  размер снимка      ${kb(JSON.stringify(snapshot).length)}`);
console.log(`  всего заняло       ${((Date.now() - t0) / 1000).toFixed(1)} с`);
console.log(`  сохранено          ${out}\n`);
console.log(
  `JSON ${JSON.stringify({
    nodes: snapshot.nodes.length,
    skipped: snapshot.skipped,
    docH: snapshot.documentHeight,
    fonts: snapshot.fonts.length,
    bytes: JSON.stringify(snapshot).length,
  })}\n`,
);
void require_;

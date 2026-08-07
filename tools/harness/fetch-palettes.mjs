/**
 * СБОРЩИК ПАЛИТР с color.romanuke.com (IN COLOR BALANCE).
 *
 * Собираются ТОЛЬКО hex-значения цветов (факты) и номер палитры —
 * ни изображений, ни текстов. Источник указывается в интерфейсе.
 *
 *   node tools/harness/fetch-palettes.mjs [страниц=300] [выход=src/assets/palettes.json]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const PAGES = Number(process.argv[2] || 300);
const OUT = process.argv[3] || "src/assets/palettes.json";
const UA = { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } };
const BASE = "https://color.romanuke.com";

const listUrl = (p) => (p === 1 ? `${BASE}/` : `${BASE}/page/${p}/`);

async function fetchText(url, tries = 3) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url, UA);
      if (r.ok) return await r.text();
    } catch { /* повтор */ }
    await new Promise((res) => setTimeout(res, 400 * (i + 1)));
  }
  return null;
}

/** Ссылки на палитры со страницы листинга. */
const postLinks = (html) =>
  [...new Set([...html.matchAll(/href="(https:\/\/color\.romanuke\.com\/czvetovaya-palitra-[^"]+)"/g)].map((m) => m[1]))];

/** Цвета палитры: якорь — data-clipboard-text, порядок сохраняется. */
const postColors = (html) => {
  const seen = new Set();
  const out = [];
  for (const m of html.matchAll(/data-clipboard-text="(#[0-9a-fA-F]{6})"/g)) {
    const hex = m[1].toUpperCase();
    if (!seen.has(hex)) { seen.add(hex); out.push(hex); }
  }
  return out;
};

const num = (url) => {
  // в URL номер идёт после закодированного знака № (%e2%84%96)
  const m = decodeURIComponent(url).match(/№(\d+)/);
  return m ? Number(m[1]) : null;
};

async function pool(items, worker, size) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx]);
    }
  }));
  return results;
}

const t0 = Date.now();
console.log(`листинги: 1..${PAGES}`);
const listPages = await pool(
  Array.from({ length: PAGES }, (_, i) => i + 1),
  async (p) => (await fetchText(listUrl(p))) ?? "",
  6,
);
const links = [...new Set(listPages.flatMap(postLinks))];
console.log(`палитр найдено: ${links.length}; качаю...`);

let done = 0;
const palettes = (
  await pool(links, async (url) => {
    const html = await fetchText(url);
    done += 1;
    if (done % 200 === 0) console.log(`  ${done}/${links.length}`);
    if (!html) return null;
    const colors = postColors(html);
    if (colors.length < 4) return null;
    return { n: num(url), colors: colors.slice(0, 5) };
  }, 6)
).filter(Boolean);

palettes.sort((a, b) => (b.n ?? 0) - (a.n ?? 0));
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ source: "color.romanuke.com", fetched: new Date().toISOString().slice(0, 10), palettes }));
console.log(`сохранено ${palettes.length} палитр в ${OUT} за ${Math.round((Date.now() - t0) / 1000)}с`);

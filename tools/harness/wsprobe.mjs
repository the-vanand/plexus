/**
 * ЗОНД ПО ЖИВОЙ СТРАНИЦЕ: ЗНАЧИМЫЕ ПРОБЕЛЫ И УСЕЧЕНИЕ.
 *
 * Стенд `glue.ts` судит уже готовую сцену, а здесь нужен ИСТОЧНИК истины,
 * независимый от нашего сборщика: браузер умеет измерить сам текстовый узел
 * (`Range.getBoundingClientRect`), а не только элемент. По этим коробкам
 * видно, где на странице реально стоит пробел между строчными соседями —
 * то есть чего именно недостаёт снимку.
 *
 * Второй ответ зонда — сколько узлов объявлено `text-overflow: ellipsis` и
 * сколько из них РЕАЛЬНО обрезано (`scrollWidth > clientWidth`).
 *
 *   node tools/harness/wsprobe.mjs <url> [ширина]
 */
import { chromium } from "playwright-core";

const url = process.argv[2];
if (!url) {
  console.error("Использование: node tools/harness/wsprobe.mjs <url> [ширина]");
  process.exit(2);
}
const width = Number(process.argv[3] || 1440);

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({
  viewport: { width, height: 900 },
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
});
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
await page.waitForTimeout(2500);

const res = await page.evaluate(() => {
  const out = {
    ellipsisDeclared: 0,
    ellipsisClipped: 0,
    ellipsisSamples: [],
    /** Элементы, чей собственный текст ТЕРЯЕТ значимый пробел при trim(). */
    edgeSpaceOwn: 0,
    edgeSpaceOnlyWs: 0,
    edgeSamples: [],
    /** Замер по текстовым узлам: пробел между соседями по строке. */
    gapPairs: 0,
    gapSamples: [],
  };
  const all = document.querySelectorAll("*");
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    if (cs.textOverflow === "ellipsis") {
      out.ellipsisDeclared += 1;
      if (el.scrollWidth > el.clientWidth + 1) {
        out.ellipsisClipped += 1;
        if (out.ellipsisSamples.length < 12) {
          out.ellipsisSamples.push({
            tag: el.tagName.toLowerCase(),
            cls: (el.className || "").toString().slice(0, 30),
            text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
            clientW: el.clientWidth,
            scrollW: el.scrollWidth,
            ws: cs.whiteSpace,
            ov: cs.overflow,
          });
        }
      }
    }
    /* Собственный текст: где пробел на краю значим (рядом стоит элемент). */
    const kidsCount = el.children.length;
    if (kidsCount === 0) continue;
    let ownRaw = "";
    let sawEl = false;
    let lostEdge = false;
    let onlyWs = true;
    for (const n of el.childNodes) {
      if (n.nodeType === 3) {
        const v = n.nodeValue || "";
        ownRaw += v;
        if (v.trim()) onlyWs = false;
        // пробел на стыке с элементом
        if (sawEl && /^\s/.test(v)) lostEdge = true;
      } else if (n.nodeType === 1) {
        if (/\s$/.test(ownRaw) && ownRaw) lostEdge = true;
        sawEl = true;
      }
    }
    if (!ownRaw) continue;
    if (lostEdge) {
      out.edgeSpaceOwn += 1;
      if (onlyWs) out.edgeSpaceOnlyWs += 1;
      if (out.edgeSamples.length < 14) {
        out.edgeSamples.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || "").toString().slice(0, 24),
          raw: JSON.stringify(ownRaw.slice(0, 40)),
          trimmed: JSON.stringify(ownRaw.replace(/\s+/g, " ").trim().slice(0, 40)),
          ws: cs.whiteSpace,
          onlyWs,
        });
      }
    }
  }

  /* Пробел между текстовыми узлами по коробкам Range: настоящая мера. */
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const runs = [];
  let t;
  while ((t = walker.nextNode())) {
    if (!(t.nodeValue || "").trim()) continue;
    const p = t.parentElement;
    if (!p) continue;
    const cs = getComputedStyle(p);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const rg = document.createRange();
    rg.selectNodeContents(t);
    const r = rg.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    runs.push({
      text: (t.nodeValue || "").replace(/\s+/g, " ").trim().slice(0, 24),
      x: Math.round(r.left + scrollX),
      y: Math.round(r.top + scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height),
    });
  }
  runs.sort((a, b) => a.y - b.y || a.x - b.x);
  for (let i = 0; i + 1 < runs.length; i += 1) {
    const a = runs[i];
    const b = runs[i + 1];
    if (Math.abs(a.y - b.y) > 3) continue;
    const gap = b.x - (a.x + a.w);
    if (gap >= 1 && gap <= 12) {
      out.gapPairs += 1;
      if (out.gapSamples.length < 10) out.gapSamples.push({ a: a.text, b: b.text, gap });
    }
  }
  out.textRuns = runs.length;
  return out;
});
await browser.close();
console.log(JSON.stringify(res, null, 1));

/**
 * СТЕНД АДАПТИВНЫХ БРЕЙКПОИНТОВ.
 *
 * Проверяет не «открылось без ошибок», а числа: где раскладка ОБЯЗАНА
 * измениться, а где обязана остаться прежней, сколько медиазапросов вышло из
 * кодогена и что именно попало внутрь блоков.
 *
 * Три утверждения, которые здесь доказываются:
 *  1. Раскладка на 640 отличается ровно там, где задано переопределение, и
 *     совпадает с базой там, где не задано.
 *  2. Каскад: значение с планшета доезжает до телефона, если на телефоне не
 *     переопределено явно.
 *  3. Документ без брейкпоинтов даёт CSS, идентичный документу вообще без
 *     переопределений — ни одного лишнего байта.
 *
 *   npx tsx tools/harness/breakpoints.ts
 */
import { computeLayout } from "../../src/core/layout";
import { generateProject } from "../../src/core/codegen";
import {
  DEFAULT_BREAKPOINTS, breakpointForWidth, createNode, hasOverride, normalizeDoc, overrideCount,
  previousBreakpointId, RESPONSIVE_LAYOUT_KEYS, resolveNodeAt, setOverride, splitResponsivePatch,
} from "../../src/core/scene";
import type { SceneDocument, SceneNode } from "../../src/core/types";
import { DEFAULT_THEME } from "../../src/core/themes";
import { measureStub } from "./measure-stub";

const TABLET = "bp-tablet";
const PHONE = "bp-phone";
const PAGE_W = 1200;
const PAD = 48;
const GAP = 24;

let failures = 0;
const rows: Array<[string, string, string, boolean]> = [];

/** Утверждение с числами: попадает в таблицу отчёта. */
const check = (name: string, actual: unknown, expected: unknown): void => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  rows.push([name, String(JSON.stringify(actual)).replace(/"/g, ""), String(JSON.stringify(expected)).replace(/"/g, ""), ok]);
};

/* ------------------------------------------------------------------ */
/* Документ стенда                                                     */
/* ------------------------------------------------------------------ */

/**
 * Страница: заголовок, сетка из трёх карточек, баннер.
 * Переопределения расставлены так, чтобы каждое проверяемое свойство было
 * видно в числах: сетка меняет колонки, заголовок — кегль (только на
 * планшете, телефон обязан его унаследовать), баннер скрывается на телефоне.
 */
function buildDoc(): { doc: SceneDocument; ids: Record<string, string> } {
  const doc: SceneDocument = {
    nodes: {}, rootFrames: [], wires: [], components: {},
    theme: { ...DEFAULT_THEME }, dbTables: {}, dbRelations: [],
    dbProvider: "sqlite", siteTarget: "static",
    breakpoints: DEFAULT_BREAKPOINTS.map((b) => ({ ...b })),
  };
  const add = (node: SceneNode, parent: SceneNode | null): SceneNode => {
    node.parent = parent?.id ?? null;
    doc.nodes[node.id] = node;
    if (parent) parent.children.push(node.id);
    else doc.rootFrames.push(node.id);
    return node;
  };

  const frame = createNode("frame", "Главная");
  frame.layout = { ...frame.layout, x: 0, y: 0, width: PAGE_W, height: 800, direction: "column", padding: 0, gap: 0 };
  add(frame, null);

  const title = createNode("text", "Заголовок");
  title.text = "Собирай сайты как схемы";
  title.style = { ...title.style, fontSize: 48, fontWeight: 700 };
  title.layout = { ...title.layout, width: "fill" };
  // кегль задан ТОЛЬКО на планшете: телефон должен унаследовать 32 по каскаду
  title.responsive = { [TABLET]: { style: { fontSize: 32 } } };
  add(title, frame);

  const grid = createNode("container", "Сетка");
  grid.layout = {
    ...grid.layout, width: "fill", direction: "row", padding: PAD, gap: GAP,
    gridTracks: [{ fr: 1 }, { fr: 1 }, { fr: 1 }], columns: 3, preset: "columns",
  };
  // планшет — две колонки, телефон — одна. padding и gap НЕ переопределены
  // нигде: они обязаны остаться базовыми на всех ширинах.
  grid.responsive = {
    [TABLET]: { layout: { gridTracks: [{ fr: 1 }, { fr: 1 }], columns: 2 } },
    [PHONE]: { layout: { gridTracks: [{ fr: 1 }], columns: 1 } },
  };
  add(grid, frame);

  const cards: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const card = createNode("container", `Карточка ${i}`);
    card.layout = { ...card.layout, width: "fill", height: 120, direction: "column", padding: 0, gap: 0 };
    add(card, grid);
    cards.push(card.id);
  }

  const banner = createNode("text", "Баннер");
  banner.text = "Только для широких экранов";
  banner.layout = { ...banner.layout, width: "fill" };
  banner.responsive = { [PHONE]: { hidden: true } };
  add(banner, frame);

  const footer = createNode("text", "Подпись");
  footer.text = "Подпись";
  footer.layout = { ...footer.layout, width: "fill" };
  add(footer, frame);

  return { doc, ids: { frame: frame.id, title: title.id, grid: grid.id, card1: cards[0], banner: banner.id, footer: footer.id } };
}

const { doc, ids } = buildDoc();

/* ------------------------------------------------------------------ */
/* 1. Раскладка: где меняется и где нет                                */
/* ------------------------------------------------------------------ */

const base = computeLayout(doc, measureStub);
const atTablet = computeLayout(doc, measureStub, { width: 1024 });
const atPhone = computeLayout(doc, measureStub, { width: 640 });

/** Ширина карточки при N колонках внутри сетки заданной ширины. */
const cardW = (frameW: number, cols: number) => (frameW - PAD * 2 - GAP * (cols - 1)) / cols;

const cardAt = (m: Map<string, { x: number; y: number; w: number; h: number }>) => m.get(ids.card1)!;

check("ширина фрейма: база", base.get(ids.frame)!.w, PAGE_W);
check("ширина фрейма: 640", atPhone.get(ids.frame)!.w, 640);

check("карточка: база = 3 колонки", Math.round(cardAt(base).w), Math.round(cardW(PAGE_W, 3)));
check("карточка: 1024 = 2 колонки", Math.round(cardAt(atTablet).w), Math.round(cardW(1024, 2)));
check("карточка: 640 = 1 колонка", Math.round(cardAt(atPhone).w), Math.round(cardW(640, 1)));

// НЕ переопределённый padding сетки обязан остаться 48 на всех ширинах:
// смещение первой карточки от левого края страницы это доказывает численно
check(
  "отступ сетки не тронут (база/1024/640)",
  [cardAt(base).x, cardAt(atTablet).x, cardAt(atPhone).x],
  [PAD, PAD, PAD],
);
// высота карточки задана числом и не переопределена — не меняется
check(
  "высота карточки не тронута",
  [cardAt(base).h, cardAt(atTablet).h, cardAt(atPhone).h],
  [120, 120, 120],
);

/* КАСКАД: телефон наследует кегль планшета. */
check("кегль заголовка: база", resolveNodeAt(doc.nodes[ids.title], doc.breakpoints, null).style.fontSize, 48);
check("кегль заголовка: 1024", resolveNodeAt(doc.nodes[ids.title], doc.breakpoints, TABLET).style.fontSize, 32);
check("кегль заголовка: 640 (по каскаду)", resolveNodeAt(doc.nodes[ids.title], doc.breakpoints, PHONE).style.fontSize, 32);
// и то же самое в геометрии: высота строки на 640 равна высоте при кегле 32
const titleH32 = Math.ceil(32 * 1.32);
check("высота заголовка на 640 = кегль 32", atPhone.get(ids.title)!.h, titleH32);
check("высота заголовка на базе ≠ кегль 32", base.get(ids.title)!.h === titleH32, false);

/* КАСКАД: колонки на телефоне переопределены явно и планшетные НЕ протекают. */
check("колонки сетки: 640", resolveNodeAt(doc.nodes[ids.grid], doc.breakpoints, PHONE).layout.columns, 1);

/* СКРЫТИЕ: узел исчезает из раскладки. */
check("баннер есть в базе", base.has(ids.banner), true);
check("баннер есть на 1024", atTablet.has(ids.banner), true);
check("баннер скрыт на 640", atPhone.has(ids.banner), false);

/* Автовыбор брейкпоинта по ширине — как в CSS: побеждает самый узкий. */
check("брейкпоинт при 1920", breakpointForWidth(doc.breakpoints, 1920)?.id ?? null, null);
check("брейкпоинт при 1024", breakpointForWidth(doc.breakpoints, 1024)?.id ?? null, TABLET);
check("брейкпоинт при 600", breakpointForWidth(doc.breakpoints, 600)?.id ?? null, PHONE);

/* ОБРАТНАЯ СОВМЕСТИМОСТЬ: два аргумента = база, байт-в-байт. */
check(
  "computeLayout(doc, measure) == база",
  JSON.stringify([...computeLayout(doc, measureStub)]) === JSON.stringify([...base]),
  true,
);

/* ------------------------------------------------------------------ */
/* 2. Кодоген: медиазапросы                                            */
/* ------------------------------------------------------------------ */

const cssOf = (d: SceneDocument): string => {
  const files = generateProject(d, "Стенд брейкпоинтов").files;
  return Object.entries(files).find(([p]) => p.endsWith(".css"))![1];
};

const css = cssOf(doc);
const mediaHeads = css.match(/@media \(max-width: \d+px\)/g) ?? [];
check("медиазапросов = брейкпоинтов", mediaHeads.length, doc.breakpoints.length);
check("порядок: широкий → узкий", mediaHeads, ["@media (max-width: 1024px)", "@media (max-width: 640px)"]);

/** Содержимое блока @media по его maxWidth. */
const mediaBody = (maxWidth: number): string => {
  const start = css.indexOf(`@media (max-width: ${maxWidth}px)`);
  if (start < 0) return "";
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return "";
};

const tabletBody = mediaBody(1024);
const phoneBody = mediaBody(640);

/** Свойства, объявленные внутри блока (без вложенных селекторов). */
const propsIn = (body: string): string[] =>
  [...body.matchAll(/^\s{4}([a-z-]+):/gm)].map((m) => m[1]).sort();

/* ТОЛЬКО ПЕРЕОПРЕДЕЛЁННОЕ. У заголовка на планшете изменился ровно кегль —
   значит в блоке ровно одна декларация font-size, а не копия всего правила. */
const titleRule = (body: string): string => {
  const m = body.match(/\.zagolovok \{([^}]*)\}/);
  return m ? m[1] : "";
};
check("заголовок на 1024: только font-size", propsIn(titleRule(tabletBody)), ["font-size"]);
check("заголовок на 640: нет правила (кегль унаследован)", titleRule(phoneBody).trim(), "");

/* У сетки изменились только дорожки. */
const gridRule = (body: string): string => {
  const m = body.match(/\.setka \{([^}]*)\}/);
  return m ? m[1] : "";
};
check("сетка на 1024: только grid-template-columns", propsIn(gridRule(tabletBody)), ["grid-template-columns"]);
check("сетка на 640: только grid-template-columns", propsIn(gridRule(phoneBody)), ["grid-template-columns"]);
// дорожки печатаются как minmax(0, Nfr) — иначе min-content раздувает колонку
check("дорожек на 640", (gridRule(phoneBody).match(/minmax\(0, 1fr\)/g) ?? []).length, 1);
check("дорожек на 1024", (gridRule(tabletBody).match(/minmax\(0, 1fr\)/g) ?? []).length, 2);

/* Скрытие → display:none, и только на телефоне. */
check("баннер: display:none на 640", /\.banner \{\s*display: none;\s*\}/.test(phoneBody), true);
check("баннер: ничего на 1024", /\.banner \{/.test(tabletBody), false);

/* Узел без переопределений не должен появляться в медиазапросах вообще. */
check("подпись отсутствует в @media", /\.podpis \{/.test(tabletBody + phoneBody), false);

/* Блоки — дельта, а не копия: правил в @media заметно меньше, чем в базе. */
const baseRuleCount = (css.slice(0, css.indexOf("@media")).match(/^\.[a-z0-9-]+ \{/gm) ?? []).length;
const mediaRuleCount = (tabletBody + phoneBody).match(/^\s{2}\.[a-z0-9-]+ \{/gm)?.length ?? 0;
check("правил в @media меньше, чем в базе", mediaRuleCount < baseRuleCount, true);

/* ------------------------------------------------------------------ */
/* 3. Документ без брейкпоинтов: CSS обязан не измениться               */
/* ------------------------------------------------------------------ */

/* Эталон — та же страница, из которой вырезаны и брейкпоинты, и сами
   переопределения. Если сравнение байт-в-байт проходит, значит адаптивность
   не подмешивает в базовые правила ни одного символа. */
const plainDoc = buildDoc().doc;
plainDoc.breakpoints = [];
for (const n of Object.values(plainDoc.nodes)) delete n.responsive;
const plainCss = cssOf(plainDoc);

const noBpDoc = buildDoc().doc;
noBpDoc.breakpoints = [];
const noBpCss = cssOf(noBpDoc);

check("без брейкпоинтов: ни одного @media", noBpCss.includes("@media"), false);
check("без брейкпоинтов: CSS байт-в-байт как без переопределений", noBpCss === plainCss, true);
check("байт в CSS совпало", noBpCss.length, plainCss.length);

/* ------------------------------------------------------------------ */
/* 4. Миграция старого сохранения                                      */
/* ------------------------------------------------------------------ */

const legacy = buildDoc().doc as Partial<SceneDocument>;
delete legacy.breakpoints;
const migrated = normalizeDoc(legacy as SceneDocument);
check("старое сохранение: breakpoints = []", migrated.breakpoints, []);
check("старое сохранение: раскладка считается", computeLayout(migrated, measureStub).size > 0, true);
check("старое сохранение: CSS без @media", cssOf(migrated).includes("@media"), false);

/* Порядок брейкпоинтов нормализуется даже если в файле он был перевёрнут. */
const unsorted = buildDoc().doc;
unsorted.breakpoints = [{ id: PHONE, name: "Телефон", maxWidth: 640 }, { id: TABLET, name: "Планшет", maxWidth: 1024 }];
check("порядок брейкпоинтов после миграции", normalizeDoc(unsorted).breakpoints.map((b) => b.maxWidth), [1024, 640]);

/* ------------------------------------------------------------------ */
/* 5. Запись переопределений (механика инспектора)                      */
/* ------------------------------------------------------------------ */

/* Стор здесь не поднимаем (он тянет Tauri и localStorage) — проверяем те же
   чистые функции, через которые он пишет переопределения. */
const wDoc = buildDoc();
const wNode = wDoc.doc.nodes[wDoc.ids.footer];

// адаптивное уходит в переопределение, неадаптивное (координаты) — в базу
const split = splitResponsivePatch({ gap: 8, x: 40, rotation: 15 }, RESPONSIVE_LAYOUT_KEYS);
check("патч: адаптивная часть", Object.keys(split.override), ["gap"]);
check("патч: в базу", Object.keys(split.base).sort(), ["rotation", "x"]);

setOverride(wNode, PHONE, "layout", split.override as Record<string, unknown>);
check("переопределение записано", wNode.responsive?.[PHONE]?.layout?.gap, 8);
check("hasOverride видит его", hasOverride(wNode, PHONE, "layout", "gap"), true);
check("hasOverride не врёт про базу", hasOverride(wNode, null, "layout", "gap"), false);
check("overrideCount", overrideCount(wNode, PHONE), 1);

// снятие переопределения (чип «✕» в инспекторе) чистит и пустые контейнеры
setOverride(wNode, PHONE, "layout", { gap: undefined });
check("переопределение снято", wNode.responsive, undefined);

// диффование пресетов: предыдущее звено каскада для телефона — планшет
check("предыдущее звено для 640", previousBreakpointId(doc.breakpoints, PHONE), TABLET);
check("предыдущее звено для 1024", previousBreakpointId(doc.breakpoints, TABLET), null);

/* ------------------------------------------------------------------ */
/* Отчёт                                                               */
/* ------------------------------------------------------------------ */

console.log(`\n${"═".repeat(78)}`);
console.log("  АДАПТИВНЫЕ БРЕЙКПОИНТЫ");
console.log("═".repeat(78));

console.log(`\n▸ РАСКЛАДКА ПО ШИРИНАМ (страница ${PAGE_W}, padding ${PAD}, gap ${GAP})`);
console.log(`  ${"ширина вьюпорта".padEnd(20)}${"колонок".padStart(9)}${"карточка".padStart(10)}${"кегль h1".padStart(10)}${"баннер".padStart(9)}`);
console.log("  " + "─".repeat(58));
for (const [label, w, map] of [
  ["база (1200)", PAGE_W, base],
  ["1024", 1024, atTablet],
  ["640", 640, atPhone],
] as Array<[string, number, typeof base]>) {
  const bp = w === PAGE_W ? null : breakpointForWidth(doc.breakpoints, w)?.id ?? null;
  const cols = resolveNodeAt(doc.nodes[ids.grid], doc.breakpoints, bp).layout.gridTracks!.length;
  const fs = resolveNodeAt(doc.nodes[ids.title], doc.breakpoints, bp).style.fontSize;
  console.log(
    `  ${label.padEnd(20)}${String(cols).padStart(9)}${String(Math.round(cardAt(map).w) + "px").padStart(10)}${String(fs + "px").padStart(10)}${(map.has(ids.banner) ? "виден" : "скрыт").padStart(9)}`,
  );
}

console.log(`\n▸ КОДОГЕН`);
console.log(`  базовых правил          ${baseRuleCount}`);
console.log(`  правил в @media         ${mediaRuleCount}  (дельта, не копия)`);
console.log(`  медиазапросов           ${mediaHeads.length} из ${doc.breakpoints.length} брейкпоинтов`);
console.log(`  объявлений на 1024      ${propsIn(tabletBody).length}  [${propsIn(tabletBody).join(" ")}]`);
console.log(`  объявлений на 640       ${propsIn(phoneBody).length}  [${propsIn(phoneBody).join(" ")}]`);
console.log(`  CSS с адаптивностью     ${css.length} байт`);
console.log(`  CSS без брейкпоинтов    ${noBpCss.length} байт  (эталон ${plainCss.length})`);

console.log(`\n▸ ПРОВЕРКИ`);
console.log(`  ${"утверждение".padEnd(46)}${"получено".padStart(14)}${"ожидалось".padStart(14)}`);
console.log("  " + "─".repeat(74));
for (const [name, actual, expected, ok] of rows) {
  console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(44)}${actual.slice(0, 13).padStart(14)}${expected.slice(0, 13).padStart(14)}`);
}

console.log(`\n  ИТОГ: провалено ${failures} из ${rows.length}`);
console.log(`\nJSON ${JSON.stringify({
  checks: rows.length,
  failed: failures,
  media: mediaHeads.length,
  breakpoints: doc.breakpoints.length,
  baseRules: baseRuleCount,
  mediaRules: mediaRuleCount,
  declsTablet: propsIn(tabletBody).length,
  declsPhone: propsIn(phoneBody).length,
  cssBytes: css.length,
  cssBytesNoBp: noBpCss.length,
  cssBytesPlain: plainCss.length,
})}\n`);

if (failures > 0) process.exit(1);

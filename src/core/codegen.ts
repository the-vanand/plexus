/**
 * ГЕНЕРАТОР КОДА: scene graph → чистый, читаемый HTML + CSS.
 *
 * Принципы (см. README):
 *  1. Детерминизм: одна модель → байт-в-байт один и тот же вывод.
 *  2. Каждый элемент несёт якорь data-plx-id — фундамент будущей
 *     двусторонней синхронизации код ⇄ холст и маппинга ошибок.
 *  3. Auto-layout → flexbox почти 1:1; поворот → transform: rotate().
 *  4. Мультистраничность: каждый корневой фрейм = отдельная HTML-страница,
 *     общий styles.css на весь сайт (ориентир — сайт, а не «один слайд»).
 *  5. Связи («провода») компилируются в чистый script.js, а submit-связи
 *     дополнительно генерируют бэкенд: server/server.js без зависимостей.
 */
import type { DbTable, SceneDocument, SceneNode, Wire } from "./types";
import { googleFontsUrl, resolveTheme, tokenCssVar, type ResolvedTheme } from "./themes";
import { padBox, resolveNodeAt } from "./scene";

/* ------------------------------------------------------------------ */
/* Имена для Prisma: PascalCase моделей и camelCase полей              */
/* ------------------------------------------------------------------ */

function latinWord(name: string, fallback: string): string {
  let out = "";
  for (const ch of name) {
    if (/[a-zA-Z0-9_]/.test(ch)) out += ch;
  }
  return out || fallback;
}

const pascal = (name: string, fallback: string): string => {
  const w = latinWord(name, fallback);
  return w.charAt(0).toUpperCase() + w.slice(1);
};

const camel = (name: string, fallback: string): string => {
  const w = latinWord(name, fallback);
  return w.charAt(0).toLowerCase() + w.slice(1);
};

/** Модельные имена таблиц (уникальные). */
function prismaNames(doc: SceneDocument): Map<string, string> {
  const used = new Set<string>(["User", "Submission"]);
  const map = new Map<string, string>();
  for (const t of Object.values(doc.dbTables)) {
    let name = pascal(t.name, "Table");
    while (used.has(name)) name = `${name}X`;
    used.add(name);
    map.set(t.id, name);
  }
  return map;
}

/** Визуальная схема → prisma/schema.prisma. */
export function generatePrisma(doc: SceneDocument): string {
  const names = prismaNames(doc);
  const provider = doc.dbProvider === "postgres" ? "postgresql" : "sqlite";
  const url = doc.dbProvider === "postgres" ? `env("DATABASE_URL")` : `"file:./dev.db"`;

  const models = Object.values(doc.dbTables).map((t) => modelFor(doc, t, names)).join("\n\n");

  return `// Сгенерировано Plexus из визуальной схемы БД.
// Применить: npx prisma migrate dev --name init

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "${provider}"
  url      = ${url}
}

// Пользователи (блоки авторизации Plexus)
model User {
  id           Int      @id @default(autoincrement())
  email        String   @unique
  passwordHash String
  createdAt    DateTime @default(now())
}

// Отправки форм (провода «в бэкенд»)
model Submission {
  id        Int      @id @default(autoincrement())
  wire      String
  data      String
  createdAt DateTime @default(now())
}
${models ? `\n${models}\n` : ""}`;
}

function modelFor(doc: SceneDocument, t: DbTable, names: Map<string, string>): string {
  const model = names.get(t.id)!;
  const usedFields = new Set(["id", "createdAt"]);
  const lines: string[] = [
    `  id        Int      @id @default(autoincrement())`,
  ];
  for (const f of t.fields) {
    let fname = camel(f.name, "field");
    while (usedFields.has(fname)) fname = `${fname}X`;
    usedFields.add(fname);
    lines.push(`  ${fname} ${f.type}${f.required ? "" : "?"}`);
  }
  // связи: этот стол — «многие» (child): ссылка на родителя
  for (const rel of doc.dbRelations.filter((r) => r.toTableId === t.id)) {
    const parent = names.get(rel.fromTableId);
    if (!parent) continue;
    const base = camel(parent, "parent");
    lines.push(`  ${base} ${parent}? @relation(fields: [${base}Id], references: [id])`);
    lines.push(`  ${base}Id Int?`);
  }
  // этот стол — «один» (parent): массив детей
  for (const rel of doc.dbRelations.filter((r) => r.fromTableId === t.id)) {
    const child = names.get(rel.toTableId);
    if (!child) continue;
    lines.push(`  ${camel(child, "child")}s ${child}[]`);
  }
  lines.push(`  createdAt DateTime @default(now())`);
  return `model ${model} {\n${lines.join("\n")}\n}`;
}

export interface GeneratedProject {
  /** Относительный путь в папке site/ → содержимое файла. */
  files: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* Имена классов и путей: транслитерация                               */
/* ------------------------------------------------------------------ */

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
};

function slugify(name: string): string {
  const lower = name.toLowerCase();
  let out = "";
  for (const ch of lower) {
    if (/[a-z0-9]/.test(ch)) out += ch;
    else if (TRANSLIT[ch] !== undefined) out += TRANSLIT[ch];
    else if (/[\s_-]/.test(ch)) out += "-";
  }
  return out.replace(/-+/g, "-").replace(/^-|-$/g, "") || "page";
}

/* ------------------------------------------------------------------ */
/* CSS                                                                 */
/* ------------------------------------------------------------------ */

type Decl = [prop: string, value: string];

/** Цвет для CSS: токен → var(--c-*), hex — как есть. */
const cssColor = (value: string): string => tokenCssVar(value) ?? value;

/** hex + альфа → rgba(): полупрозрачные шапки и градиентные шторки. */
function withAlpha(value: string, alpha: number): string {
  const resolved = tokenCssVar(value);
  if (resolved) return resolved; // токен темы — альфу не навязываем
  const m = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return value;
  const n = parseInt(m[1], 16);
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 100) / 100;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Пропорция числом → аккуратная CSS-запись (16/9 вместо 1.7778). */
function ratioCss(ratio: number): string {
  const known: Array<[number, string]> = [
    [16 / 9, "16 / 9"], [4 / 3, "4 / 3"], [3 / 2, "3 / 2"], [1, "1 / 1"],
    [21 / 9, "21 / 9"], [9 / 16, "9 / 16"], [2 / 3, "2 / 3"], [3 / 4, "3 / 4"],
  ];
  const hit = known.find(([v]) => Math.abs(v - ratio) < 0.01);
  return hit ? hit[1] : `${Math.round(ratio * 1000)} / 1000`;
}

/**
 * Путь к ассету в СОБРАННОМ сайте.
 *
 * Раньше условие включало ведущий `/`, и путь файловой системы вида
 * `/home/user/proj/assets/hero.jpeg` уезжал в разметку дословно. Такой сайт
 * нельзя отдать заказчику: на другой машине картинок нет, а заодно наружу
 * утекает раскладка каталогов автора. На Windows баг не проявлялся —
 * `C:\…` не совпадал с условием и попадал в ветку с basename, то есть
 * поведение ещё и расходилось между платформами.
 *
 * Правило теперь одно: настоящие адреса оставляем как есть, всё остальное —
 * локальный файл, который экспорт кладёт в `site/assets`, поэтому и ссылка
 * должна быть `assets/<имя>`.
 *
 * Протокол-относительный `//cdn.example.com/x.png` — тоже настоящий адрес,
 * хотя и начинается со слэша; его обязательно сохранить, иначе сломается
 * импорт сайтов, которые так ссылаются на CDN.
 */
function assetHref(src: string): string {
  const s = src.trim();
  if (!s) return s;
  if (/^(https?:|data:|blob:)/i.test(s) || s.startsWith("//")) return s;
  if (s.startsWith("assets/")) return s;
  const file = s.split(/[\\/]/).pop() ?? s;
  return `assets/${file}`;
}

function cssForNode(node: SceneNode, parent: SceneNode | null, theme: ResolvedTheme): Decl[] {
  const d: Decl[] = [];
  const { layout, style } = node;
  const isBox = node.type === "frame" || node.type === "container";
  void theme;

  if (isBox) {
    // сетка выводится настоящим CSS Grid — экспорт повторяет исходную вёрстку,
    // а не приближает её флексом в один ряд
    if (layout.autoGrid) {
      /* НАСТОЯЩАЯ адаптивная сетка: браузер сам пересчитает колонки при любой
         ширине, без единого медиазапроса. Решатель на холсте считает то же
         число колонок, поэтому макет и код совпадают. */
      const { minColumnWidth, mode } = layout.autoGrid;
      d.push(["display", "grid"]);
      /* Именно `minmax(Xpx, 1fr)`, без обёртки `min(Xpx, 100%)`: процент
         внутри minmax разрешается от неопределённой базы при подсчёте дорожек,
         и число колонок выходит меньше расчётного — ряд логотипов вставал
         лестницей вместо одной линии. От переполнения на узком экране
         защищает min-width:0 у детей. */
      d.push(["grid-template-columns", `repeat(${mode}, minmax(${Math.round(minColumnWidth)}px, 1fr))`]);
      const rg = layout.rowGap ?? layout.gap;
      if (rg > 0 || layout.gap > 0) d.push(["gap", rg === layout.gap ? `${layout.gap}px` : `${rg}px ${layout.gap}px`]);
    } else if (layout.preset === "masonry") {
      // кладка средствами CSS-колонок: короче и надёжнее grid-имитаций
      d.push(["columns", `${Math.max(1, layout.columns ?? 3)}`]);
      d.push(["column-gap", `${layout.gap}px`]);
      d.push(["orphans", "1"]);
      d.push(["widows", "1"]);
    } else if (layout.gridTracks && layout.gridTracks.length > 0) {
      d.push(["display", "grid"]);
      // minmax(0, Nfr), а не просто Nfr: автоминимум grid-ячейки равен
      // min-content, и одна широкая картинка внутри раздувает всю колонку
      // (на COSPEX из-за этого страница уезжала на 260px вправо)
      d.push([
        "grid-template-columns",
        layout.gridTracks
          .map((t) => (t.px !== undefined ? `${Math.round(t.px)}px` : `minmax(0, ${t.fr ?? 1}fr)`))
          .join(" "),
      ]);
      const rg = layout.rowGap ?? layout.gap;
      if (rg > 0 || layout.gap > 0) d.push(["gap", rg === layout.gap ? `${layout.gap}px` : `${rg}px ${layout.gap}px`]);
    } else {
      d.push(["display", "flex"]);
      d.push(["flex-direction", layout.reverse ? `${layout.direction}-reverse` : layout.direction]);
      if (layout.wrap) d.push(["flex-wrap", "wrap"]);
      const rg = layout.rowGap;
      if (layout.gap > 0) d.push(["gap", rg !== undefined && rg !== layout.gap ? `${rg}px ${layout.gap}px` : `${layout.gap}px`]);
    }
    const pad = padBox(layout.padding);
    if (pad.t || pad.r || pad.b || pad.l) {
      d.push([
        "padding",
        pad.t === pad.r && pad.r === pad.b && pad.b === pad.l
          ? `${pad.t}px`
          : `${pad.t}px ${pad.r}px ${pad.b}px ${pad.l}px`,
      ]);
    }
    if (layout.align !== "start") {
      const amap = { center: "center", end: "flex-end", stretch: "stretch", baseline: "baseline" } as const;
      d.push(["align-items", amap[layout.align as keyof typeof amap] ?? "flex-start"]);
    }
    if (layout.justify !== "start") {
      const map = {
        center: "center", end: "flex-end", between: "space-between",
        around: "space-around", evenly: "space-evenly",
      } as const;
      d.push(["justify-content", map[layout.justify as keyof typeof map]]);
    }
    if (node.children.length > 0) d.push(["position", "relative"]);
  }

  const parentDir = parent?.layout.direction ?? "column";
  /* Родитель-сетка — это не только явные дорожки: авто-сетка и кладка тоже
     сетки. Раньше проверялись только gridTracks, поэтому детям авто-сетки
     уходил бессмысленный `flex: 1` без `min-width: 0` — и одна широкая
     картинка раздувала дорожку, ломая ряд логотипов в лестницу. */
  const parentIsGrid = !!parent?.layout.gridTracks || !!parent?.layout.autoGrid;
  const parentIsMasonry = parent?.layout.preset === "masonry";
  const abs = layout.position === "absolute";
  // растяжка по inset задаёт размер сама: width/height обязаны остаться auto,
  // иначе к left/right добавляется ещё и ширина — и блок вылезает за родителя
  const stretchedX = abs && layout.right !== null && layout.right !== undefined;
  const stretchedY = abs && layout.bottom !== null && layout.bottom !== undefined;
  const emitSize = (axis: "width" | "height", mode: typeof layout.width) => {
    if (typeof mode === "number") d.push([axis, `${mode}px`]);
    else if (mode === "fill") {
      if (abs) {
        d.push([axis, "100%"]);
        return;
      }
      // в сетке и кладке размер диктует дорожка, а не flex
      if (parentIsGrid || parentIsMasonry) {
        if (axis === "width") d.push(["width", "100%"]);
        else d.push(["height", "100%"]);
        return;
      }
      const isMainAxis = (parentDir === "row") === (axis === "width");
      if (isMainAxis) d.push(["flex", "1"]);
      else d.push(["align-self", "stretch"]);
    }
  };
  if (node.type !== "frame") {
    /* Растяжка по inset: задаём 100%, а НЕ auto. У заменяемых элементов
       (img) `width:auto` при заданных left+right берёт собственный размер
       картинки, а не ширину родителя — фото-подложка обрезалась по своей
       натуральной ширине вместо того, чтобы закрыть секцию целиком. */
    if (stretchedX) d.push(["width", "100%"]);
    else emitSize("width", layout.width);
    if (stretchedY) d.push(["height", "100%"]);
    else emitSize("height", layout.height);
    // ребёнок сетки: min-width:0 снимает автоминимум, иначе длинное слово
    // или картинка ломают колонку
    if (parentIsGrid) d.push(["min-width", "0"]);
    // в кладке элемент не должен разрываться между колонками
    if (parentIsMasonry) d.push(["break-inside", "avoid"]);
  }
  // колонка страницы: max-width + центрирование — то, чего в модели не было
  if (layout.maxWidth !== undefined) d.push(["max-width", `${Math.round(layout.maxWidth)}px`]);
  /* Потолок высоты без `overflow` бессмысленен: содержимое просто вылезло бы
     наружу. Пара «max-height + overflow:auto» и есть прокручиваемая коробка. */
  if (layout.maxHeight !== undefined) {
    d.push(["max-height", `${Math.round(layout.maxHeight)}px`]);
    /* У обрезанного многоточием узла прокрутка была бы неправдой: браузер
       содержимое СРЕЗАЛ, а не спрятал под скроллбар. */
    if (!layout.ellipsis) d.push(["overflow", "auto"]);
  }
  /* Строка, которую оригинал не переносил (см. `LayoutProps.noWrap`): в
     экспорте это ровно `white-space: nowrap`, иначе экспорт разошёлся бы с
     холстом на лишнюю строку. */
  if (layout.noWrap) d.push(["white-space", "nowrap"]);
  /* Усечение многоточием — это ровно тройка свойств, и она выразима в CSS
     один в один (см. `LayoutProps.ellipsis`). `white-space: nowrap` уже
     стоит выше: обрезка без него потеряла бы смысл — текст перенёсся бы. */
  if (layout.ellipsis) {
    d.push(["overflow", "hidden"]);
    d.push(["text-overflow", "ellipsis"]);
    if (!layout.noWrap) d.push(["white-space", "nowrap"]);
  }
  // лента с горизонтальной прокруткой: не переносится и не сжимается
  if (layout.scrollX) {
    d.push(["overflow-x", "auto"]);
    d.push(["flex-wrap", "nowrap"]);
  }
  /**
   * ВЫЧИСЛЕННЫЙ ОТСТУП ВЫВОДИТСЯ ПОСЛЕ СБРОСА БРАУЗЕРНОГО, А НЕ ДО.
   *
   * `<p>`, `<ul>`, `<hr>`, `<blockquote>` приходят с отступом от таблицы
   * стилей браузера, и модель его снимает: `margin: 0`. Но этот сброс
   * попадал в тот же список объявлений ПОСЛЕ вычисленного отступа и по
   * каскаду побеждал — то есть экспорт терял КАЖДЫЙ отступ у надписи.
   * А именно отступом выражен просвет между строчными соседями
   * (`noteInlineLead`): пробел разметки между двумя `<a>` не описан ни
   * одним свойством, он измерен и записан левым отступом. На импорте
   * страницы GitHub так обнулялись 79 отступов из 79, и в сгенерированной
   * странице строка слипалась в «Merge pull request#16from the-vanand/…»,
   * хотя на холсте она стояла верно.
   *
   * Порядок здесь единственное, что менялось: оба объявления как были, так
   * и остаются (сброс нужен и при своём отступе — он снимает браузерные
   * поля по осям, которых модель не задаёт), поменялась только их
   * очередь, и теперь по каскаду побеждает измеренное значение.
   */
  const emitMargin = (): void => {
    const mg = layout.margin;
    if (mg && (mg.t || mg.r || mg.b || mg.l)) {
      d.push(["margin", `${mg.t}px ${layout.centered ? "auto" : `${mg.r}px`} ${mg.b}px ${layout.centered ? "auto" : `${mg.l}px`}`]);
    } else if (layout.centered) d.push(["margin-inline", "auto"]);
  };
  /** Сброс браузерного отступа у тегов, которые его несут по умолчанию. */
  const resetMargin = (): void => {
    d.push(["margin", "0"]);
  };
  if (layout.gridSpan !== undefined || layout.gridColumn !== undefined) {
    const span = layout.gridSpan === "full" ? null : Math.max(1, layout.gridSpan ?? 1);
    const start = layout.gridColumn;
    d.push([
      "grid-column",
      span === null ? "1 / -1"
      : start !== undefined ? `${start} / span ${span}`
      : `span ${span}`,
    ]);
  }

  if (layout.position === "absolute") {
    d.push(["position", "absolute"]);
    d.push(["left", `${layout.x}px`]);
    d.push(["top", `${layout.y}px`]);
    // растяжка по inset: обе стороны заданы → фото-подложка на весь родитель
    if (layout.right !== null && layout.right !== undefined) d.push(["right", `${layout.right}px`]);
    if (layout.bottom !== null && layout.bottom !== undefined) d.push(["bottom", `${layout.bottom}px`]);
  }
  // Шапка: закрепление сверху (position: sticky) — как site-header у анализируемого сайта
  if (node.sticky) {
    d.push(["position", "sticky"]);
    d.push(["top", "0"]);
    d.push(["z-index", "50"]);
    d.push(["transition", "background .35s ease, backdrop-filter .35s ease"]);
  }

  // Поворот вокруг центра
  if (layout.rotation && layout.rotation !== 0) {
    d.push(["transform", `rotate(${layout.rotation}deg)`]);
  }

  if (style.fill !== "transparent" && node.type !== "text" && node.type !== "frame") {
    d.push(["background", style.fillAlpha !== undefined && style.fillAlpha < 1
      ? withAlpha(style.fill, style.fillAlpha)
      : cssColor(style.fill)]);
  }
  // градиент выводится ТОЧНЫМ исходным значением: на холсте он показан
  // усреднённым цветом, но в коде обязан остаться настоящим
  if (style.backgroundGradient) d.push(["background-image", style.backgroundGradient]);
  if (style.backgroundImage) {
    const url = style.backgroundImage;
    d.push(["background-image", `url("${assetHref(url)}")`]);
    d.push(["background-size", style.backgroundSize ?? "cover"]);
    d.push(["background-position", style.backgroundPosition ?? "center"]);
    d.push(["background-repeat", "no-repeat"]);
  }
  if (style.radius > 0) d.push(["border-radius", `${style.radius}px`]);

  if (node.type === "text") {
    resetMargin();
    // `<br>` из исходника хранится как \n в тексте узла; без pre-line
    // HTML схлопнет его в пробел и заголовок склеится в одну строку
    if ((node.text ?? "").includes("\n")) d.push(["white-space", "pre-line"]);
    // свой шрифт узла важнее шрифта темы: импортированная страница обязана
    // сохранить свою типографику, иначе экспорт не совпадёт с оригиналом
    if (style.fontFamily) d.push(["font-family", style.fontFamily]);
    else if (style.fontSize >= 24) d.push(["font-family", "var(--font-heading)"]);
    d.push(["font-size", `${style.fontSize}px`]);
    // ВСЕГДА: тег h1/h2 в браузере жирный по умолчанию, и вес 400 из
    // исходника пропадал — заголовки импортированной страницы толстели
    d.push(["font-weight", `${style.fontWeight}`]);
    d.push(["color", cssColor(style.textColor)]);
    if (style.italic) d.push(["font-style", "italic"]);
    if (style.strike) d.push(["text-decoration", "line-through"]);
    if (style.textAlign && style.textAlign !== "left") d.push(["text-align", style.textAlign]);
    if (node.href && !style.strike) {
      d.push(["text-decoration", style.underline === false ? "none" : "underline"]);
    }
  }
  /* типографские детали и рамки — общие для всех типов */
  if (style.letterSpacing) d.push(["letter-spacing", `${style.letterSpacing}px`]);
  if (style.uppercase) d.push(["text-transform", "uppercase"]);
  if (style.lineHeight && node.type === "text") d.push(["line-height", `${style.lineHeight}`]);
  if (style.opacity !== undefined && style.opacity < 1) d.push(["opacity", `${style.opacity}`]);
  if (style.borderWidth) {
    const col = cssColor(style.borderColor ?? style.textColor);
    const prop = style.borderTop
      ? "border-top"
      : style.borderBottom
        ? "border-bottom"
        : style.borderLeft
          ? "border-left"
          : "border";
    d.push([prop, `${style.borderWidth}px solid ${col}`]);
  }
  if (node.type === "button") {
    d.push(["border", "none"]);
    d.push(["cursor", "pointer"]);
    d.push(["padding", "10px 20px"]);
    d.push(["font-size", `${style.fontSize}px`]);
    d.push(["font-weight", `${style.fontWeight}`]);
    d.push(["color", cssColor(style.textColor)]);
    d.push(["font-family", "inherit"]);
    if (style.italic) d.push(["font-style", "italic"]);
    if (node.href) {
      // кнопка-ссылка: <a>, ведём себя как кнопка
      d.push(["display", "inline-flex"]);
      d.push(["align-items", "center"]);
      d.push(["justify-content", "center"]);
      d.push(["text-decoration", "none"]);
    }
  }
  if (node.type === "input") {
    // импортированное поле уже несёт свою рамку/фон — не перетираем их
    if (!style.borderWidth) d.push(["border", "1px solid var(--c-line)"]);
    // у <input> собственный белый фон от браузера: прозрачность из модели
    // надо проговорить явно, иначе поля темной формы становятся белыми
    if (style.fill === "transparent") d.push(["background", "transparent"]);
    d.push(["padding", "0 12px"]);
    d.push(["font-size", `${style.fontSize}px`]);
    d.push(["font-family", "inherit"]);
    d.push(["color", cssColor(style.textColor)]);
  }
  if (node.type === "image") {
    d.push(["object-fit", style.objectFit ?? "cover"]);
    d.push(["display", "block"]);
  }
  if (node.type === "frame") {
    d.push(["min-height", "100vh"]);
    // ширина страницы — потолок контента, а не жёсткий размер: страница
    // остаётся адаптивной, но повторяет исходную колонку
    if (typeof layout.width === "number") {
      d.push(["max-width", `${Math.round(layout.width)}px`]);
      d.push(["margin-inline", "auto"]);
      d.push(["width", "100%"]);
    }
    if (style.fill !== "transparent") d.push(["background", cssColor(style.fill)]);
  }
  if (node.type === "instance") {
    // обёртка экземпляра прозрачна для раскладки
    d.push(["display", "contents"]);
  }

  /* ---------- элементы каталога типов ---------- */
  if (node.type === "divider") {
    // <hr> со снятыми браузерными стилями: линию рисует border
    d.push(["border", "none"]);
    d.push(["border-top", `${style.borderWidth ?? 1}px solid ${cssColor(style.borderColor ?? "$line")}`]);
    resetMargin();
    d.push(["width", "100%"]);
  }
  if (node.type === "spacer") {
    d.push(["flex", "0 0 auto"]);
    d.push(["pointer-events", "none"]);
  }
  if (node.type === "list") {
    resetMargin();
    d.push(["padding-left", `${Math.round(style.fontSize * 1.4)}px`]);
    d.push(["display", "flex"]);
    d.push(["flex-direction", "column"]);
    d.push(["gap", "6px"]);
    d.push(["font-size", `${style.fontSize}px`]);
    d.push(["color", cssColor(style.textColor)]);
    if (style.lineHeight) d.push(["line-height", `${style.lineHeight}`]);
  }
  if (node.type === "quote") {
    resetMargin();
    d.push(["font-size", `${style.fontSize}px`]);
    d.push(["color", cssColor(style.textColor)]);
    if (style.italic) d.push(["font-style", "italic"]);
    if (style.lineHeight) d.push(["line-height", `${style.lineHeight}`]);
  }
  if (node.type === "icon") {
    d.push(["display", "inline-flex"]);
    d.push(["align-items", "center"]);
    d.push(["justify-content", "center"]);
    d.push(["color", cssColor(style.textColor)]);
    d.push(["flex", "0 0 auto"]);
  }
  if (node.type === "video" || node.type === "embed") {
    // рамка держит пропорцию сама: aspect-ratio вместо padding-хака
    d.push(["aspect-ratio", ratioCss(node.frameRatio ?? 16 / 9)]);
    d.push(["width", "100%"]);
    d.push(["border", "none"]);
    d.push(["display", "block"]);
    d.push(["overflow", "hidden"]);
  }
  if (node.type === "autonav") {
    d.push(["display", "flex"], ["gap", "24px"], ["align-items", "center"]);
    d.push(["padding", "14px 24px"], ["background", "var(--c-surface)"]);
    d.push(["border-bottom", "1px solid var(--c-line)"]);
  }
  if (node.type === "autofooter") {
    d.push(["display", "flex"], ["flex-direction", "column"], ["gap", "10px"]);
    d.push(["padding", "20px 24px"], ["background", "var(--c-surface)"]);
    d.push(["margin-top", "auto"]);
  }
  if (node.type === "breadcrumbs") {
    d.push(["font-size", "13px"], ["color", "var(--c-muted)"]);
  }
  if (node.type === "cmslist") {
    d.push(["display", "flex"], ["flex-direction", "column"], ["gap", "12px"]);
  }

  /* Вычисленный отступ — ПОСЛЕДНИМ, чтобы сброс браузерного его не стирал
     (см. `emitMargin`). */
  emitMargin();

  return d;
}

/* ------------------------------------------------------------------ */
/* Адаптивность: блоки @media                                          */
/* ------------------------------------------------------------------ */

/** Узел, попавший в CSS: нужен и сам он, и его родитель (от него зависят декларации). */
interface CssEntry {
  node: SceneNode;
  parent: SceneNode | null;
  cls: string;
}

/**
 * МЕДИАЗАПРОСЫ ИЗ ПЕРЕОПРЕДЕЛЕНИЙ.
 *
 * Три свойства вывода, за которые здесь отвечаем:
 *
 *  1. ПОРЯДОК от широкого к узкому. Специфичность у всех блоков одинаковая,
 *     поэтому при ширине 600px побеждает тот, что идёт позже — узкий.
 *     Отсюда и требование к doc.breakpoints быть отсортированным.
 *  2. ТОЛЬКО ИЗМЕНЁННОЕ. Декларации считаются полным прогоном cssForNode на
 *     разрешённом узле и сравниваются с ПРЕДЫДУЩИМ (более широким) звеном
 *     каскада, а не с базой. Это ровно то, что уже действует в браузере на
 *     этой ширине, поэтому в блок попадает минимальная дельта — и модель
 *     каскада из scene.ts совпадает с каскадом CSS.
 *  3. НИ ОДНОГО @media, если брейкпоинтов нет или переопределений нет:
 *     пустые блоки не печатаются, и CSS остаётся прежним байт-в-байт.
 */
function mediaBlocksCss(doc: SceneDocument, entries: CssEntry[], theme: ResolvedTheme): string {
  if (doc.breakpoints.length === 0) return "";

  /** Декларации узла на брейкпоинте (null — база). */
  const declsAt = (entry: CssEntry, bpId: string | null): Decl[] => {
    const self = resolveNodeAt(entry.node, doc.breakpoints, bpId);
    let parent: SceneNode | null = null;
    if (entry.parent) {
      const rp = resolveNodeAt(entry.parent, doc.breakpoints, bpId);
      parent = { ...entry.parent, layout: rp.layout, style: rp.style };
    }
    const d = cssForNode({ ...entry.node, layout: self.layout, style: self.style }, parent, theme);
    // скрытие — не свойство cssForNode: добавляем последним, чтобы победило
    if (self.hidden) d.push(["display", "none"]);
    return d;
  };

  const out: string[] = [];
  for (let i = 0; i < doc.breakpoints.length; i++) {
    const bp = doc.breakpoints[i];
    const prevId = i === 0 ? null : doc.breakpoints[i - 1].id;
    const rules: string[] = [];

    for (const entry of entries) {
      // узел без переопределений на всём каскаде до этой ширины пропускаем сразу
      if (!entry.node.responsive && !(entry.parent && entry.parent.responsive)) continue;
      const cur = declsAt(entry, bp.id);
      const prev = new Map(declsAt(entry, prevId));
      const changed: Decl[] = cur.filter(([p, v]) => prev.get(p) !== v);
      // возврат из display:none: базовая декларация display могла совпасть с
      // предыдущей ширины и не попасть в дельту — тогда узел остался бы скрыт
      if (prev.get("display") === "none" && !changed.some(([p]) => p === "display")) {
        changed.push(["display", cur.find(([p]) => p === "display")?.[1] ?? "block"]);
      }
      if (changed.length > 0) {
        rules.push(`  .${entry.cls} {\n${changed.map(([p, v]) => `    ${p}: ${v};`).join("\n")}\n  }`);
      }
    }

    if (rules.length > 0) {
      out.push(`/* ${bp.name} */\n@media (max-width: ${Math.round(bp.maxWidth)}px) {\n${rules.join("\n")}\n}`);
    }
  }
  return out.length === 0 ? "" : `\n${out.join("\n\n")}\n`;
}

function tagFor(node: SceneNode): string {
  if (node.href && (node.type === "text" || node.type === "button")) return "a";
  // семантические роли: header/footer/nav/section вместо анонимных div
  if (node.type === "container" && node.role) {
    return { header: "header", footer: "footer", nav: "nav", section: "section" }[node.role];
  }
  switch (node.type) {
    case "frame":
      return "main";
    case "text":
      return node.style.fontSize >= 32 ? "h1" : node.style.fontSize >= 24 ? "h2" : "p";
    case "button":
      return "button";
    case "image":
      return "img";
    case "input":
      return "input";
    /* ---- элементы каталога: семантика важнее внешнего вида ---- */
    case "divider":
      return "hr";
    case "list":
      return node.ordered ? "ol" : "ul";
    case "quote":
      return "blockquote";
    case "video":
    case "embed":
      return "iframe";
    case "icon":
      return "span";
    case "spacer":
      return "div";
    default:
      return "div";
  }
}

/**
 * Встроенный набор иконок глифами. Сознательно без иконочных шрифтов и
 * SVG-спрайтов: ноль внешних запросов, работает в любом окружении, и
 * пользователю не приходится подключать библиотеку ради одной галочки.
 */
const ICON_GLYPHS: Record<string, string> = {
  star: "★", heart: "♥", check: "✓", cross: "✕", plus: "+", minus: "−",
  arrowRight: "→", arrowLeft: "←", arrowUp: "↑", arrowDown: "↓",
  mail: "✉", phone: "☎", pin: "⌖", clock: "◷", user: "☻", lock: "▮",
  search: "⌕", menu: "≡", info: "i", warning: "!", bolt: "↯", shield: "◈",
  diamond: "◆", circle: "●", square: "■", triangle: "▲", play: "▶", dot: "•",
};

export const ICON_NAMES = Object.keys(ICON_GLYPHS);

export function iconGlyph(name: string | undefined): string {
  return ICON_GLYPHS[name ?? "star"] ?? "★";
}

/** Адрес рамки: ссылка на видео приводится к embed-виду. */
function embedSrc(node: SceneNode): string {
  const raw = (node.src ?? "").trim();
  if (!raw) return "about:blank";
  if (node.videoProvider === "youtube") {
    const id = /(?:v=|youtu\.be\/|embed\/)([\w-]{6,})/.exec(raw)?.[1];
    return id ? `https://www.youtube-nocookie.com/embed/${id}` : raw;
  }
  if (node.videoProvider === "vimeo") {
    const id = /vimeo\.com\/(?:video\/)?(\d+)/.exec(raw)?.[1];
    return id ? `https://player.vimeo.com/video/${id}` : raw;
  }
  return raw;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * ТЕКСТ ЭЛЕМЕНТА: КРАЕВОЙ ПРОБЕЛ ЗНАЧИМ, А HTML ЕГО СХЛОПЫВАЕТ.
 *
 * Кусок собственного текста родителя стоит на одной строке с соседями, и
 * пробел на его краю — содержимое, а не форматирование (см. `addOwnText` в
 * импорте). В разметке такой пробел на границе элемента исчезает по общему
 * правилу схлопывания, поэтому в экспорт он уходит неразрывным: это ровно
 * тот же глиф той же ширины, но схлопыванию он не подлежит.
 *
 * `white-space: pre-wrap` решил бы то же самое, но он спорит с `nowrap`,
 * который на однострочных надписях ставится по измеренному факту.
 */
const escText = (s: string): string => esc(s).replace(/^ /, "&nbsp;").replace(/ $/, "&nbsp;");

/* ------------------------------------------------------------------ */
/* Проект целиком                                                      */
/* ------------------------------------------------------------------ */

export function generateProject(doc: SceneDocument, siteName = "Plexus Site"): GeneratedProject {
  const theme = resolveTheme(doc.theme);
  const usedClasses = new Set<string>();
  const classes = new Map<string, string>();
  const cssBlocks: string[] = [];

  const className = (node: SceneNode): string => {
    let base = slugify(node.name);
    if (usedClasses.has(base)) base = `${base}-${node.id.slice(-4)}`;
    usedClasses.add(base);
    return base;
  };

  // все узлы, попавшие в CSS — из них собираются блоки @media
  const cssEntries: CssEntry[] = [];
  // узлы с «затвердеванием на скролле» и с reveal-анимацией — для script.js
  const scrollNodes: SceneNode[] = [];
  const revealNodes: SceneNode[] = [];

  // Классы и CSS собираем один раз по всем страницам → общий styles.css
  const collect = (id: string, parent: SceneNode | null): void => {
    const node = doc.nodes[id]!;
    const cls = className(node);
    classes.set(node.id, cls);
    cssEntries.push({ node, parent, cls });
    const decls = cssForNode(node, parent, theme);
    if (decls.length > 0) {
      cssBlocks.push(`.${cls} {\n${decls.map(([p, v]) => `  ${p}: ${v};`).join("\n")}\n}`);
    }
    // фон при прокрутке → отдельный класс-состояние + JS-переключатель
    if (node.sticky && node.scrollFill) {
      cssBlocks.push(
        `.${cls}.plx-scrolled {\n  background: ${cssColor(node.scrollFill)};\n  backdrop-filter: blur(12px);\n}`,
      );
      scrollNodes.push(node);
    }
    // анимация появления при прокрутке (reveal)
    if (node.reveal) {
      revealNodes.push(node);
      const { kind, duration, delay } = node.reveal;
      const from =
        kind === "up"
          ? "translateY(20px)"
          : kind === "down"
            ? "translateY(-20px)"
            : kind === "zoom"
              ? "scale(0.96)"
              : "none";
      cssBlocks.push(
        `.${cls}.plx-reveal {\n  opacity: 0;\n  transform: ${from};\n  transition: opacity ${duration}ms ease ${delay}ms, transform ${duration}ms ease ${delay}ms;\n}\n\n.${cls}.plx-reveal.plx-visible {\n  opacity: 1;\n  transform: none;\n}`,
      );
    }
    node.children.forEach((c) => collect(c, node));
  };
  doc.rootFrames.forEach((f) => collect(f, null));

  const renderNode = (id: string, depth: number, frameId: string): string => {
    const node = doc.nodes[id]!;
    const pad = "  ".repeat(depth);
    const tag = tagFor(node);
    const cls = classes.get(id)!;
    const anchor = `data-plx-id="${node.id}"${node.anchorId ? ` id="${esc(node.anchorId)}"` : ""}`;

    if (node.type === "autonav") {
      const links = doc.rootFrames
        .map((f) => `${pad}  <a href="${pageFiles.get(f)}">${esc(doc.nodes[f]!.name)}</a>`)
        .join("\n");
      return `${pad}<nav class="${cls}" ${anchor}>\n${links}\n${pad}</nav>`;
    }
    if (node.type === "autofooter") {
      const links = doc.rootFrames
        .map((f) => `<a href="${pageFiles.get(f)}">${esc(doc.nodes[f]!.name)}</a>`)
        .join(` `);
      return `${pad}<footer class="${cls}" ${anchor}>\n${pad}  <div class="plx-footer-links">${links}</div>\n${pad}  <small>© <span data-plx-year></span> ${esc(siteName)}</small>\n${pad}</footer>`;
    }
    if (node.type === "breadcrumbs") {
      const home = doc.rootFrames[0];
      const pageName = esc(doc.nodes[frameId]!.name);
      const inner =
        frameId === home
          ? `<span>${pageName}</span>`
          : `<a href="${pageFiles.get(home)}">${esc(doc.nodes[home]!.name)}</a> / <span>${pageName}</span>`;
      return `${pad}<nav class="${cls}" ${anchor}>${inner}</nav>`;
    }
    if (node.type === "cmslist") {
      const table = doc.dbTables[node.tableRef ?? ""];
      if (!table) return `${pad}<div class="${cls}" ${anchor}><!-- Список из БД: выбери таблицу в инспекторе --></div>`;
      // статический сайт: записи-плейсхолдеры (реальные данные — в Next.js-шаблоне)
      const item = (i: number): string =>
        `${pad}  <article class="plx-cms-item">\n${pad}    <strong>${esc(table.name)} · запись ${i}</strong>\n${table.fields
          .map((f) => `${pad}    <div>${esc(f.name)}: …</div>`)
          .join("\n")}\n${pad}  </article>`;
      return `${pad}<div class="${cls}" ${anchor}>\n${[1, 2, 3].map(item).join("\n")}\n${pad}</div>`;
    }

    if (node.type === "instance") {
      // экземпляр = разворачивание разметки мастера (классы и стили общие)
      const comp = doc.components[node.componentRef ?? ""];
      const inner = comp && doc.nodes[comp.rootId] ? renderNode(comp.rootId, depth + 1, frameId) : "";
      return `${pad}<div class="${cls}" ${anchor}>\n${inner}\n${pad}</div>`;
    }
    if (node.type === "image") {
      /* Через assetHref, как и фоновая картинка: иначе локальный путь
         попадает в разметку дословно и сайт нельзя перенести. */
      const src = assetHref(node.src ?? "https://placehold.co/600x400");
      return `${pad}<img class="${cls}" ${anchor} src="${esc(src)}" alt="${esc(node.name)}" />`;
    }
    if (node.type === "input") {
      return `${pad}<input class="${cls}" ${anchor} type="text" placeholder="${esc(node.text ?? "")}" />`;
    }

    /* ---------- элементы каталога типов ---------- */
    if (node.type === "divider") {
      return `${pad}<hr class="${cls}" ${anchor} />`;
    }
    if (node.type === "spacer") {
      // декоративная распорка: скрыта от скринридеров
      return `${pad}<div class="${cls}" ${anchor} aria-hidden="true"></div>`;
    }
    if (node.type === "list") {
      const items = (node.items ?? []).map((i) => `${pad}  <li>${esc(i)}</li>`).join("\n");
      return `${pad}<${tag} class="${cls}" ${anchor}>\n${items}\n${pad}</${tag}>`;
    }
    if (node.type === "quote") {
      const body = `${pad}  <p>${esc(node.text ?? "")}</p>`;
      const author = node.cite ? `\n${pad}  <footer><cite>${esc(node.cite)}</cite></footer>` : "";
      return `${pad}<blockquote class="${cls}" ${anchor}>\n${body}${author}\n${pad}</blockquote>`;
    }
    if (node.type === "icon") {
      // иконка как текстовый глиф: без внешних библиотек и лишних запросов
      return `${pad}<span class="${cls}" ${anchor} role="img" aria-label="${esc(node.name)}">${esc(iconGlyph(node.iconName))}</span>`;
    }
    if (node.type === "video" || node.type === "embed") {
      const src = embedSrc(node);
      const extra = node.type === "embed" ? ' sandbox="allow-scripts allow-same-origin allow-popups"' : "";
      return `${pad}<iframe class="${cls}" ${anchor} src="${esc(src)}" title="${esc(node.name)}" loading="lazy" allowfullscreen${extra}></iframe>`;
    }
    if (node.type === "text" || node.type === "button") {
      const hrefAttr = tag === "a" ? ` href="${esc(node.href ?? "#")}"` : "";
      return `${pad}<${tag} class="${cls}" ${anchor}${hrefAttr}>${escText(node.text ?? "")}</${tag}>`;
    }
    const children = node.children.map((c) => renderNode(c, depth + 1, frameId)).join("\n");
    return `${pad}<${tag} class="${cls}" ${anchor}>\n${children}\n${pad}</${tag}>`;
  };

  // Ссылки на другие страницы — простая навигация между файлами
  const pageFiles = new Map<string, string>();
  const usedFiles = new Set<string>();
  doc.rootFrames.forEach((id, i) => {
    const frame = doc.nodes[id]!;
    let file = i === 0 ? "index" : slugify(frame.name);
    if (usedFiles.has(file)) file = `${file}-${id.slice(-4)}`;
    usedFiles.add(file);
    pageFiles.set(id, `${file}.html`);
  });

  const nav = (currentId: string): string => {
    if (doc.rootFrames.length < 2) return "";
    const links = doc.rootFrames
      .map((id) => {
        const name = esc(doc.nodes[id]!.name);
        const href = pageFiles.get(id)!;
        const cur = id === currentId ? ' aria-current="page"' : "";
        return `      <a href="${href}"${cur}>${name}</a>`;
      })
      .join("\n");
    return `\n    <nav class="plx-pages">\n${links}\n    </nav>`;
  };

  const files: Record<string, string> = {};
  const wires = doc.wires ?? [];
  const slotNodes = Object.values(doc.nodes)
    .filter((n) => n.customCode)
    .sort((a, b) => a.id.localeCompare(b.id));
  const hasFooter = Object.values(doc.nodes).some((n) => n.type === "autofooter");
  const hasScript = wires.length > 0 || slotNodes.length > 0 || hasFooter || scrollNodes.length > 0 || revealNodes.length > 0;
  const hasSubmit = wires.some((w) => w.action === "submit");
  const scriptTag = hasScript ? `\n    <script src="script.js" defer></script>` : "";

  for (const frameId of doc.rootFrames) {
    const frame = doc.nodes[frameId]!;
    const body = renderNode(frameId, 2, frameId);
    const title = doc.rootFrames.length > 1 ? `${esc(frame.name)} — ${esc(siteName)}` : esc(siteName);
    files[`site/${pageFiles.get(frameId)}`] = `<!doctype html>
<!-- Сгенерировано Plexus. Атрибуты data-plx-id связывают код с холстом. -->
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="${googleFontsUrl(theme.googleFamilies)}" rel="stylesheet" />
    <link rel="stylesheet" href="styles.css" />${scriptTag}
  </head>
  <body>${nav(frameId)}
${body}
  </body>
</html>
`;
  }

  if (hasScript) {
    files["site/script.js"] = generateScript(doc, wires, pageFiles, slotNodes, scrollNodes, revealNodes);
  }
  if (hasSubmit) {
    files["server/server.js"] = generateServer();
  }
  if (Object.keys(doc.dbTables).length > 0 || doc.siteTarget === "next") {
    files["prisma/schema.prisma"] = generatePrisma(doc);
  }

  const pagesNavCss =
    doc.rootFrames.length > 1
      ? `\n.plx-pages {\n  display: flex;\n  gap: 16px;\n  padding: 12px 24px;\n  border-bottom: 1px solid #e6e6ee;\n  font-size: 14px;\n}\n.plx-pages a {\n  color: #5a636b;\n  text-decoration: none;\n}\n.plx-pages a[aria-current="page"] {\n  color: #252b30;\n  font-weight: 600;\n}\n`
      : "";

  const hiddenCss = wires.some((w) => w.action === "toggle")
    ? `\n[hidden] {\n  display: none !important;\n}\n`
    : "";

  const hasSmart = Object.values(doc.nodes).some((n) =>
    ["autonav", "autofooter", "breadcrumbs", "cmslist"].includes(n.type),
  );
  const smartCss = hasSmart
    ? `
/* умные элементы Plexus */
nav a {
  color: var(--c-text);
  text-decoration: none;
  font-weight: 500;
}
.plx-footer-links {
  display: flex;
  gap: 18px;
}
.plx-footer-links a {
  color: var(--c-muted);
  text-decoration: none;
}
footer small {
  color: var(--c-muted);
}
.plx-cms-item {
  border: 1px solid var(--c-line);
  border-radius: 10px;
  padding: 14px;
  background: var(--c-surface);
}
`
    : "";

  const c = theme.colors;
  files["site/styles.css"] = `/* Сгенерировано Plexus — детерминированный вывод. */
/* Дизайн-токены темы «${theme.preset}» — смени стиль в Plexus, и файл пересоберётся. */

:root {
  --c-bg: ${c.bg};
  --c-surface: ${c.surface};
  --c-text: ${c.text};
  --c-muted: ${c.muted};
  --c-line: ${c.line};
  --c-accent: ${c.accent};
  --c-accent-ink: ${c.accentInk};
  --font-heading: ${theme.fonts.heading};
  --font-body: ${theme.fonts.body};
}

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth; /* плавный переход по якорным ссылкам #section */
}

body {
  margin: 0;
  font-family: var(--font-body);
  color: var(--c-text);
  background: var(--c-bg);
  -webkit-font-smoothing: antialiased;
}
${hiddenCss}${smartCss}${pagesNavCss}
${cssBlocks.join("\n\n")}
${mediaBlocksCss(doc, cssEntries, theme)}`;

  if (doc.siteTarget === "next") {
    return { files: generateNextProject(doc, siteName, files["site/styles.css"], pageFiles, classes) };
  }

  return { files };
}

/* ------------------------------------------------------------------ */
/* Связи («провода») → script.js                                       */
/* ------------------------------------------------------------------ */

function generateScript(
  doc: SceneDocument,
  wires: Wire[],
  pageFiles: Map<string, string>,
  slotNodes: SceneNode[],
  scrollNodes: SceneNode[] = [],
  revealNodes: SceneNode[] = [],
): string {
  const name = (id: string): string => doc.nodes[id]?.name ?? id;

  // «Затвердевание» sticky-шапки на скролле (как .scrolled у анализируемого сайта)
  const scrollBlock = scrollNodes
    .map((n) => `  plxScrollSolidify("${n.id}");`)
    .join("\n");

  // Код-слоты (two-way Phase 1): содержимое между маркерами редактируемо —
  // кнопка «Слоты ← файл» в Plexus вернёт правки в модель
  const slots = slotNodes
    .map((n) => {
      const body = (n.customCode ?? "")
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n");
      return `  // Свой код: «${name(n.id)}»\n  plxOn("${n.id}", (event) => {\n    /* PLX-SLOT:${n.id} */\n${body}\n    /* /PLX-SLOT */\n  });`;
    })
    .join("\n\n");

  const handlers = wires
    .map((w) => {
      const comment = `  // «${name(w.sourceId)}» → «${name(w.targetId)}»`;
      switch (w.action) {
        case "navigate": {
          const href = pageFiles.get(w.targetId);
          if (!href) return `${comment} — пропущено: цель не страница`;
          return `${comment}\n  plxOn("${w.sourceId}", () => {\n    location.href = "${href}";\n  });`;
        }
        case "toggle":
          return `${comment}\n  plxOn("${w.sourceId}", () => {\n    const target = plxFind("${w.targetId}");\n    if (target) target.hidden = !target.hidden;\n  });`;
        case "submit":
          return `${comment}\n  plxOn("${w.sourceId}", async () => {\n    const form = plxFind("${w.targetId}");\n    if (!form) return;\n    const data = {};\n    form.querySelectorAll("input").forEach((el) => {\n      data[el.getAttribute("data-plx-id")] = el.value;\n    });\n    const res = await fetch("/api/forms/${w.id}", {\n      method: "POST",\n      headers: { "Content-Type": "application/json" },\n      body: JSON.stringify(data),\n    });\n    plxNote("${w.sourceId}", res.ok ? "Отправлено!" : "Ошибка отправки");\n  });`;
      }
    })
    .join("\n\n");

  return `// Сгенерировано Plexus — обработчики связей («проводов»).
// Каждый обработчик привязан к элементу через его якорь data-plx-id.
// В предпросмотре Plexus (window.__PLX_PREVIEW) ошибки отправляются в редактор
// вместе с id элемента — так лог указывает на конкретный элемент холста.

(function () {
  "use strict";

  const plxFind = (id) => document.querySelector('[data-plx-id="' + id + '"]');

  const plxError = (id, message) => {
    if (window.__PLX_PREVIEW && window.parent !== window) {
      window.parent.postMessage({ __plx: "error", id, message }, "*");
    } else {
      console.error("[plexus:" + id + "]", message);
    }
  };

  const plxNote = (id, message) => {
    if (window.__PLX_PREVIEW && window.parent !== window) {
      window.parent.postMessage({ __plx: "note", id, message }, "*");
    } else {
      alert(message);
    }
  };

  const plxOn = (id, fn) => {
    const el = plxFind(id);
    if (!el) return;
    el.addEventListener("click", (event) => {
      try {
        const result = fn(event);
        if (result && typeof result.catch === "function") {
          result.catch((e) => plxError(id, String(e)));
        }
      } catch (e) {
        plxError(id, String(e));
      }
    });
  };

  // reveal-анимации: класс + IntersectionObserver (как на исходном сайте)
  const plxReveal = (ids) => {
    const els = ids.map(plxFind).filter(Boolean);
    els.forEach((el) => el.classList.add("plx-reveal"));
    if (!("IntersectionObserver" in window)) {
      els.forEach((el) => el.classList.add("plx-visible"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add("plx-visible");
          io.unobserve(e.target);
        }
      }),
      { threshold: 0.12 },
    );
    els.forEach((el) => io.observe(el));
  };

  const plxScrollSolidify = (id) => {
    const el = plxFind(id);
    if (!el) return;
    const onScroll = () => el.classList.toggle("plx-scrolled", window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  };

${handlers}${slots ? `\n\n${slots}` : ""}
${scrollBlock ? `\n${scrollBlock}\n` : ""}${
    revealNodes.length > 0
      ? `\n  plxReveal(${JSON.stringify(revealNodes.map((n) => n.id))});\n`
      : ""
  }
  // авто-подвал: живой год
  document.querySelectorAll("[data-plx-year]").forEach((el) => {
    el.textContent = String(new Date().getFullYear());
  });
})();
`;
}

/* ------------------------------------------------------------------ */
/* Бэкенд: сервер без зависимостей (v1)                                */
/* ------------------------------------------------------------------ */

function generateServer(): string {
  return `// Сгенерировано Plexus — бэкенд сайта (v1, ноль зависимостей).
//
// Запуск:  node server/server.js
// Сайт:    http://localhost:3000
// Формы:   POST /api/forms/:id  →  server/data/forms.jsonl (по строке на отправку)
//
// Следующая фаза Plexus: генерация Next.js + Prisma + PostgreSQL по шаблону.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 3000;
const SITE_DIR = path.join(__dirname, "..", "site");
const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function handleForm(req, res) {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try {
      const record = {
        form: req.url.split("/").pop(),
        at: new Date().toISOString(),
        data: JSON.parse(body || "{}"),
      };
      fs.appendFileSync(path.join(DATA_DIR, "forms.jsonl"), JSON.stringify(record) + "\\n");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      console.log("форма принята:", record.form);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"ok":false}');
    }
  });
}

function serveStatic(req, res) {
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(SITE_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(SITE_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("404 — файл не найден");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(buf);
  });
}

http
  .createServer((req, res) => {
    if (req.method === "POST" && req.url.startsWith("/api/forms/")) return handleForm(req, res);
    return serveStatic(req, res);
  })
  .listen(PORT, () => {
    console.log("Plexus backend запущен: http://localhost:" + PORT);
  });
`;
}

/* ------------------------------------------------------------------ */
/* Next.js + Prisma таргет (шаблон «с базой данных»)                   */
/* ------------------------------------------------------------------ */

function generateNextProject(
  doc: SceneDocument,
  siteName: string,
  stylesCss: string,
  pageFiles: Map<string, string>,
  classes: Map<string, string>,
): Record<string, string> {
  const theme = resolveTheme(doc.theme);
  const names = prismaNames(doc);
  const files: Record<string, string> = {};
  const wires = doc.wires ?? [];
  const slotNodes = Object.values(doc.nodes)
    .filter((n) => n.customCode)
    .sort((a, b) => a.id.localeCompare(b.id));

  /** Маршрут страницы: index.html → "/", ostalnye → "/slug". */
  const routeOf = (frameId: string): string => {
    const f = pageFiles.get(frameId) ?? "index.html";
    return f === "index.html" ? "/" : `/${f.replace(/\.html$/, "")}`;
  };

  const camelModel = (model: string): string => model.charAt(0).toLowerCase() + model.slice(1);

  /** Поля таблицы → camelCase-имена (тот же алгоритм, что в modelFor). */
  const fieldNamesOf = (t: DbTable): Map<string, string> => {
    const used = new Set(["id", "createdAt"]);
    const map = new Map<string, string>();
    for (const f of t.fields) {
      let fname = camel(f.name, "field");
      while (used.has(fname)) fname = `${fname}X`;
      used.add(fname);
      map.set(f.id, fname);
    }
    return map;
  };

  /* ---------- JSX-рендер страницы ---------- */
  const cmsOnPage = new Map<string, SceneNode[]>(); // frameId → cmslist-узлы

  const renderJsx = (id: string, depth: number, frameId: string): string => {
    const node = doc.nodes[id]!;
    const pad = "  ".repeat(depth);
    const cls = classes.get(id)!;
    const anchor = `data-plx-id="${node.id}"${node.anchorId ? ` id="${esc(node.anchorId)}"` : ""}`;

    if (node.type === "autonav") {
      const links = doc.rootFrames
        .map((f) => `${pad}  <a href="${routeOf(f)}">${esc(doc.nodes[f]!.name)}</a>`)
        .join("\n");
      return `${pad}<nav className="${cls}" ${anchor}>\n${links}\n${pad}</nav>`;
    }
    if (node.type === "autofooter") {
      const links = doc.rootFrames
        .map((f) => `<a href="${routeOf(f)}">${esc(doc.nodes[f]!.name)}</a>`)
        .join(" ");
      return `${pad}<footer className="${cls}" ${anchor}>\n${pad}  <div className="plx-footer-links">${links}</div>\n${pad}  <small>© {new Date().getFullYear()} ${esc(siteName)}</small>\n${pad}</footer>`;
    }
    if (node.type === "breadcrumbs") {
      const home = doc.rootFrames[0];
      const pageName = esc(doc.nodes[frameId]!.name);
      const inner =
        frameId === home
          ? `<span>${pageName}</span>`
          : `<a href="/">${esc(doc.nodes[home]!.name)}</a> / <span>${pageName}</span>`;
      return `${pad}<nav className="${cls}" ${anchor}>${inner}</nav>`;
    }
    if (node.type === "cmslist") {
      const table = doc.dbTables[node.tableRef ?? ""];
      if (!table) return `${pad}<div className="${cls}" ${anchor}>{/* Список из БД: выбери таблицу */}</div>`;
      const list = cmsOnPage.get(frameId) ?? [];
      list.push(node);
      cmsOnPage.set(frameId, list);
      const model = names.get(table.id)!;
      const rowsVar = `rows_${node.id.replace(/[^a-zA-Z0-9]/g, "")}`;
      const fields = fieldNamesOf(table);
      const fieldLines = table.fields
        .map((f) => `${pad}      <div>${esc(f.name)}: {String(row.${fields.get(f.id)} ?? "")}</div>`)
        .join("\n");
      return `${pad}<div className="${cls}" ${anchor}>\n${pad}  {${rowsVar}.map((row) => (\n${pad}    <article className="plx-cms-item" key={row.id}>\n${pad}      <strong>${esc(model)} #{row.id}</strong>\n${fieldLines}\n${pad}    </article>\n${pad}  ))}\n${pad}</div>`;
    }
    if (node.type === "instance") {
      const comp = doc.components[node.componentRef ?? ""];
      const inner = comp && doc.nodes[comp.rootId] ? renderJsx(comp.rootId, depth + 1, frameId) : "";
      return `${pad}<div className="${cls}" ${anchor}>\n${inner}\n${pad}</div>`;
    }
    if (node.type === "image") {
      const src = assetHref(node.src ?? "https://placehold.co/600x400");
      return `${pad}<img className="${cls}" ${anchor} src="${esc(src)}" alt="${esc(node.name)}" />`;
    }
    if (node.type === "input") {
      return `${pad}<input className="${cls}" ${anchor} type="text" placeholder="${esc(node.text ?? "")}" />`;
    }
    if (node.type === "text" || node.type === "button") {
      const tag = tagFor(node);
      const hrefAttr = tag === "a" ? ` href="${esc(node.href ?? "#")}"` : "";
      return `${pad}<${tag} className="${cls}" ${anchor}${hrefAttr}>${escText(node.text ?? "")}</${tag}>`;
    }
    const tag = node.type === "frame" ? "main" : "div";
    const children = node.children.map((c) => renderJsx(c, depth + 1, frameId)).join("\n");
    return `${pad}<${tag} className="${cls}" ${anchor}>\n${children}\n${pad}</${tag}>`;
  };

  /* ---------- страницы ---------- */
  for (const frameId of doc.rootFrames) {
    cmsOnPage.delete(frameId);
    const body = renderJsx(frameId, 2, frameId);
    const cms = cmsOnPage.get(frameId) ?? [];
    const route = routeOf(frameId);
    const depth = route === "/" ? 1 : 2;
    const prismaPath = `${"../".repeat(depth)}lib/prisma`;
    const isAsync = cms.length > 0;
    const fetches = cms
      .map((n) => {
        const table = doc.dbTables[n.tableRef!]!;
        const model = camelModel(names.get(table.id)!);
        const rowsVar = `rows_${n.id.replace(/[^a-zA-Z0-9]/g, "")}`;
        return `  const ${rowsVar} = await prisma.${model}.findMany({ take: 20, orderBy: { id: "desc" } });`;
      })
      .join("\n");
    const importPrisma = isAsync ? `import prisma from "${prismaPath}";\n\n` : "";
    const file = route === "/" ? "site/app/page.jsx" : `site/app${route}/page.jsx`;
    files[file] = `// Сгенерировано Plexus (${esc(doc.nodes[frameId]!.name)})
${importPrisma}export default ${isAsync ? "async " : ""}function Page() {
${fetches ? `${fetches}\n` : ""}  return (
${body}
  );
}
`;
  }

  /* ---------- каркас проекта ---------- */
  files["site/app/globals.css"] = stylesCss;

  files["site/app/layout.jsx"] = `import "./globals.css";
import PlxClient from "./plx-client";

export const metadata = { title: ${JSON.stringify(siteName)} };

export default function RootLayout({ children }) {
  return (
    <html lang="ru">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="${googleFontsUrl(theme.googleFamilies)}" rel="stylesheet" />
      </head>
      <body>
        {children}
        <PlxClient />
      </body>
    </html>
  );
}
`;

  /* ---------- клиентские обработчики (провода + слоты) ---------- */
  const handlerLines: string[] = [];
  for (const w of wires) {
    const src = JSON.stringify(w.sourceId);
    if (w.action === "navigate") {
      const target = routeOf(w.targetId);
      handlerLines.push(`    plxOn(${src}, () => { window.location.href = "${target}"; });`);
    } else if (w.action === "toggle") {
      handlerLines.push(
        `    plxOn(${src}, () => { const t = plxFind(${JSON.stringify(w.targetId)}); if (t) t.hidden = !t.hidden; });`,
      );
    } else {
      handlerLines.push(
        `    plxOn(${src}, async () => {
      const form = plxFind(${JSON.stringify(w.targetId)});
      if (!form) return;
      const data = {};
      form.querySelectorAll("input").forEach((el) => { data[el.getAttribute("data-plx-id")] = el.value; });
      const res = await fetch("/api/forms/${w.id}", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      alert(res.ok ? "Сохранено в базу!" : "Ошибка");
    });`,
      );
    }
  }
  for (const n of slotNodes) {
    const body = (n.customCode ?? "").split("\n").map((l) => `      ${l}`).join("\n");
    handlerLines.push(
      `    plxOn(${JSON.stringify(n.id)}, (event) => {\n      /* PLX-SLOT:${n.id} */\n${body}\n      /* /PLX-SLOT */\n    });`,
    );
  }
  // sticky-шапки: затвердевание на скролле
  for (const n of Object.values(doc.nodes)) {
    if (n.sticky && n.scrollFill) {
      handlerLines.push(
        `    (() => { const el = plxFind(${JSON.stringify(n.id)}); if (!el) return; const f = () => el.classList.toggle("plx-scrolled", window.scrollY > 8); window.addEventListener("scroll", f, { passive: true }); bound.push([window, f]); f(); })();`,
      );
    }
  }

  files["site/app/plx-client.jsx"] = `"use client";
// Сгенерировано Plexus: обработчики связей («проводов») и код-слоты.
import { useEffect } from "react";

export default function PlxClient() {
  useEffect(() => {
    const plxFind = (id) => document.querySelector('[data-plx-id="' + id + '"]');
    const bound = [];
    const plxOn = (id, fn) => {
      const el = plxFind(id);
      if (!el) return;
      const h = (e) => { try { const r = fn(e); if (r && r.catch) r.catch(console.error); } catch (err) { console.error(err); } };
      el.addEventListener("click", h);
      bound.push([el, h]);
    };

${handlerLines.join("\n\n")}

    document.querySelectorAll("[data-plx-year]").forEach((el) => { el.textContent = String(new Date().getFullYear()); });
    return () => bound.forEach(([el, h]) => el.removeEventListener("click", h));
  }, []);
  return null;
}
`;

  files["site/lib/prisma.js"] = `// Prisma-клиент: синглтон для dev-режима Next.js
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis;
const prisma = globalForPrisma.__plxPrisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.__plxPrisma = prisma;

export default prisma;
`;

  files["site/app/api/forms/[wire]/route.js"] = `// Приём форм (провода «в бэкенд») → таблица Submission через Prisma
import prisma from "../../../../lib/prisma";

export async function POST(request, { params }) {
  const { wire } = await params;
  try {
    const data = await request.json();
    await prisma.submission.create({ data: { wire, data: JSON.stringify(data) } });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
}
`;

  /* ---------- авторизация (email + пароль, MVP-скаффолд) ---------- */
  files["site/app/login/page.jsx"] = `// Страница входа (скаффолд Plexus)
export default function Login() {
  return (
    <main style={{ maxWidth: 380, margin: "80px auto", fontFamily: "var(--font-body)" }}>
      <h1>Вход</h1>
      <form action="/api/auth/login" method="post" style={{ display: "grid", gap: 12 }}>
        <input name="email" type="email" placeholder="email" required />
        <input name="password" type="password" placeholder="пароль" required />
        <button type="submit">Войти</button>
      </form>
      <p><a href="/register">Регистрация</a></p>
    </main>
  );
}
`;

  files["site/app/register/page.jsx"] = `// Страница регистрации (скаффолд Plexus)
export default function Register() {
  return (
    <main style={{ maxWidth: 380, margin: "80px auto", fontFamily: "var(--font-body)" }}>
      <h1>Регистрация</h1>
      <form action="/api/auth/register" method="post" style={{ display: "grid", gap: 12 }}>
        <input name="email" type="email" placeholder="email" required />
        <input name="password" type="password" placeholder="пароль (мин. 6)" required minLength={6} />
        <button type="submit">Создать аккаунт</button>
      </form>
      <p><a href="/login">Уже есть аккаунт</a></p>
    </main>
  );
}
`;

  files["site/app/api/auth/register/route.js"] = `import prisma from "../../../../lib/prisma";
import bcrypt from "bcryptjs";

export async function POST(request) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").toLowerCase();
  const password = String(form.get("password") ?? "");
  if (!email || password.length < 6) return new Response("Некорректные данные", { status: 400 });
  const passwordHash = await bcrypt.hash(password, 10);
  try {
    await prisma.user.create({ data: { email, passwordHash } });
  } catch {
    return new Response("Email уже занят", { status: 409 });
  }
  return Response.redirect(new URL("/login", request.url), 303);
}
`;

  files["site/app/api/auth/login/route.js"] = `import prisma from "../../../../lib/prisma";
import bcrypt from "bcryptjs";

// MVP-сессия: httpOnly-кука с id пользователя.
// Для продакшена замените на подписанные сессии (Auth.js / iron-session).
export async function POST(request) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").toLowerCase();
  const password = String(form.get("password") ?? "");
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return new Response("Неверный email или пароль", { status: 401 });
  }
  const res = Response.redirect(new URL("/", request.url), 303);
  res.headers.set("Set-Cookie", \`plx_session=\${user.id}; Path=/; HttpOnly; SameSite=Lax\`);
  return res;
}
`;

  /* ---------- конфиги и документация ---------- */
  files["site/package.json"] = JSON.stringify(
    {
      name: latinWord(siteName, "plexus-site").toLowerCase() || "plexus-site",
      private: true,
      scripts: {
        dev: "next dev",
        build: "next build",
        start: "next start",
        postinstall: "prisma generate",
      },
      dependencies: {
        "@prisma/client": "^5.20.0",
        bcryptjs: "^2.4.3",
        next: "^14.2.15",
        react: "^18.3.1",
        "react-dom": "^18.3.1",
      },
      devDependencies: {
        prisma: "^5.20.0",
      },
    },
    null,
    2,
  );

  files["site/next.config.mjs"] = `/** Сгенерировано Plexus */
export default {};
`;
  files["site/.gitignore"] = `node_modules\n.next\nprisma/dev.db\n`;
  files["site/prisma/schema.prisma"] = generatePrisma(doc);

  if (doc.dbProvider === "postgres") {
    files["site/.env"] = `DATABASE_URL="postgresql://plexus:plexus@localhost:5432/plexus"\n`;
    files["site/docker-compose.yml"] = `# PostgreSQL для локальной разработки: docker compose up -d
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: plexus
      POSTGRES_PASSWORD: plexus
      POSTGRES_DB: plexus
    ports:
      - "5432:5432"
    volumes:
      - plexus_pg:/var/lib/postgresql/data
volumes:
  plexus_pg:
`;
  }

  files["site/README-RUN.md"] = `# Запуск сайта (Next.js + Prisma)

\`\`\`bash
cd site
npm install
${doc.dbProvider === "postgres" ? "docker compose up -d   # PostgreSQL\n" : ""}npx prisma migrate dev --name init
npm run dev            # http://localhost:3000
\`\`\`

- Формы (провода «в бэкенд») пишут в таблицу Submission.
- Списки из БД читают данные через Prisma (наполни таблицы: npx prisma studio).
- Авторизация: /register и /login (MVP-скаффолд, для прода — Auth.js).
`;

  return files;
}

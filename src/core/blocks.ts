/**
 * РЕЕСТР БЛОКОВ — каталог готовых секций.
 *
 * Тип блока сознательно НЕ является switch-ем в рендерере: блок — это рецепт
 * поддерева из обычных узлов. Поэтому добавление нового типа не трогает ни
 * решатель, ни кодоген, ни холст — достаточно описать структуру здесь.
 *
 * Каждый блок при вставке даёт живую, уже настроенную секцию: контейнер
 * нужной ширины, раскладку, отступы из шкалы темы и осмысленную рыбу внутри.
 * Пользователь получает результат, который можно править, а не пустую рамку.
 *
 * Модуль чистый: ни DOM, ни Pixi, ни React.
 */
import type { LayoutType, NodeSpec, NodeType } from "./types";
import { SPACE_SCALE } from "./themes";
import { CONTAINER_PRESETS } from "./layoutPresets";

/* ------------------------------------------------------------------ */
/* Категории                                                           */
/* ------------------------------------------------------------------ */

export type BlockCategory = "structure" | "content" | "composite" | "conversion" | "tech";

export interface CategoryDef {
  id: BlockCategory;
  label: string;
  hint: string;
}

export const BLOCK_CATEGORIES: CategoryDef[] = [
  { id: "structure", label: "Структура", hint: "Каркас страницы" },
  { id: "content", label: "Контент", hint: "Текст, медиа, первый экран" },
  { id: "composite", label: "Составные", hint: "Готовые секции из повторов" },
  { id: "conversion", label: "Конверсия", hint: "Действия и заявки" },
  { id: "tech", label: "Техническое", hint: "Встраивания и свой код" },
];

export type BlockType =
  | "header" | "footer" | "section" | "spacer" | "divider"
  | "hero" | "heading" | "text" | "image" | "gallery" | "video"
  | "cards" | "features" | "steps" | "pricing" | "testimonials"
  | "faq" | "team" | "logos" | "stats" | "timeline"
  | "cta" | "form" | "subscribe" | "contacts"
  | "embed" | "html" | "canvas";

export interface BlockDefinition {
  type: BlockType;
  label: string;
  category: BlockCategory;
  /** Схематичное превью результата, а не название. */
  glyph: string;
  hint: string;
  /** Осмысленные раскладки для этого блока — остальные не предлагаем. */
  allowedLayouts?: LayoutType[];
  /** Рецепт поддерева. */
  build: () => NodeSpec;
}

/* ------------------------------------------------------------------ */
/* Строительные помощники                                              */
/* ------------------------------------------------------------------ */

const S = SPACE_SCALE;
const containerWidth = (t: string): number | null =>
  CONTAINER_PRESETS.find((c) => c.type === t)?.width ?? null;

/**
 * СЕКЦИЯ — два уровня, а не один.
 *
 * Внешний узел держит фон и вертикальные отступы ВО ВСЮ ШИРИНУ,
 * внутренний ограничивает ширину контента и распределяет детей.
 *
 * Совмещать это на одном элементе нельзя: фон обязан быть шире контента,
 * а боковые отступы контейнера конфликтуют с промежутками раскладки.
 * Именно на этом ломался первый вариант — заливка hero обрезалась по
 * колонке вместо того, чтобы закрыть экран целиком.
 */
function section(opts: {
  name: string;
  container?: "full" | "wide" | "default" | "narrow" | "text";
  padY?: keyof typeof S;
  gap?: keyof typeof S;
  fill?: string;
  layout?: LayoutType;
  columns?: number;
  minColumnWidth?: number;
  align?: "start" | "center" | "end";
  justify?: "start" | "center" | "end" | "between";
  minHeight?: number;
  anchorId?: string;
  children: NodeSpec[];
}): NodeSpec {
  const cont = opts.container ?? "default";
  const width = containerWidth(cont);
  const preset = opts.layout ?? "stack";

  const inner: NodeSpec = {
    type: "container",
    name: "Контент",
    layout: {
      width: "fill",
      height: "hug",
      direction: preset === "stack" ? "column" : "row",
      preset,
      container: cont,
      maxWidth: width ?? undefined,
      centered: width !== null,
      columns: opts.columns,
      autoGrid:
        preset === "auto-grid"
          ? { minColumnWidth: opts.minColumnWidth ?? 260, mode: "auto-fit" }
          : undefined,
      gridTracks:
        preset === "columns"
          ? Array.from({ length: opts.columns ?? 3 }, () => ({ fr: 1 }))
          : undefined,
      gap: S[opts.gap ?? "lg"],
      // боковые отступы живут ЗДЕСЬ: иначе на узком экране текст прилипнет
      // к краю. При «во всю ширину» они обнуляются
      padding: cont === "full" ? 0 : { t: 0, r: S.md, b: 0, l: S.md },
      align: opts.align ?? "start",
      justify: opts.justify ?? "start",
    },
    children: opts.children,
  };

  return {
    type: "container",
    name: opts.name,
    role: "section",
    layout: {
      width: "fill",
      height: opts.minHeight ?? "hug",
      direction: "column",
      preset: "stack",
      gap: 0,
      // вертикальный ритм секции — на внешнем узле, во всю ширину
      padding: { t: S[opts.padY ?? "xl"], r: 0, b: S[opts.padY ?? "xl"], l: 0 },
      align: "start",
      justify: opts.justify ?? "start",
    },
    style: opts.fill ? { fill: opts.fill } : undefined,
    anchorId: opts.anchorId,
    children: [inner],
  };
}

const eyebrow = (text: string): NodeSpec => ({
  type: "text",
  name: "Надзаголовок",
  text,
  layout: { width: "fill" },
  style: { fontSize: 11, fontWeight: 700, letterSpacing: 2.4, uppercase: true, textColor: "$accent" },
});

const h = (text: string, size: number): NodeSpec => ({
  type: "text",
  name: "Заголовок",
  text,
  layout: { width: "fill" },
  style: { fontSize: size, fontWeight: 700, lineHeight: 1.1 },
});

const p = (text: string, opts?: { size?: number; muted?: boolean; maxWidth?: number }): NodeSpec => ({
  type: "text",
  name: "Текст",
  text,
  layout: { width: "fill", maxWidth: opts?.maxWidth },
  style: { fontSize: opts?.size ?? 16, lineHeight: 1.6, textColor: opts?.muted ? "$muted" : "$text" },
});

const btn = (text: string, accent = true): NodeSpec => ({
  type: "button",
  name: "Кнопка",
  text,
  layout: { width: "hug" },
  style: accent
    ? { fill: "$accent", textColor: "$accentInk", radius: 10, fontSize: 15, fontWeight: 600 }
    : { fill: "transparent", textColor: "$text", radius: 10, borderWidth: 1, borderColor: "$line", fontSize: 15, fontWeight: 600 },
});

/** Строка/колонка-обёртка внутри секции (аналог «группы» из каталога). */
const group = (
  name: string,
  preset: LayoutType,
  children: NodeSpec[],
  extra?: { gap?: keyof typeof S; align?: "start" | "center" | "end"; justify?: "start" | "center" | "end" | "between"; pad?: number; fill?: string; radius?: number; border?: boolean; width?: "fill" | "hug"; columns?: number },
): NodeSpec => ({
  type: "container",
  name,
  layout: {
    width: extra?.width ?? "fill",
    height: "hug",
    direction: preset === "stack" ? "column" : "row",
    preset,
    columns: extra?.columns,
    gridTracks: preset === "columns" ? Array.from({ length: extra?.columns ?? 3 }, () => ({ fr: 1 })) : undefined,
    gap: S[extra?.gap ?? "sm"],
    padding: extra?.pad ?? 0,
    align: extra?.align ?? "start",
    justify: extra?.justify ?? "start",
  },
  style: {
    fill: extra?.fill ?? "transparent",
    radius: extra?.radius ?? 0,
    ...(extra?.border ? { borderWidth: 1, borderColor: "$line" } : {}),
  },
  children,
});

/** Карточка: типовая единица повтора в составных блоках. */
const card = (title: string, text: string, icon?: string): NodeSpec =>
  group(
    title,
    "stack",
    [
      ...(icon ? [{ type: "icon" as NodeType, name: "Иконка", iconName: icon, layout: { width: 36, height: 36 } }] : []),
      { type: "text", name: "Заголовок карточки", text: title, layout: { width: "fill" }, style: { fontSize: 20, fontWeight: 600 } },
      p(text, { size: 14, muted: true }),
    ],
    { gap: "sm", pad: S.md, fill: "$surface", radius: 12, border: true },
  );

/* ------------------------------------------------------------------ */
/* Каталог                                                             */
/* ------------------------------------------------------------------ */

export const BLOCKS: BlockDefinition[] = [
  /* ---------------- структура ---------------- */
  {
    type: "header",
    label: "Шапка",
    category: "structure",
    glyph: "▤",
    hint: "Логотип, меню, кнопка. Закреплена сверху",
    allowedLayouts: ["row", "columns"],
    build: () => ({
      type: "container",
      name: "Шапка",
      role: "header",
      sticky: true,
      layout: {
        width: "fill", height: "hug", direction: "row", preset: "row", container: "full",
        gap: S.md, padding: { t: S.sm, r: S.md, b: S.sm, l: S.md },
        align: "center", justify: "between",
      },
      style: { fill: "$bg", borderWidth: 1, borderColor: "$line", borderBottom: true },
      children: [
        { type: "text", name: "Логотип", text: "Бренд", layout: { width: "hug" }, style: { fontSize: 20, fontWeight: 700, letterSpacing: 1.2 } },
        group("Меню", "row", [
          { type: "text", name: "Пункт", text: "О нас", href: "#about", layout: { width: "hug" }, style: { fontSize: 14, underline: false } },
          { type: "text", name: "Пункт", text: "Услуги", href: "#services", layout: { width: "hug" }, style: { fontSize: 14, underline: false } },
          { type: "text", name: "Пункт", text: "Цены", href: "#pricing", layout: { width: "hug" }, style: { fontSize: 14, underline: false } },
          { type: "text", name: "Пункт", text: "Контакты", href: "#contacts", layout: { width: "hug" }, style: { fontSize: 14, underline: false } },
        ], { gap: "md", align: "center", width: "hug" }),
        btn("Связаться"),
      ],
    }),
  },
  {
    type: "footer",
    label: "Подвал",
    category: "structure",
    glyph: "▁",
    hint: "Колонки ссылок, копирайт, соцсети",
    allowedLayouts: ["columns", "row", "stack"],
    build: () => ({
      type: "container",
      name: "Подвал",
      role: "footer",
      layout: {
        width: "fill", height: "hug", direction: "row", preset: "columns", columns: 3,
        gridTracks: [{ fr: 1 }, { fr: 1 }, { fr: 1 }], container: "default",
        maxWidth: 1200, centered: true,
        gap: S.lg, padding: { t: S.xl, r: S.md, b: S.lg, l: S.md }, align: "start", justify: "start",
      },
      style: { fill: "$surface" },
      children: [
        group("Бренд", "stack", [
          { type: "text", name: "Логотип", text: "Бренд", layout: { width: "fill" }, style: { fontSize: 22, fontWeight: 700 } },
          p("Короткое описание компании в одну-две строки.", { size: 13, muted: true }),
        ], { gap: "xs" }),
        group("Ссылки", "stack", [
          { type: "text", name: "Заголовок", text: "Разделы", layout: { width: "fill" }, style: { fontSize: 12, uppercase: true, letterSpacing: 1.5, textColor: "$muted" } },
          { type: "list", name: "Список ссылок", items: ["О нас", "Услуги", "Цены", "Контакты"], layout: { width: "fill" }, style: { fontSize: 14 } },
        ], { gap: "xs" }),
        group("Контакты", "stack", [
          { type: "text", name: "Заголовок", text: "Контакты", layout: { width: "fill" }, style: { fontSize: 12, uppercase: true, letterSpacing: 1.5, textColor: "$muted" } },
          p("mail@example.com\n+7 000 000-00-00", { size: 14 }),
        ], { gap: "xs" }),
        { type: "divider", name: "Разделитель", layout: { width: "fill", gridSpan: "full" } },
        p("© 2026 Бренд. Все права защищены.", { size: 12, muted: true }),
      ],
    }),
  },
  {
    type: "section",
    label: "Пустая секция",
    category: "structure",
    glyph: "▢",
    hint: "Обёртка под свободный контент",
    build: () => section({ name: "Секция", children: [p("Содержимое секции.")] }),
  },
  {
    type: "spacer",
    label: "Распорка",
    category: "structure",
    glyph: "↕",
    hint: "Управляемый вертикальный воздух",
    build: () => ({ type: "spacer", name: "Распорка", layout: { width: "fill", height: S.xl } }),
  },
  {
    type: "divider",
    label: "Разделитель",
    category: "structure",
    glyph: "—",
    hint: "Линия между секциями",
    build: () => ({ type: "divider", name: "Разделитель", layout: { width: "fill" } }),
  },

  /* ---------------- контент ---------------- */
  {
    type: "hero",
    label: "Первый экран",
    category: "content",
    glyph: "◤",
    hint: "Крупный заголовок, подзаголовок, кнопки",
    allowedLayouts: ["stack"],
    build: () => section({
      name: "Первый экран", padY: "3xl", gap: "md", fill: "$surface",
      minHeight: 640, justify: "center", anchorId: "top",
      children: [
        eyebrow("Коротко о позиционировании"),
        h("Заголовок, который\nобъясняет ценность", 64),
        p("Подзаголовок на одну-две строки: что вы делаете и для кого.", { size: 20, muted: true, maxWidth: 620 }),
        group("Кнопки", "row", [btn("Основное действие"), btn("Подробнее", false)], { gap: "sm", align: "center", width: "hug" }),
      ],
    }),
  },
  {
    type: "heading",
    label: "Заголовок секции",
    category: "content",
    glyph: "H",
    hint: "Надзаголовок, заголовок, подпись",
    allowedLayouts: ["stack"],
    build: () => section({
      name: "Заголовок секции", padY: "lg", gap: "sm",
      children: [eyebrow("Раздел"), h("Заголовок секции", 40), p("Поясняющая строка под заголовком.", { muted: true, maxWidth: 640 })],
    }),
  },
  {
    type: "text",
    label: "Текстовый блок",
    category: "content",
    glyph: "¶",
    hint: "Длинный текст в читаемой колонке",
    allowedLayouts: ["stack", "columns"],
    build: () => section({
      name: "Текст", container: "text", gap: "sm",
      children: [
        h("Подзаголовок", 28),
        p("Абзац основного текста. Ширина колонки ограничена так, чтобы в строке было около семидесяти знаков — это комфортная длина для чтения."),
        p("Второй абзац. Здесь можно рассказать деталь, которая не влезла в первый."),
        { type: "list", name: "Список", items: ["Первый тезис", "Второй тезис", "Третий тезис"], layout: { width: "fill" } },
      ],
    }),
  },
  {
    type: "image",
    label: "Картинка",
    category: "content",
    glyph: "▣",
    hint: "Одно изображение с подписью",
    build: () => section({
      name: "Картинка", padY: "lg", gap: "xs",
      children: [
        { type: "image", name: "Изображение", layout: { width: "fill", height: 420 }, style: { radius: 12, objectFit: "cover" } },
        p("Подпись к изображению.", { size: 13, muted: true }),
      ],
    }),
  },
  {
    type: "gallery",
    label: "Галерея",
    category: "content",
    glyph: "▦",
    hint: "Сетка изображений, перестраивается сама",
    allowedLayouts: ["auto-grid", "columns", "masonry"],
    build: () => section({
      name: "Галерея", container: "wide", layout: "auto-grid", minColumnWidth: 280, gap: "sm",
      children: Array.from({ length: 6 }, (_, i) => ({
        type: "image" as NodeType,
        name: `Фото ${i + 1}`,
        layout: { width: "fill", height: 240 },
        style: { radius: 10, objectFit: "cover" },
      })),
    }),
  },
  {
    type: "video",
    label: "Видео",
    category: "content",
    glyph: "▶",
    hint: "YouTube, Vimeo или файл",
    build: () => section({
      name: "Видео", container: "narrow", padY: "lg",
      children: [{ type: "video", name: "Видео", videoProvider: "youtube", frameRatio: 16 / 9, layout: { width: "fill" } }],
    }),
  },

  /* ---------------- составные ---------------- */
  {
    type: "cards",
    label: "Сетка карточек",
    category: "composite",
    glyph: "⊞",
    hint: "Карточки, которые сами перестраиваются",
    allowedLayouts: ["auto-grid", "columns", "row"],
    build: () => section({
      name: "Карточки", layout: "auto-grid", minColumnWidth: 280, gap: "md",
      children: [
        card("Первая карточка", "Короткое описание преимущества или услуги."),
        card("Вторая карточка", "Короткое описание преимущества или услуги."),
        card("Третья карточка", "Короткое описание преимущества или услуги."),
      ],
    }),
  },
  {
    type: "features",
    label: "Преимущества",
    category: "composite",
    glyph: "✦",
    hint: "Иконка, заголовок, описание",
    allowedLayouts: ["auto-grid", "columns", "row"],
    build: () => section({
      name: "Преимущества", layout: "auto-grid", minColumnWidth: 260, gap: "lg",
      children: [
        card("Быстро", "Объяснение, почему это важно клиенту.", "bolt"),
        card("Надёжно", "Объяснение, почему это важно клиенту.", "shield"),
        card("Понятно", "Объяснение, почему это важно клиенту.", "check"),
      ],
    }),
  },
  {
    type: "steps",
    label: "Шаги",
    category: "composite",
    glyph: "①",
    hint: "Нумерованный процесс",
    allowedLayouts: ["columns", "row", "stack"],
    build: () => section({
      name: "Как это работает", layout: "columns", columns: 4, gap: "md",
      children: [1, 2, 3, 4].map((n) =>
        group(`Шаг ${n}`, "stack", [
          { type: "text", name: "Номер", text: `0${n}`, layout: { width: "fill" }, style: { fontSize: 32, fontWeight: 700, textColor: "$accent" } },
          { type: "text", name: "Название", text: `Шаг ${n}`, layout: { width: "fill" }, style: { fontSize: 18, fontWeight: 600 } },
          p("Что происходит на этом шаге.", { size: 14, muted: true }),
        ], { gap: "xs" }),
      ),
    }),
  },
  {
    type: "pricing",
    label: "Тарифы",
    category: "composite",
    glyph: "▥",
    hint: "Планы с ценой и списком возможностей",
    allowedLayouts: ["columns", "row"],
    build: () => section({
      name: "Тарифы", container: "narrow", layout: "columns", columns: 3, gap: "md",
      children: [
        ["Базовый", "0 ₽", false],
        ["Рабочий", "1 900 ₽", true],
        ["Команда", "4 900 ₽", false],
      ].map(([name, price, hot]) =>
        group(String(name), "stack", [
          { type: "text", name: "Название", text: String(name), layout: { width: "fill" }, style: { fontSize: 14, uppercase: true, letterSpacing: 1.5, textColor: "$muted" } },
          { type: "text", name: "Цена", text: String(price), layout: { width: "fill" }, style: { fontSize: 40, fontWeight: 700 } },
          { type: "divider", name: "Разделитель", layout: { width: "fill" } },
          { type: "list", name: "Возможности", items: ["Первая возможность", "Вторая возможность", "Третья возможность"], layout: { width: "fill" }, style: { fontSize: 14 } },
          btn("Выбрать", Boolean(hot)),
        ], { gap: "sm", pad: S.md, fill: "$surface", radius: 14, border: true }),
      ),
    }),
  },
  {
    type: "testimonials",
    label: "Отзывы",
    category: "composite",
    glyph: "❝",
    hint: "Цитаты клиентов с авторством",
    allowedLayouts: ["columns", "masonry", "stack"],
    build: () => section({
      name: "Отзывы", layout: "columns", columns: 3, gap: "md",
      children: [1, 2, 3].map((n) => ({
        type: "quote" as NodeType,
        name: `Отзыв ${n}`,
        text: "Короткая цитата клиента о результате, которого он добился.",
        cite: "Имя, должность",
        layout: { width: "fill" },
        style: { fontSize: 17 },
      })),
    }),
  },
  {
    type: "faq",
    label: "Вопрос-ответ",
    category: "composite",
    glyph: "?",
    hint: "Частые вопросы списком",
    allowedLayouts: ["stack", "columns"],
    build: () => section({
      name: "Вопросы и ответы", container: "narrow", gap: "sm",
      children: [1, 2, 3, 4].flatMap((n) => [
        group(`Вопрос ${n}`, "stack", [
          { type: "text", name: "Вопрос", text: `Вопрос ${n}, который задают чаще всего?`, layout: { width: "fill" }, style: { fontSize: 18, fontWeight: 600 } },
          p("Ответ в одну-две строки, по существу и без воды.", { size: 15, muted: true }),
        ], { gap: "xs" }),
        { type: "divider" as NodeType, name: "Разделитель", layout: { width: "fill" } },
      ]),
    }),
  },
  {
    type: "team",
    label: "Команда",
    category: "composite",
    glyph: "☺",
    hint: "Фото, имя, роль",
    allowedLayouts: ["auto-grid", "columns", "row"],
    build: () => section({
      name: "Команда", layout: "auto-grid", minColumnWidth: 220, gap: "md",
      children: [1, 2, 3, 4].map((n) =>
        group(`Участник ${n}`, "stack", [
          { type: "image", name: "Фото", layout: { width: "fill", height: 240 }, style: { radius: 12, objectFit: "cover" } },
          { type: "text", name: "Имя", text: "Имя Фамилия", layout: { width: "fill" }, style: { fontSize: 17, fontWeight: 600 } },
          p("Должность", { size: 13, muted: true }),
        ], { gap: "xs" }),
      ),
    }),
  },
  {
    type: "logos",
    label: "Логотипы",
    category: "composite",
    glyph: "◍",
    hint: "Клиенты и партнёры в ряд",
    allowedLayouts: ["auto-grid", "row", "columns"],
    build: () => section({
      name: "Нам доверяют", padY: "lg", layout: "auto-grid", minColumnWidth: 180, gap: "md", align: "center",
      children: Array.from({ length: 5 }, (_, i) => ({
        type: "image" as NodeType,
        name: `Логотип ${i + 1}`,
        layout: { width: "fill", height: 56 },
        style: { objectFit: "contain", opacity: 0.65 },
      })),
    }),
  },
  {
    type: "stats",
    label: "Цифры",
    category: "composite",
    glyph: "№",
    hint: "Показатели крупным кеглем",
    allowedLayouts: ["columns", "row"],
    build: () => section({
      name: "Цифры", padY: "lg", layout: "columns", columns: 4, gap: "md",
      children: [
        ["12", "лет на рынке"],
        ["480+", "проектов"],
        ["98%", "довольных клиентов"],
        ["24/7", "поддержка"],
      ].map(([value, label]) =>
        group(String(label), "stack", [
          { type: "text", name: "Значение", text: String(value), layout: { width: "fill" }, style: { fontSize: 44, fontWeight: 700, textColor: "$accent" } },
          p(String(label), { size: 13, muted: true }),
        ], { gap: "xs" }),
      ),
    }),
  },
  {
    type: "timeline",
    label: "Хронология",
    category: "composite",
    glyph: "⋮",
    hint: "События по годам",
    allowedLayouts: ["stack", "columns"],
    build: () => section({
      name: "Хронология", container: "narrow", gap: "md",
      children: [2021, 2023, 2025, 2026].map((year) =>
        group(String(year), "sidebar", [
          { type: "text", name: "Год", text: String(year), layout: { width: "fill" }, style: { fontSize: 20, fontWeight: 700, textColor: "$accent" } },
          group("Описание", "stack", [
            { type: "text", name: "Событие", text: "Что произошло", layout: { width: "fill" }, style: { fontSize: 17, fontWeight: 600 } },
            p("Пояснение к событию в одну строку.", { size: 14, muted: true }),
          ], { gap: "xs" }),
        ], { gap: "md" }),
      ),
    }),
  },

  /* ---------------- конверсия ---------------- */
  {
    type: "cta",
    label: "Призыв к действию",
    category: "conversion",
    glyph: "◉",
    hint: "Заголовок и кнопка на контрастном фоне",
    allowedLayouts: ["stack", "row"],
    build: () => section({
      name: "Призыв к действию", container: "narrow", padY: "2xl", gap: "md",
      fill: "$accent", align: "center",
      children: [
        { type: "text", name: "Заголовок", text: "Готовы начать?", layout: { width: "fill" }, style: { fontSize: 40, fontWeight: 700, textColor: "$accentInk", textAlign: "center" } },
        p("Одна строка, снимающая последнее возражение.", { size: 17 }),
        btn("Оставить заявку", false),
      ],
    }),
  },
  {
    type: "form",
    label: "Форма",
    category: "conversion",
    glyph: "▤",
    hint: "Поля в две колонки и кнопка отправки",
    allowedLayouts: ["columns", "stack"],
    build: () => section({
      name: "Форма", container: "narrow", layout: "columns", columns: 2, gap: "sm",
      children: [
        { type: "text", name: "Заголовок", text: "Оставьте заявку", layout: { width: "fill", gridSpan: "full" }, style: { fontSize: 32, fontWeight: 700 } },
        group("Имя", "stack", [
          { type: "text", name: "Подпись", text: "Имя", layout: { width: "fill" }, style: { fontSize: 12, uppercase: true, letterSpacing: 1.4, textColor: "$muted" } },
          { type: "input", name: "Поле имени", text: "Как к вам обращаться", layout: { width: "fill" } },
        ], { gap: "xs" }),
        group("Телефон", "stack", [
          { type: "text", name: "Подпись", text: "Телефон", layout: { width: "fill" }, style: { fontSize: 12, uppercase: true, letterSpacing: 1.4, textColor: "$muted" } },
          { type: "input", name: "Поле телефона", text: "+7 000 000-00-00", layout: { width: "fill" } },
        ], { gap: "xs" }),
        group("Сообщение", "stack", [
          { type: "text", name: "Подпись", text: "Сообщение", layout: { width: "fill" }, style: { fontSize: 12, uppercase: true, letterSpacing: 1.4, textColor: "$muted" } },
          { type: "input", name: "Поле сообщения", text: "Коротко о задаче", layout: { width: "fill", height: 96 } },
        ], { gap: "xs", width: "fill" }),
        { type: "button", name: "Отправить", text: "Отправить заявку", layout: { width: "fill", gridSpan: "full" }, style: { fill: "$accent", textColor: "$accentInk", radius: 10, fontSize: 15, fontWeight: 600 } },
        p("Нажимая кнопку, вы соглашаетесь с политикой обработки данных.", { size: 12, muted: true }),
      ],
    }),
  },
  {
    type: "subscribe",
    label: "Подписка",
    category: "conversion",
    glyph: "✉",
    hint: "Почта и кнопка в одну строку",
    allowedLayouts: ["stack", "row"],
    build: () => section({
      name: "Подписка", container: "narrow", padY: "lg", gap: "sm", align: "center",
      children: [
        h("Письма по делу", 32),
        p("Раз в месяц, без спама.", { muted: true }),
        group("Строка подписки", "row", [
          { type: "input", name: "Почта", text: "you@example.com", layout: { width: "fill" } },
          btn("Подписаться"),
        ], { gap: "xs", align: "center" }),
      ],
    }),
  },
  {
    type: "contacts",
    label: "Контакты",
    category: "conversion",
    glyph: "☎",
    hint: "Реквизиты рядом с картой",
    allowedLayouts: ["sidebar", "columns"],
    build: () => section({
      name: "Контакты", layout: "sidebar", gap: "lg",
      children: [
        group("Реквизиты", "stack", [
          eyebrow("Как нас найти"),
          h("Контакты", 34),
          p("Адрес: город, улица, дом\nТелефон: +7 000 000-00-00\nПочта: mail@example.com", { size: 15 }),
          group("Соцсети", "row", [
            { type: "icon", name: "Иконка", iconName: "mail", layout: { width: 32, height: 32 } },
            { type: "icon", name: "Иконка", iconName: "phone", layout: { width: 32, height: 32 } },
            { type: "icon", name: "Иконка", iconName: "pin", layout: { width: 32, height: 32 } },
          ], { gap: "xs", width: "hug" }),
        ], { gap: "sm" }),
        { type: "embed", name: "Карта", frameRatio: 4 / 3, layout: { width: "fill" }, style: { radius: 12 } },
      ],
    }),
  },

  /* ---------------- техническое ---------------- */
  {
    type: "embed",
    label: "Встраивание",
    category: "tech",
    glyph: "⧉",
    hint: "Виджет по ссылке в песочнице",
    build: () => section({
      name: "Встраивание", container: "narrow", padY: "lg",
      children: [{ type: "embed", name: "Виджет", frameRatio: 16 / 9, layout: { width: "fill" } }],
    }),
  },
  {
    type: "html",
    label: "Свой код",
    category: "tech",
    glyph: "</>",
    hint: "Произвольный HTML внутри секции",
    build: () => section({
      name: "Свой код", container: "narrow", padY: "lg",
      children: [{
        type: "container",
        name: "Код-слот",
        customCode: "// PLX-SLOT: свой код блока\n",
        layout: { width: "fill", height: 120, padding: S.md, direction: "column" },
        style: { fill: "$surface", radius: 10, borderWidth: 1, borderColor: "$line" },
        children: [p("Здесь будет ваш код. Правится в инспекторе.", { size: 13, muted: true })],
      }],
    }),
  },
  {
    type: "canvas",
    label: "Свободный холст",
    category: "tech",
    glyph: "✥",
    hint: "Точные координаты внутри секции",
    allowedLayouts: ["absolute"],
    build: () => ({
      type: "container",
      name: "Свободный холст",
      role: "section",
      layout: {
        width: "fill", height: 480, direction: "column", preset: "absolute", container: "full",
        gap: 0, padding: 0, align: "start", justify: "start",
      },
      style: { fill: "$surface" },
      children: [
        {
          type: "text", name: "Свободный текст", text: "Тяни меня куда угодно",
          layout: { position: "absolute", x: 64, y: 64, width: "hug" },
          style: { fontSize: 28, fontWeight: 700 },
        },
        {
          type: "image", name: "Свободное фото",
          layout: { position: "absolute", x: 64, y: 160, width: 320, height: 200 },
          style: { radius: 12, objectFit: "cover" },
        },
      ],
    }),
  },
];

/** Быстрый доступ по типу. */
export const BLOCK_BY_TYPE = new Map<BlockType, BlockDefinition>(BLOCKS.map((b) => [b.type, b]));

/** Блоки одной категории в порядке объявления. */
export const blocksOf = (category: BlockCategory): BlockDefinition[] =>
  BLOCKS.filter((b) => b.category === category);

/* ------------------------------------------------------------------ */
/* Отдельные элементы (не блоки, а «кирпичи» внутрь блока)             */
/* ------------------------------------------------------------------ */

export interface ElementDefinition {
  kind: NodeType;
  label: string;
  glyph: string;
  hint: string;
  group: "text" | "media" | "action" | "form" | "structure" | "smart";
  build?: () => NodeSpec;
}

export const ELEMENT_GROUPS: Array<{ id: ElementDefinition["group"]; label: string }> = [
  { id: "text", label: "Текст" },
  { id: "media", label: "Медиа" },
  { id: "action", label: "Действия" },
  { id: "form", label: "Поля формы" },
  { id: "structure", label: "Структура" },
  { id: "smart", label: "Умные" },
];

export const ELEMENTS: ElementDefinition[] = [
  { kind: "text", label: "Заголовок", glyph: "H", hint: "Крупный текст", group: "text", build: () => h("Заголовок", 40) },
  { kind: "text", label: "Подзаголовок", glyph: "h", hint: "Средний текст", group: "text", build: () => h("Подзаголовок", 24) },
  { kind: "text", label: "Абзац", glyph: "¶", hint: "Основной текст", group: "text", build: () => p("Текст абзаца.") },
  { kind: "text", label: "Надзаголовок", glyph: "▔", hint: "Мелкая подпись капсом", group: "text", build: () => eyebrow("Раздел") },
  { kind: "list", label: "Список", glyph: "≡", hint: "Маркированный или нумерованный", group: "text" },
  { kind: "quote", label: "Цитата", glyph: "❝", hint: "С автором и линией слева", group: "text" },
  { kind: "image", label: "Картинка", glyph: "▣", hint: "Фото или иллюстрация", group: "media" },
  { kind: "icon", label: "Иконка", glyph: "★", hint: "Глиф из встроенного набора", group: "media" },
  { kind: "video", label: "Видео", glyph: "▶", hint: "YouTube, Vimeo, файл", group: "media" },
  { kind: "embed", label: "Встраивание", glyph: "⧉", hint: "Виджет по ссылке", group: "media" },
  { kind: "button", label: "Кнопка", glyph: "▭", hint: "Основное действие", group: "action", build: () => btn("Кнопка") },
  { kind: "button", label: "Кнопка-контур", glyph: "▯", hint: "Второстепенное действие", group: "action", build: () => btn("Подробнее", false) },
  { kind: "text", label: "Ссылка", glyph: "↗", hint: "Текстовая ссылка", group: "action", build: () => ({ type: "text", name: "Ссылка", text: "Читать далее", href: "#", layout: { width: "hug" }, style: { fontSize: 15, underline: true, textColor: "$accent" } }) },
  { kind: "input", label: "Поле ввода", glyph: "▭", hint: "Одна строка", group: "form" },
  { kind: "input", label: "Многострочное", glyph: "▤", hint: "Текстовая область", group: "form", build: () => ({ type: "input", name: "Многострочное поле", text: "Сообщение", layout: { width: "fill", height: 96 } }) },
  { kind: "input", label: "Флажок", glyph: "☑", hint: "Согласие или выбор", group: "form", build: () => ({ type: "input", name: "Флажок", text: "", layout: { width: 18, height: 18 }, style: { radius: 3 } }) },
  { kind: "container", label: "Контейнер", glyph: "▢", hint: "Группа с своей раскладкой", group: "structure" },
  { kind: "divider", label: "Разделитель", glyph: "—", hint: "Линия", group: "structure" },
  { kind: "spacer", label: "Распорка", glyph: "↕", hint: "Вертикальный воздух", group: "structure" },
  { kind: "autonav", label: "Авто-навбар", glyph: "⌸", hint: "Меню из страниц проекта", group: "smart" },
  { kind: "autofooter", label: "Авто-подвал", glyph: "▁", hint: "Подвал с живым годом", group: "smart" },
  { kind: "breadcrumbs", label: "Хлебные крошки", glyph: "›", hint: "Путь по страницам", group: "smart" },
  { kind: "cmslist", label: "Список из БД", glyph: "▦", hint: "Записи таблицы", group: "smart" },
];

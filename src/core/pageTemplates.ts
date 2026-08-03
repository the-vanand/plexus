/**
 * РЕЕСТР ШАБЛОНОВ СТРАНИЦ — готовые страницы целиком.
 *
 * Каждый шаблон — это набор секций, собранных из существующих блоков
 * (`blocks.ts`) и вспомогательных NodeSpec-рецептов. Модуль чистый:
 * ни React, ни Pixi, ни DOM.
 *
 * Использование:
 *   const frameId = addFrameAt(wx, wy);
 *   for (const spec of template.sections()) insertSpec(spec, frameId);
 */
import type { NodeSpec, NodeType } from "./types";
import { BLOCK_BY_TYPE } from "./blocks";
import { SPACE_SCALE } from "./themes";

/* ------------------------------------------------------------------ */
/* Категории шаблонов                                                  */
/* ------------------------------------------------------------------ */

export type TemplateCategory =
  | "landing"
  | "business"
  | "portfolio"
  | "content"
  | "ecommerce"
  | "utility";

export interface TemplateCategoryDef {
  id: TemplateCategory;
  label: string;
  hint: string;
}

export const TEMPLATE_CATEGORIES: TemplateCategoryDef[] = [
  { id: "landing",   label: "Лендинг",   hint: "Одностраничные продающие сайты" },
  { id: "business",  label: "Компания",  hint: "Корпоративные сайты услуг" },
  { id: "portfolio", label: "Портфолио", hint: "Работы и проекты" },
  { id: "content",   label: "Контент",   hint: "Блог, статья, медиа" },
  { id: "ecommerce", label: "Магазин",   hint: "Каталог и карточки товаров" },
  { id: "utility",   label: "Служебное", hint: "Контакты, «О нас», FAQ" },
];

/* ------------------------------------------------------------------ */
/* Интерфейс шаблона                                                   */
/* ------------------------------------------------------------------ */

export interface PageTemplate {
  id: string;
  name: string;
  category: TemplateCategory;
  description: string;
  /** Ширина страницы-фрейма в пикселях. */
  pageWidth: number;
  /** Список секций-спецификаций сверху вниз. */
  sections(): NodeSpec[];
}

/* ------------------------------------------------------------------ */
/* Вспомогательные помощники (не дублируем blocks.ts — только ссылки) */
/* ------------------------------------------------------------------ */

/** Берём готовый build() из реестра — переиспользование без копирования. */
function block(type: Parameters<typeof BLOCK_BY_TYPE["get"]>[0]): NodeSpec {
  const def = BLOCK_BY_TYPE.get(type);
  if (!def) throw new Error(`Блок «${type}» не найден в реестре`);
  return def.build();
}

const S = SPACE_SCALE;

/** Пункт меню-ссылка. */
const navLink = (text: string, href: string): NodeSpec => ({
  type: "text",
  name: "Пункт",
  text,
  href,
  layout: { width: "hug" },
  style: { fontSize: 14, underline: false },
});

/** Кнопка акцентная. */
const btnAccent = (text: string): NodeSpec => ({
  type: "button",
  name: "Кнопка",
  text,
  layout: { width: "hug" },
  style: { fill: "$accent", textColor: "$accentInk", radius: 10, fontSize: 15, fontWeight: 600 },
});

/** Кнопка контурная. */
const btnOutline = (text: string): NodeSpec => ({
  type: "button",
  name: "Кнопка",
  text,
  layout: { width: "hug" },
  style: { fill: "transparent", textColor: "$text", radius: 10, borderWidth: 1, borderColor: "$line", fontSize: 15, fontWeight: 600 },
});

/** Надзаголовок-eyebrow. */
const eyebrow = (text: string): NodeSpec => ({
  type: "text",
  name: "Надзаголовок",
  text,
  layout: { width: "fill" },
  style: { fontSize: 11, fontWeight: 700, letterSpacing: 2.4, uppercase: true, textColor: "$accent" },
});

/** Заголовок нужного размера. */
const h = (text: string, size: number): NodeSpec => ({
  type: "text",
  name: "Заголовок",
  text,
  layout: { width: "fill" },
  style: { fontSize: size, fontWeight: 700, lineHeight: 1.1 },
});

/** Абзац. */
const p = (text: string, opts?: { size?: number; muted?: boolean; maxWidth?: number }): NodeSpec => ({
  type: "text",
  name: "Текст",
  text,
  layout: { width: "fill", maxWidth: opts?.maxWidth },
  style: { fontSize: opts?.size ?? 16, lineHeight: 1.6, textColor: opts?.muted ? "$muted" : "$text" },
});

/** Группа (горизонтальная или вертикальная). */
const group = (
  name: string,
  preset: "row" | "stack" | "columns" | "sidebar",
  children: NodeSpec[],
  extra?: {
    gap?: keyof typeof S;
    align?: "start" | "center" | "end";
    justify?: "start" | "center" | "end" | "between";
    pad?: number;
    fill?: string;
    radius?: number;
    border?: boolean;
    width?: "fill" | "hug";
    columns?: number;
  },
): NodeSpec => ({
  type: "container",
  name,
  layout: {
    width: extra?.width ?? "fill",
    height: "hug",
    direction: preset === "stack" ? "column" : "row",
    preset,
    columns: extra?.columns,
    gridTracks:
      preset === "columns"
        ? Array.from({ length: extra?.columns ?? 3 }, () => ({ fr: 1 }))
        : undefined,
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

/** Секция (внешний + внутренний контейнер с ограничением ширины). */
function section(opts: {
  name: string;
  container?: "full" | "wide" | "default" | "narrow" | "text";
  padY?: keyof typeof S;
  gap?: keyof typeof S;
  fill?: string;
  layout?: "stack" | "row" | "columns" | "auto-grid" | "sidebar";
  columns?: number;
  minColumnWidth?: number;
  align?: "start" | "center" | "end";
  justify?: "start" | "center" | "end" | "between";
  minHeight?: number;
  anchorId?: string;
  children: NodeSpec[];
}): NodeSpec {
  const cont = opts.container ?? "default";
  const containerWidths: Record<string, number | null> = {
    full: null, wide: 1400, default: 1200, narrow: 960, text: 720,
  };
  const width = containerWidths[cont] ?? 1200;
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
      padding: { t: S[opts.padY ?? "xl"], r: 0, b: S[opts.padY ?? "xl"], l: 0 },
      align: "start",
      justify: opts.justify ?? "start",
    },
    style: opts.fill ? { fill: opts.fill } : undefined,
    anchorId: opts.anchorId,
    children: [inner],
  };
}

/** Карточка с опциональной иконкой (переиспользование паттерна из blocks.ts). */
const featureCard = (title: string, text: string, icon?: string): NodeSpec =>
  group(
    title,
    "stack",
    [
      ...(icon
        ? [{ type: "icon" as NodeType, name: "Иконка", iconName: icon, layout: { width: 36, height: 36 } }]
        : []),
      { type: "text", name: "Заголовок карточки", text: title, layout: { width: "fill" }, style: { fontSize: 20, fontWeight: 600 } },
      p(text, { size: 14, muted: true }),
    ],
    { gap: "sm", pad: S.md, fill: "$surface", radius: 12, border: true },
  );

/** Шапка сайта (общая для большинства шаблонов). */
const siteHeader = (logoText: string, links: Array<[string, string]>, ctaText: string): NodeSpec => ({
  type: "container",
  name: "Шапка",
  role: "header",
  sticky: true,
  layout: {
    width: "fill",
    height: "hug",
    direction: "row",
    preset: "row",
    container: "full",
    gap: S.md,
    padding: { t: S.sm, r: S.md, b: S.sm, l: S.md },
    align: "center",
    justify: "between",
  },
  style: { fill: "$bg", borderWidth: 1, borderColor: "$line", borderBottom: true },
  children: [
    { type: "text", name: "Логотип", text: logoText, layout: { width: "hug" }, style: { fontSize: 20, fontWeight: 700, letterSpacing: 1.2 } },
    group(
      "Меню",
      "row",
      links.map(([text, href]) => navLink(text, href)),
      { gap: "md", align: "center", width: "hug" },
    ),
    btnAccent(ctaText),
  ],
});

/** Подвал сайта (общий для большинства шаблонов). */
const siteFooter = (
  brand: string,
  tagline: string,
  links: string[],
  contact: string,
): NodeSpec => ({
  type: "container",
  name: "Подвал",
  role: "footer",
  layout: {
    width: "fill",
    height: "hug",
    direction: "row",
    preset: "columns",
    columns: 3,
    gridTracks: [{ fr: 1 }, { fr: 1 }, { fr: 1 }],
    container: "default",
    maxWidth: 1200,
    centered: true,
    gap: S.lg,
    padding: { t: S.xl, r: S.md, b: S.lg, l: S.md },
    align: "start",
    justify: "start",
  },
  style: { fill: "$surface" },
  children: [
    group("Бренд", "stack", [
      { type: "text", name: "Логотип", text: brand, layout: { width: "fill" }, style: { fontSize: 22, fontWeight: 700 } },
      p(tagline, { size: 13, muted: true }),
    ], { gap: "xs" }),
    group("Ссылки", "stack", [
      { type: "text", name: "Заголовок", text: "Разделы", layout: { width: "fill" }, style: { fontSize: 12, uppercase: true, letterSpacing: 1.5, textColor: "$muted" } },
      { type: "list", name: "Список ссылок", items: links, layout: { width: "fill" }, style: { fontSize: 14 } },
    ], { gap: "xs" }),
    group("Контакты", "stack", [
      { type: "text", name: "Заголовок", text: "Контакты", layout: { width: "fill" }, style: { fontSize: 12, uppercase: true, letterSpacing: 1.5, textColor: "$muted" } },
      p(contact, { size: 14 }),
    ], { gap: "xs" }),
    { type: "divider", name: "Разделитель", layout: { width: "fill", gridSpan: "full" } },
    p(`© 2026 ${brand}. Все права защищены.`, { size: 12, muted: true }),
  ],
});

/* ------------------------------------------------------------------ */
/* Реестр шаблонов                                                     */
/* ------------------------------------------------------------------ */

export const PAGE_TEMPLATES: PageTemplate[] = [

  /* ---------------------------------------------------------------- */
  /* 1. Лендинг продукта — SaaS / приложение                          */
  /* ---------------------------------------------------------------- */
  {
    id: "product-landing",
    name: "Лендинг продукта",
    category: "landing",
    description: "Лендинг для SaaS или мобильного приложения: первый экран, преимущества, тарифы, отзывы, CTA.",
    pageWidth: 1440,
    sections(): NodeSpec[] {
      return [
        /* Шапка */
        siteHeader("Продукт", [
          ["Возможности", "#features"],
          ["Тарифы", "#pricing"],
          ["Отзывы", "#reviews"],
        ], "Попробовать бесплатно"),

        /* Hero */
        section({
          name: "Первый экран",
          padY: "3xl",
          gap: "md",
          fill: "$surface",
          minHeight: 640,
          justify: "center",
          anchorId: "top",
          children: [
            eyebrow("Новый подход к работе"),
            h("Всё, что нужно\nвашей команде — в одном месте", 64),
            p("Экономьте до 5 часов в неделю: автоматизируйте рутину, отслеживайте задачи и держите связь с коллегами.", { size: 20, muted: true, maxWidth: 620 }),
            group("Кнопки", "row", [
              btnAccent("Начать бесплатно"),
              btnOutline("Смотреть демо"),
            ], { gap: "sm", align: "center", width: "hug" }),
          ],
        }),

        /* Лого клиентов */
        section({
          name: "Нам доверяют",
          padY: "lg",
          layout: "auto-grid",
          minColumnWidth: 180,
          gap: "md",
          align: "center",
          children: [1, 2, 3, 4, 5].map((i) => ({
            type: "image" as NodeType,
            name: `Логотип ${i}`,
            layout: { width: "fill", height: 56 },
            style: { objectFit: "contain", opacity: 0.65 },
          })),
        }),

        /* Преимущества */
        section({
          name: "Преимущества",
          anchorId: "features",
          layout: "auto-grid",
          minColumnWidth: 260,
          gap: "lg",
          children: [
            featureCard("Быстрый старт", "Зарегистрируйтесь и начните работу за 5 минут — без установки и настройки.", "bolt"),
            featureCard("Командная работа", "Совместное редактирование, комментарии и история изменений в реальном времени.", "users"),
            featureCard("Автоматизация", "Настройте сценарии и забудьте о ручной рутине — система делает всё сама.", "cog"),
            featureCard("Безопасность", "Данные зашифрованы и резервируются автоматически. SOC 2 Type II.", "shield"),
            featureCard("Интеграции", "Подключите Slack, Google, Jira и 200+ других сервисов в один клик.", "plug"),
            featureCard("Аналитика", "Дашборды реального времени: видите узкие места до того, как они станут проблемой.", "chart"),
          ],
        }),

        /* Шаги / процесс */
        block("steps"),

        /* Тарифы */
        section({
          name: "Тарифы",
          anchorId: "pricing",
          container: "narrow",
          layout: "columns",
          columns: 3,
          gap: "md",
          children: [
            ["Старт", "0 ₽", false],
            ["Про", "1 490 ₽", true],
            ["Бизнес", "4 490 ₽", false],
          ].map(([name, price, hot]) =>
            group(String(name), "stack", [
              { type: "text", name: "Название", text: String(name), layout: { width: "fill" }, style: { fontSize: 14, uppercase: true, letterSpacing: 1.5, textColor: "$muted" } },
              { type: "text", name: "Цена", text: String(price), layout: { width: "fill" }, style: { fontSize: 40, fontWeight: 700 } },
              p("в месяц за пользователя", { size: 13, muted: true }),
              { type: "divider", name: "Разделитель", layout: { width: "fill" } },
              { type: "list", name: "Возможности", items: ["До 5 проектов", "Базовая аналитика", "Email-поддержка"], layout: { width: "fill" }, style: { fontSize: 14 } },
              hot ? btnAccent("Выбрать") : btnOutline("Выбрать"),
            ], { gap: "sm", pad: S.md, fill: "$surface", radius: 14, border: true }),
          ),
        }),

        /* Отзывы */
        section({
          name: "Отзывы клиентов",
          anchorId: "reviews",
          layout: "columns",
          columns: 3,
          gap: "md",
          children: [
            { type: "quote" as NodeType, name: "Отзыв 1", text: "Внедрили за один день и уже в первую неделю сэкономили 3 часа на согласованиях.", cite: "Мария Соколова, руководитель проектов", layout: { width: "fill" }, style: { fontSize: 16 } },
            { type: "quote" as NodeType, name: "Отзыв 2", text: "Наконец-то инструмент, который не нужно долго объяснять команде. Все разобрались за полчаса.", cite: "Алексей Фёдоров, CTO", layout: { width: "fill" }, style: { fontSize: 16 } },
            { type: "quote" as NodeType, name: "Отзыв 3", text: "Автоматизация отчётов освободила мне пятницы. Это бесценно.", cite: "Ирина Новикова, финансовый директор", layout: { width: "fill" }, style: { fontSize: 16 } },
          ],
        }),

        /* CTA */
        section({
          name: "Призыв к действию",
          container: "narrow",
          padY: "2xl",
          gap: "md",
          fill: "$accent",
          align: "center",
          children: [
            { type: "text", name: "Заголовок", text: "Начните прямо сейчас", layout: { width: "fill" }, style: { fontSize: 40, fontWeight: 700, textColor: "$accentInk", textAlign: "center" } },
            { type: "text", name: "Подзаголовок", text: "14 дней бесплатно. Карта не нужна. Отмена в любой момент.", layout: { width: "fill" }, style: { fontSize: 17, textColor: "$accentInk", textAlign: "center" } },
            btnOutline("Попробовать бесплатно"),
          ],
        }),

        /* Подвал */
        siteFooter(
          "Продукт",
          "Умный инструмент для продуктивных команд.",
          ["Возможности", "Тарифы", "Документация", "Блог"],
          "hello@product.ru\n+7 495 123-45-67",
        ),
      ];
    },
  },

  /* ---------------------------------------------------------------- */
  /* 2. Сайт компании / агентства услуг                               */
  /* ---------------------------------------------------------------- */
  {
    id: "company-services",
    name: "Сайт компании",
    category: "business",
    description: "Корпоративный сайт агентства или бюро услуг: о компании, услуги, команда, кейсы, контакты.",
    pageWidth: 1440,
    sections(): NodeSpec[] {
      return [
        siteHeader("Агентство", [
          ["О нас", "#about"],
          ["Услуги", "#services"],
          ["Команда", "#team"],
          ["Контакты", "#contacts"],
        ], "Оставить заявку"),

        /* Hero */
        section({
          name: "Первый экран",
          padY: "3xl",
          gap: "md",
          minHeight: 600,
          justify: "center",
          anchorId: "top",
          children: [
            eyebrow("Дизайн · Разработка · Стратегия"),
            h("Создаём цифровые продукты,\nкоторые работают на результат", 60),
            p("Команда из 18 специалистов с 10-летним опытом. Работаем с малым бизнесом и корпорациями по всей России.", { size: 18, muted: true, maxWidth: 640 }),
            group("Кнопки", "row", [
              btnAccent("Обсудить проект"),
              btnOutline("Наши работы"),
            ], { gap: "sm", align: "center", width: "hug" }),
          ],
        }),

        /* Цифры */
        section({
          name: "Цифры",
          padY: "lg",
          layout: "columns",
          columns: 4,
          gap: "md",
          fill: "$surface",
          children: [
            ["10 лет", "опыта на рынке"],
            ["320+", "реализованных проектов"],
            ["97%", "клиентов рекомендуют нас"],
            ["18", "специалистов в команде"],
          ].map(([value, label]) =>
            group(String(label), "stack", [
              { type: "text", name: "Значение", text: String(value), layout: { width: "fill" }, style: { fontSize: 44, fontWeight: 700, textColor: "$accent" } },
              p(String(label), { size: 13, muted: true }),
            ], { gap: "xs" }),
          ),
        }),

        /* Об агентстве */
        section({
          name: "О нас",
          layout: "sidebar",
          gap: "lg",
          anchorId: "about",
          children: [
            group("Текст", "stack", [
              eyebrow("О компании"),
              h("Делаем так, чтобы цифровые продукты работали", 36),
              p("Агентство основано в 2015 году. Мы занимаемся полным циклом создания сайтов и приложений: от исследования аудитории до запуска и поддержки.", { size: 16 }),
              p("Работаем прозрачно: фиксированные сроки, честные цены и промежуточные показы на каждом этапе. Вы всегда знаете, что происходит.", { size: 16, muted: true }),
              group("Кнопки", "row", [
                btnAccent("Наш подход"),
                btnOutline("Кейсы"),
              ], { gap: "sm", width: "hug" }),
            ], { gap: "md" }),
            { type: "image" as NodeType, name: "Фото офиса", layout: { width: "fill", height: 440 }, style: { radius: 16, objectFit: "cover" } },
          ],
        }),

        /* Услуги */
        section({
          name: "Услуги",
          layout: "auto-grid",
          minColumnWidth: 280,
          gap: "md",
          anchorId: "services",
          children: [
            featureCard("UX/UI-дизайн", "Исследуем аудиторию, проектируем интерфейс и доводим визуал до идеала."),
            featureCard("Веб-разработка", "Создаём быстрые и надёжные сайты на современных технологиях."),
            featureCard("Мобильные приложения", "iOS и Android: от прототипа до релиза в App Store и Google Play."),
            featureCard("Брендинг", "Логотип, айдентика, гайдлайн — всё, что нужно для узнаваемости."),
            featureCard("Стратегия и аналитика", "Находим точки роста и формулируем план на понятном языке."),
            featureCard("Техническая поддержка", "Следим за проектом после запуска: обновления, безопасность, скорость."),
          ],
        }),

        /* Команда */
        section({
          name: "Команда",
          layout: "auto-grid",
          minColumnWidth: 220,
          gap: "md",
          anchorId: "team",
          children: [
            ["Дмитрий Волков", "Генеральный директор"],
            ["Анна Петрова", "Арт-директор"],
            ["Игорь Смирнов", "Lead-разработчик"],
            ["Екатерина Орлова", "UX-исследователь"],
          ].map(([name, role]) =>
            group(String(name), "stack", [
              { type: "image" as NodeType, name: "Фото", layout: { width: "fill", height: 240 }, style: { radius: 12, objectFit: "cover" } },
              { type: "text" as NodeType, name: "Имя", text: String(name), layout: { width: "fill" }, style: { fontSize: 17, fontWeight: 600 } },
              p(String(role), { size: 13, muted: true }),
            ], { gap: "xs" }),
          ),
        }),

        /* Контакты */
        section({
          name: "Контакты",
          layout: "sidebar",
          gap: "lg",
          anchorId: "contacts",
          children: [
            group("Реквизиты", "stack", [
              eyebrow("Свяжитесь с нами"),
              h("Обсудим ваш проект", 34),
              p("Москва, ул. Тверская, д. 12, офис 304\nПн–Пт: 10:00–19:00", { size: 15 }),
              p("hello@agency.ru\n+7 495 000-00-00", { size: 15 }),
              group("Кнопки", "row", [
                btnAccent("Написать нам"),
              ], { gap: "xs", width: "hug" }),
            ], { gap: "sm" }),
            { type: "embed" as NodeType, name: "Карта", frameRatio: 4 / 3, layout: { width: "fill" }, style: { radius: 12 } },
          ],
        }),

        siteFooter(
          "Агентство",
          "Цифровые продукты для вашего бизнеса.",
          ["О нас", "Услуги", "Команда", "Контакты"],
          "hello@agency.ru\n+7 495 000-00-00",
        ),
      ];
    },
  },

  /* ---------------------------------------------------------------- */
  /* 3. Портфолио дизайнера / фотографа                               */
  /* ---------------------------------------------------------------- */
  {
    id: "creative-portfolio",
    name: "Портфолио",
    category: "portfolio",
    description: "Портфолио дизайнера или фотографа: работы сеткой, биография, контакты.",
    pageWidth: 1440,
    sections(): NodeSpec[] {
      return [
        /* Минималистичная шапка */
        {
          type: "container",
          name: "Шапка",
          role: "header",
          sticky: true,
          layout: {
            width: "fill",
            height: "hug",
            direction: "row",
            preset: "row",
            container: "full",
            gap: S.md,
            padding: { t: S.sm, r: S.md, b: S.sm, l: S.md },
            align: "center",
            justify: "between",
          },
          style: { fill: "$bg", borderWidth: 1, borderColor: "$line", borderBottom: true },
          children: [
            { type: "text", name: "Логотип", text: "Имя Фамилия", layout: { width: "hug" }, style: { fontSize: 18, fontWeight: 700 } },
            group("Меню", "row", [
              navLink("Работы", "#works"),
              navLink("Обо мне", "#about"),
              navLink("Контакт", "#contact"),
            ], { gap: "md", align: "center", width: "hug" }),
          ],
        },

        /* Hero — крупное имя */
        section({
          name: "Первый экран",
          padY: "3xl",
          gap: "sm",
          minHeight: 500,
          align: "center",
          justify: "center",
          anchorId: "top",
          children: [
            eyebrow("Дизайнер · Москва"),
            h("Имя Фамилия", 80),
            p("Создаю визуальные истории, которые удерживают внимание\nи доводят до действия.", { size: 20, muted: true, maxWidth: 580 }),
            group("Кнопки", "row", [btnAccent("Посмотреть работы")], { gap: "sm", align: "center", width: "hug" }),
          ],
        }),

        /* Галерея работ */
        section({
          name: "Работы",
          container: "wide",
          layout: "auto-grid",
          minColumnWidth: 340,
          gap: "sm",
          anchorId: "works",
          children: [1, 2, 3, 4, 5, 6].map((i) => ({
            type: "image" as NodeType,
            name: `Проект ${i}`,
            layout: { width: "fill", height: i % 3 === 0 ? 360 : 280 },
            style: { radius: 10, objectFit: "cover" },
          })),
        }),

        /* О себе */
        section({
          name: "Обо мне",
          layout: "sidebar",
          gap: "2xl",
          anchorId: "about",
          children: [
            { type: "image" as NodeType, name: "Портрет", layout: { width: "fill", height: 420 }, style: { radius: 16, objectFit: "cover" } },
            group("Текст", "stack", [
              eyebrow("О дизайнере"),
              h("8 лет в профессии — каждый проект как первый", 36),
              p("Специализируюсь на брендинге, айдентике и UX/UI. Работала с компаниями из 12 стран — от стартапов до Fortune 500.", { size: 16 }),
              p("До дизайна окончила архитектурный факультет: именно оттуда внимание к пропорциям и функциональности.", { size: 16, muted: true }),
              { type: "list", name: "Навыки", items: ["Figma, Sketch, Adobe CC", "Брендинг и айдентика", "Пользовательские исследования", "Моушн-дизайн"], layout: { width: "fill" }, style: { fontSize: 15 } },
            ], { gap: "md" }),
          ],
        }),

        /* Блок подписки / CTA */
        section({
          name: "Контакт",
          container: "narrow",
          padY: "2xl",
          gap: "md",
          fill: "$surface",
          align: "center",
          anchorId: "contact",
          children: [
            eyebrow("Готовы к сотрудничеству?"),
            h("Напишите мне", 40),
            p("Расскажите о проекте — отвечу в течение дня.", { size: 16, muted: true }),
            group("Кнопки", "row", [
              btnAccent("Написать письмо"),
              btnOutline("Telegram"),
            ], { gap: "sm", align: "center", width: "hug" }),
          ],
        }),

        /* Подвал. Минимализм шаблона — не повод оставлять страницу без
           контактов и <footer>: иначе портфолио выпадает из общего набора
           и теряет семантику, которую проверяет стенд. */
        siteFooter(
          "Имя Фамилия",
          "Брендинг, айдентика и цифровой продукт.",
          ["Работы", "Обо мне", "Услуги", "Контакты"],
          "hello@portfolio.ru\nTelegram: @designer",
        ),
      ];
    },
  },

  /* ---------------------------------------------------------------- */
  /* 4. Статья / блог-пост                                            */
  /* ---------------------------------------------------------------- */
  {
    id: "blog-article",
    name: "Статья блога",
    category: "content",
    description: "Шаблон длинной читаемой статьи: шапка, заголовок с мета, тело текста, подписка, подвал.",
    pageWidth: 1200,
    sections(): NodeSpec[] {
      return [
        /* Лёгкая шапка */
        {
          type: "container",
          name: "Шапка",
          role: "header",
          sticky: true,
          layout: {
            width: "fill",
            height: "hug",
            direction: "row",
            preset: "row",
            container: "full",
            gap: S.md,
            padding: { t: S.sm, r: S.md, b: S.sm, l: S.md },
            align: "center",
            justify: "between",
          },
          style: { fill: "$bg", borderWidth: 1, borderColor: "$line", borderBottom: true },
          children: [
            { type: "text", name: "Логотип", text: "Блог", layout: { width: "hug" }, style: { fontSize: 18, fontWeight: 700 } },
            group("Меню", "row", [
              navLink("Все статьи", "/blog"),
              navLink("Подписаться", "#subscribe"),
            ], { gap: "md", align: "center", width: "hug" }),
          ],
        },

        /* Заголовок статьи */
        section({
          name: "Шапка статьи",
          container: "text",
          padY: "2xl",
          gap: "md",
          children: [
            eyebrow("Маркетинг · 7 мин чтения"),
            h("Как написать лендинг, который конвертирует:\n5 приёмов с примерами", 48),
            p("Разбираемся, почему большинство лендингов теряют клиентов на первом экране, и показываем, как это исправить.", { size: 18, muted: true }),
            group("Авторство", "row", [
              { type: "image" as NodeType, name: "Аватар", layout: { width: 40, height: 40 }, style: { radius: 20, objectFit: "cover" } },
              group("Мета", "stack", [
                { type: "text" as NodeType, name: "Имя автора", text: "Анна Смирнова", layout: { width: "hug" }, style: { fontSize: 14, fontWeight: 600 } },
                { type: "text" as NodeType, name: "Дата", text: "3 августа 2026", layout: { width: "hug" }, style: { fontSize: 13, textColor: "$muted" } },
              ], { gap: "xs" }),
            ], { gap: "sm", align: "center", width: "hug" }),
          ],
        }),

        /* Обложка */
        section({
          name: "Обложка",
          padY: "none",
          children: [
            { type: "image" as NodeType, name: "Обложка статьи", layout: { width: "fill", height: 480 }, style: { objectFit: "cover" } },
          ],
        }),

        /* Тело статьи */
        section({
          name: "Тело статьи",
          container: "text",
          gap: "md",
          children: [
            h("Почему первый экран решает всё", 28),
            p("У вас есть около трёх секунд, чтобы объяснить посетителю, что вы предлагаете и зачем ему это нужно. Если в первом экране нет чёткого ответа на вопрос «что я получу?», пользователь уходит."),
            p("Исследование Nielsen Norman Group показало: 80% времени пользователи тратят на верхнюю часть страницы. Значит, работать нужно именно с ней.", { muted: true }),
            { type: "quote" as NodeType, name: "Цитата", text: "Лендинг — это не сайт. Это аргумент. И как любой аргумент, он должен быть ясным, кратким и убедительным.", cite: "Перес Матос, маркетолог", layout: { width: "fill" }, style: { fontSize: 18, italic: true } },
            h("1. Формулируйте ценность, а не описание", 24),
            p("«Сервис автоматизации задач» — это описание. «Экономьте 5 часов в неделю» — это ценность. Разница кажется небольшой, но конверсия меняется в разы."),
            { type: "list" as NodeType, name: "Список", items: ["Назовите конкретный результат", "Укажите, для кого это", "Снимите главное возражение"], layout: { width: "fill" }, style: { fontSize: 16, lineHeight: 1.6 } },
            h("2. Одна кнопка — одно действие", 24),
            p("Чем больше кнопок, тем ниже конверсия каждой. Определите одно главное действие и сделайте его очевидным. Второстепенные действия можно добавить, но не конкурирующими."),
          ],
        }),

        /* Подписка */
        section({
          name: "Подписка",
          container: "narrow",
          padY: "lg",
          gap: "sm",
          fill: "$surface",
          align: "center",
          anchorId: "subscribe",
          children: [
            h("Получайте статьи первыми", 28),
            p("Раз в неделю — без воды, только полезное.", { muted: true }),
            group("Строка подписки", "row", [
              { type: "input" as NodeType, name: "Почта", text: "your@email.com", layout: { width: "fill" } },
              btnAccent("Подписаться"),
            ], { gap: "xs", align: "center" }),
          ],
        }),

        /* Ещё статьи */
        section({
          name: "Читайте также",
          layout: "columns",
          columns: 3,
          gap: "md",
          children: [
            ["Как написать хорошую рассылку: 7 шагов", "Практическое руководство по email-маркетингу без спама."],
            ["SEO в 2026 году: что работает на самом деле", "Разбираем, какие методы дают результат, а какие — только отнимают время."],
            ["Ошибки в дизайне кнопок, которые режут конверсию", "Маленькие детали UX, которые незаметны, но влияют на бизнес-метрики."],
          ].map(([title, desc]) =>
            group(String(title), "stack", [
              { type: "image" as NodeType, name: "Обложка", layout: { width: "fill", height: 180 }, style: { radius: 8, objectFit: "cover" } },
              { type: "text" as NodeType, name: "Заголовок", text: String(title), layout: { width: "fill" }, style: { fontSize: 17, fontWeight: 600, lineHeight: 1.3 } },
              p(String(desc), { size: 13, muted: true }),
            ], { gap: "xs" }),
          ),
        }),

        siteFooter(
          "Блог",
          "Практические материалы о маркетинге и дизайне.",
          ["Все статьи", "Авторы", "Рубрики", "Подписаться"],
          "editors@blog.ru",
        ),
      ];
    },
  },

  /* ---------------------------------------------------------------- */
  /* 5. Интернет-магазин / каталог                                    */
  /* ---------------------------------------------------------------- */
  {
    id: "shop-catalog",
    name: "Каталог магазина",
    category: "ecommerce",
    description: "Страница категории интернет-магазина: баннер, фильтры, сетка товаров, подписка.",
    pageWidth: 1440,
    sections(): NodeSpec[] {
      return [
        siteHeader("Магазин", [
          ["Каталог", "#catalog"],
          ["Акции", "#sale"],
          ["Доставка", "#delivery"],
          ["О нас", "#about"],
        ], "Корзина"),

        /* Баннер */
        section({
          name: "Баннер категории",
          padY: "2xl",
          gap: "sm",
          fill: "$surface",
          minHeight: 320,
          anchorId: "top",
          children: [
            eyebrow("Новая коллекция · Весна 2026"),
            h("Одежда для активного отдыха", 52),
            p("Более 400 моделей от ведущих брендов. Доставка по России — от 2 дней.", { size: 18, muted: true, maxWidth: 560 }),
            group("Кнопки", "row", [
              btnAccent("Смотреть каталог"),
              btnOutline("Акции"),
            ], { gap: "sm", align: "center", width: "hug" }),
          ],
        }),

        /* Полоса доверия */
        section({
          name: "Гарантии",
          padY: "lg",
          layout: "columns",
          columns: 4,
          gap: "md",
          fill: "$surface",
          children: [
            ["Бесплатная доставка", "от 3 000 ₽", "truck"],
            ["Возврат 30 дней", "без вопросов", "refresh"],
            ["Оригинальные товары", "100% гарантия", "check"],
            ["Поддержка 24/7", "по телефону и чату", "headset"],
          ].map(([title, sub, icon]) =>
            group(String(title), "row", [
              { type: "icon" as NodeType, name: "Иконка", iconName: String(icon), layout: { width: 32, height: 32 } },
              group("Текст", "stack", [
                { type: "text" as NodeType, name: "Заголовок", text: String(title), layout: { width: "fill" }, style: { fontSize: 14, fontWeight: 600 } },
                p(String(sub), { size: 12, muted: true }),
              ], { gap: "xs" }),
            ], { gap: "sm", align: "center" }),
          ),
        }),

        /* Каталог с фильтрами */
        section({
          name: "Каталог",
          layout: "sidebar",
          gap: "lg",
          anchorId: "catalog",
          children: [
            /* Фильтры */
            group("Фильтры", "stack", [
              { type: "text" as NodeType, name: "Заголовок", text: "Фильтры", layout: { width: "fill" }, style: { fontSize: 16, fontWeight: 700 } },
              { type: "divider" as NodeType, name: "Разделитель", layout: { width: "fill" } },
              { type: "text" as NodeType, name: "Категория", text: "Категория", layout: { width: "fill" }, style: { fontSize: 13, uppercase: true, letterSpacing: 1.4, textColor: "$muted" } },
              { type: "list" as NodeType, name: "Список", items: ["Куртки", "Брюки", "Обувь", "Аксессуары"], layout: { width: "fill" }, style: { fontSize: 14 } },
              { type: "divider" as NodeType, name: "Разделитель", layout: { width: "fill" } },
              { type: "text" as NodeType, name: "Бренды", text: "Бренды", layout: { width: "fill" }, style: { fontSize: 13, uppercase: true, letterSpacing: 1.4, textColor: "$muted" } },
              { type: "list" as NodeType, name: "Список", items: ["The North Face", "Salomon", "Mammut", "Arc'teryx"], layout: { width: "fill" }, style: { fontSize: 14 } },
            ], { gap: "sm", pad: S.md, fill: "$surface", radius: 12, border: true }),

            /* Сетка товаров */
            group("Товары", "stack", [
              group("Сортировка", "row", [
                p("48 товаров", { size: 14, muted: true }),
                group("Сорт. по:", "row", [
                  { type: "text" as NodeType, name: "Популярное", text: "Популярное", layout: { width: "hug" }, style: { fontSize: 14, underline: false } },
                ], { gap: "xs", align: "center", justify: "end", width: "hug" }),
              ], { gap: "sm", align: "center", justify: "between" }),

              group("Сетка", "stack", [
                group("Ряд 1", "columns", [
                  ["Куртка Mountain Pro", "8 990 ₽"],
                  ["Брюки Trail X", "4 490 ₽"],
                  ["Ботинки Summit", "12 990 ₽"],
                  ["Флис Mid Layer", "3 990 ₽"],
                ].map(([name, price]) =>
                  group(String(name), "stack", [
                    { type: "image" as NodeType, name: "Фото товара", layout: { width: "fill", height: 240 }, style: { radius: 8, objectFit: "cover" } },
                    { type: "text" as NodeType, name: "Название", text: String(name), layout: { width: "fill" }, style: { fontSize: 14, fontWeight: 600 } },
                    { type: "text" as NodeType, name: "Цена", text: String(price), layout: { width: "fill" }, style: { fontSize: 16, fontWeight: 700, textColor: "$accent" } },
                    btnAccent("В корзину"),
                  ], { gap: "xs", fill: "$surface", radius: 10, border: true, pad: S.sm }),
                ), { gap: "md", columns: 4 }),
              ], { gap: "sm" }),
            ], { gap: "md" }),
          ],
        }),

        /* Акции */
        section({
          name: "Акции",
          padY: "2xl",
          gap: "sm",
          fill: "$accent",
          align: "center",
          anchorId: "sale",
          children: [
            eyebrow("Горящее предложение"),
            { type: "text" as NodeType, name: "Заголовок", text: "−30% на все куртки\nдо конца недели", layout: { width: "fill" }, style: { fontSize: 48, fontWeight: 700, textColor: "$accentInk", textAlign: "center" } },
            { type: "text" as NodeType, name: "Подзаголовок", text: "Успейте выбрать до воскресенья включительно.", layout: { width: "fill" }, style: { fontSize: 17, textColor: "$accentInk", textAlign: "center" } },
            btnOutline("Смотреть акции"),
          ],
        }),

        siteFooter(
          "Магазин",
          "Снаряжение для активного отдыха и туризма.",
          ["Каталог", "Новинки", "Акции", "Доставка и оплата"],
          "shop@example.ru\n8 800 123-45-67",
        ),
      ];
    },
  },

  /* ---------------------------------------------------------------- */
  /* 6. Страница контактов                                             */
  /* ---------------------------------------------------------------- */
  {
    id: "contacts-page",
    name: "Страница контактов",
    category: "utility",
    description: "Отдельная страница «Контакты»: реквизиты, карта, форма обратной связи, FAQ.",
    pageWidth: 1440,
    sections(): NodeSpec[] {
      return [
        siteHeader("Компания", [
          ["Главная", "/"],
          ["Услуги", "/services"],
          ["О нас", "/about"],
          ["Контакты", "/contacts"],
        ], "Написать нам"),

        /* Заголовок страницы */
        section({
          name: "Заголовок страницы",
          container: "narrow",
          padY: "2xl",
          gap: "sm",
          align: "center",
          anchorId: "top",
          children: [
            eyebrow("Мы открыты для диалога"),
            h("Контакты", 56),
            p("Отвечаем на все сообщения в течение одного рабочего дня.\nЕсли срочно — звоните.", { size: 18, muted: true }),
          ],
        }),

        /* Реквизиты и карта */
        section({
          name: "Адрес и карта",
          layout: "sidebar",
          gap: "lg",
          children: [
            group("Реквизиты", "stack", [
              group("Офис", "stack", [
                { type: "text" as NodeType, name: "Подпись", text: "Офис", layout: { width: "fill" }, style: { fontSize: 12, uppercase: true, letterSpacing: 1.5, textColor: "$muted" } },
                p("г. Москва, ул. Тверская, д. 12,\nофис 304, 2-й этаж", { size: 15 }),
              ], { gap: "xs" }),
              group("Телефон", "stack", [
                { type: "text" as NodeType, name: "Подпись", text: "Телефон", layout: { width: "fill" }, style: { fontSize: 12, uppercase: true, letterSpacing: 1.5, textColor: "$muted" } },
                p("+7 495 000-00-00\n+7 800 000-00-00 (бесплатно)", { size: 15 }),
              ], { gap: "xs" }),
              group("Почта", "stack", [
                { type: "text" as NodeType, name: "Подпись", text: "Почта", layout: { width: "fill" }, style: { fontSize: 12, uppercase: true, letterSpacing: 1.5, textColor: "$muted" } },
                p("info@company.ru — общие вопросы\npress@company.ru — СМИ и партнёры", { size: 15 }),
              ], { gap: "xs" }),
              group("Часы работы", "stack", [
                { type: "text" as NodeType, name: "Подпись", text: "Часы работы", layout: { width: "fill" }, style: { fontSize: 12, uppercase: true, letterSpacing: 1.5, textColor: "$muted" } },
                p("Понедельник–пятница: 10:00–19:00\nСуббота: 11:00–16:00\nВоскресенье: выходной", { size: 15 }),
              ], { gap: "xs" }),
            ], { gap: "lg" }),
            { type: "embed" as NodeType, name: "Карта", frameRatio: 4 / 3, layout: { width: "fill" }, style: { radius: 12 } },
          ],
        }),

        /* Форма обратной связи */
        section({
          name: "Форма",
          container: "narrow",
          layout: "columns",
          columns: 2,
          gap: "sm",
          fill: "$surface",
          children: [
            { type: "text" as NodeType, name: "Заголовок", text: "Напишите нам", layout: { width: "fill", gridSpan: "full" }, style: { fontSize: 32, fontWeight: 700 } },
            p("Заполните форму, и мы свяжемся с вами в ближайшее время.", { muted: true }),
            group("Имя", "stack", [
              { type: "text" as NodeType, name: "Подпись", text: "Имя", layout: { width: "fill" }, style: { fontSize: 12, uppercase: true, letterSpacing: 1.4, textColor: "$muted" } },
              { type: "input" as NodeType, name: "Поле имени", text: "Как к вам обращаться", layout: { width: "fill" } },
            ], { gap: "xs" }),
            group("Телефон", "stack", [
              { type: "text" as NodeType, name: "Подпись", text: "Телефон", layout: { width: "fill" }, style: { fontSize: 12, uppercase: true, letterSpacing: 1.4, textColor: "$muted" } },
              { type: "input" as NodeType, name: "Поле телефона", text: "+7 000 000-00-00", layout: { width: "fill" } },
            ], { gap: "xs" }),
            group("Тема", "stack", [
              { type: "text" as NodeType, name: "Подпись", text: "Тема", layout: { width: "fill" }, style: { fontSize: 12, uppercase: true, letterSpacing: 1.4, textColor: "$muted" } },
              { type: "input" as NodeType, name: "Поле темы", text: "Кратко о вашем вопросе", layout: { width: "fill" } },
            ], { gap: "xs" }),
            group("Сообщение", "stack", [
              { type: "text" as NodeType, name: "Подпись", text: "Сообщение", layout: { width: "fill" }, style: { fontSize: 12, uppercase: true, letterSpacing: 1.4, textColor: "$muted" } },
              { type: "input" as NodeType, name: "Поле сообщения", text: "Подробности вашего запроса", layout: { width: "fill", height: 96 } },
            ], { gap: "xs" }),
            { type: "button" as NodeType, name: "Отправить", text: "Отправить сообщение", layout: { width: "fill", gridSpan: "full" }, style: { fill: "$accent", textColor: "$accentInk", radius: 10, fontSize: 15, fontWeight: 600 } },
            p("Нажимая кнопку, вы соглашаетесь с политикой обработки персональных данных.", { size: 12, muted: true }),
          ],
        }),

        /* FAQ */
        section({
          name: "Частые вопросы",
          container: "narrow",
          gap: "sm",
          children: [
            eyebrow("FAQ"),
            h("Часто задаваемые вопросы", 36),
            ...[1, 2, 3, 4].flatMap((n): NodeSpec[] => {
              const questions = [
                ["Сколько стоит базовый пакет услуг?", "Стоимость зависит от объёма задач. Базовый пакет — от 50 000 ₽. Отправьте запрос, и мы пришлём детальное предложение в течение дня."],
                ["Как быстро вы отвечаете на запросы?", "На электронную почту отвечаем в течение рабочего дня. На звонки — сразу. Для срочных вопросов есть телеграм-чат поддержки."],
                ["Работаете ли вы с клиентами из других городов?", "Да, работаем удалённо по всей России и за рубежом. Онлайн-формат никак не влияет на качество — у нас налажены все процессы."],
                ["Можно ли посетить офис для встречи?", "Конечно. Запишитесь на встречу по телефону или почте — выберем удобное для вас время."],
              ];
              const [q, a] = questions[n - 1] ?? [`Вопрос ${n}`, `Ответ ${n}`];
              return [
                group(String(q), "stack", [
                  { type: "text" as NodeType, name: "Вопрос", text: String(q), layout: { width: "fill" }, style: { fontSize: 18, fontWeight: 600 } },
                  p(String(a), { size: 15, muted: true }),
                ], { gap: "xs" }),
                { type: "divider" as NodeType, name: "Разделитель", layout: { width: "fill" } },
              ];
            }),
          ],
        }),

        siteFooter(
          "Компания",
          "Помогаем бизнесу расти.",
          ["Главная", "Услуги", "О нас", "Контакты"],
          "info@company.ru\n+7 495 000-00-00",
        ),
      ];
    },
  },

  /* ---------------------------------------------------------------- */
  /* 7. Страница «О компании»                                         */
  /* ---------------------------------------------------------------- */
  {
    id: "about-page",
    name: "О компании",
    category: "business",
    description: "Страница «О нас»: история, миссия, ценности, команда, цифры, хронология.",
    pageWidth: 1440,
    sections(): NodeSpec[] {
      return [
        siteHeader("Компания", [
          ["О нас", "#top"],
          ["История", "#history"],
          ["Команда", "#team"],
          ["Контакты", "/contacts"],
        ], "Написать нам"),

        /* Hero */
        section({
          name: "Первый экран",
          padY: "3xl",
          gap: "md",
          minHeight: 520,
          fill: "$surface",
          anchorId: "top",
          children: [
            eyebrow("О компании"),
            h("Делаем продукты,\nв которые верим сами", 60),
            p("С 2010 года мы помогаем компаниям строить цифровую инфраструктуру, которая выдерживает настоящий рост. Честно, без лишнего.", { size: 18, muted: true, maxWidth: 640 }),
          ],
        }),

        /* Миссия */
        section({
          name: "Миссия",
          layout: "sidebar",
          gap: "2xl",
          children: [
            { type: "image" as NodeType, name: "Фото", layout: { width: "fill", height: 400 }, style: { radius: 16, objectFit: "cover" } },
            group("Текст", "stack", [
              eyebrow("Наша миссия"),
              h("Делать сложное понятным", 36),
              p("Мы верим, что хорошая технология должна быть невидимой: она работает, решает задачи и не отвлекает от главного."),
              p("Каждый наш проект — это разговор: мы погружаемся в контекст, задаём неудобные вопросы и предлагаем решения, которые проходят проверку временем.", { muted: true }),
            ], { gap: "md" }),
          ],
        }),

        /* Цифры */
        section({
          name: "Цифры",
          padY: "lg",
          layout: "columns",
          columns: 4,
          gap: "md",
          fill: "$surface",
          children: [
            ["15 лет", "работаем на рынке"],
            ["500+", "реализованных проектов"],
            ["40+", "стран-клиентов"],
            ["120", "специалистов"],
          ].map(([value, label]) =>
            group(String(label), "stack", [
              { type: "text" as NodeType, name: "Значение", text: String(value), layout: { width: "fill" }, style: { fontSize: 44, fontWeight: 700, textColor: "$accent" } },
              p(String(label), { size: 13, muted: true }),
            ], { gap: "xs" }),
          ),
        }),

        /* Ценности */
        section({
          name: "Ценности",
          layout: "auto-grid",
          minColumnWidth: 260,
          gap: "lg",
          children: [
            featureCard("Честность", "Говорим то, что думаем, — даже если это неудобно. Клиент всегда знает правду."),
            featureCard("Качество", "Не выпускаем то, чем не гордимся. Лучше задержать на день, чем отдать непродуманное."),
            featureCard("Открытость", "Процессы прозрачны: промежуточные показы, открытые каналы, доступность команды."),
            featureCard("Рост", "Постоянно учимся и экспериментируем. Не используем вчерашние решения для завтрашних задач."),
          ],
        }),

        /* Хронология */
        section({
          name: "История",
          container: "narrow",
          gap: "md",
          anchorId: "history",
          children: [
            eyebrow("История"),
            h("Путь с 2010 по сегодня", 36),
            ...[2010, 2015, 2019, 2023, 2026].map((year) => {
              const events: Record<number, [string, string]> = {
                2010: ["Основание", "Небольшая студия из четырёх человек начинает работу в маленьком офисе на Таганке."],
                2015: ["Первые 100 проектов", "Переезжаем в новый офис, расширяемся до 20 человек. Запускаем первый собственный продукт."],
                2019: ["Выход на международный рынок", "Первые клиенты из Европы и Азии. Открываем удалённые офисы в Берлине и Дубае."],
                2023: ["Масштабирование", "В команде 80 специалистов. Запускаем корпоративное направление для компаний из Fortune 500."],
                2026: ["Сегодня", "120 человек, 500+ проектов, присутствие в 40+ странах. Продолжаем расти."],
              };
              const [title, desc] = events[year] ?? [String(year), "Событие"];
              return group(String(year), "sidebar", [
                { type: "text" as NodeType, name: "Год", text: String(year), layout: { width: "fill" }, style: { fontSize: 20, fontWeight: 700, textColor: "$accent" } },
                group("Описание", "stack", [
                  { type: "text" as NodeType, name: "Событие", text: String(title), layout: { width: "fill" }, style: { fontSize: 17, fontWeight: 600 } },
                  p(String(desc), { size: 14, muted: true }),
                ], { gap: "xs" }),
              ], { gap: "md" });
            }),
          ],
        }),

        /* Команда */
        section({
          name: "Команда",
          layout: "auto-grid",
          minColumnWidth: 220,
          gap: "md",
          anchorId: "team",
          children: [
            ["Сергей Ковалёв", "Основатель и CEO"],
            ["Мария Белова", "Chief Design Officer"],
            ["Антон Зайцев", "Chief Technology Officer"],
            ["Ольга Никитина", "Head of Partnerships"],
            ["Максим Громов", "Lead Engineer"],
            ["Юлия Карпова", "UX Research Lead"],
          ].map(([name, role]) =>
            group(String(name), "stack", [
              { type: "image" as NodeType, name: "Фото", layout: { width: "fill", height: 240 }, style: { radius: 12, objectFit: "cover" } },
              { type: "text" as NodeType, name: "Имя", text: String(name), layout: { width: "fill" }, style: { fontSize: 17, fontWeight: 600 } },
              p(String(role), { size: 13, muted: true }),
            ], { gap: "xs" }),
          ),
        }),

        /* CTA */
        section({
          name: "Призыв",
          container: "narrow",
          padY: "2xl",
          gap: "md",
          fill: "$surface",
          align: "center",
          children: [
            h("Хотите присоединиться к команде?", 36),
            p("Открытые вакансии — на странице карьеры. Или просто напишите: мы всегда рады хорошим людям.", { size: 16, muted: true }),
            group("Кнопки", "row", [
              btnAccent("Открытые вакансии"),
              btnOutline("Написать нам"),
            ], { gap: "sm", align: "center", width: "hug" }),
          ],
        }),

        siteFooter(
          "Компания",
          "Делаем продукты, в которые верим сами.",
          ["Главная", "О нас", "Услуги", "Контакты"],
          "info@company.ru\n+7 495 000-00-00",
        ),
      ];
    },
  },
];

/** Быстрый доступ по id. */
export const TEMPLATE_BY_ID = new Map<string, PageTemplate>(
  PAGE_TEMPLATES.map((t) => [t.id, t]),
);

/** Шаблоны одной категории. */
export const templatesOf = (category: TemplateCategory): PageTemplate[] =>
  PAGE_TEMPLATES.filter((t) => t.category === category);

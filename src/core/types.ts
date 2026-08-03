/**
 * ЯДРО PLEXUS — модель документа.
 *
 * Здесь нет ни Pixi, ни React, ни Tauri: чистые типы и данные.
 * Это осознанное архитектурное решение — рендерер (сегодня PixiJS,
 * завтра Rust + wgpu) потребляет модель через тонкий интерфейс.
 */

import type { ThemeSpec } from "./themes";

/**
 * Типы узлов сцены. instance — экземпляр компонента.
 * autonav/autofooter/breadcrumbs/cmslist — «умные» элементы: знают про
 * страницы сайта и таблицы БД (Спринт 4).
 */
export type NodeType =
  | "frame" | "container" | "text" | "button" | "image" | "input" | "instance"
  | "autonav" | "autofooter" | "breadcrumbs" | "cmslist"
  // элементы из каталога типов: то, что раньше приходилось собирать вручную
  | "divider" | "spacer" | "list" | "quote" | "icon" | "video" | "embed";

/**
 * Размер по оси:
 *  - число  — фиксированные пиксели;
 *  - "hug"  — обнять содержимое (fit-content);
 *  - "fill" — заполнить доступное место (flex: 1 / 100%).
 */
export type SizeMode = number | "hug" | "fill";

export type Direction = "row" | "column";
export type Align = "start" | "center" | "end" | "stretch" | "baseline";
export type Justify = "start" | "center" | "end" | "between" | "around" | "evenly";

/**
 * ТИП РАСКЛАДКИ — как дети распределяются внутри контейнера.
 *
 * Это не новая механика поверх старой, а ИМЯ для набора уже существующих
 * свойств: пресет разворачивается в direction / gap / gridTracks / autoGrid.
 * Пользователь выбирает «авто-сетка», а не «grid-template-columns:
 * repeat(auto-fit, minmax(250px, 1fr))».
 *
 *  stack     — вертикальный стек (значение по умолчанию)
 *  row       — горизонтальный ряд, с переносом или без
 *  columns   — строго N колонок одинаковой ширины
 *  auto-grid — адаптивная сетка БЕЗ медиазапросов: колонки считаются от
 *              доступной ширины и минимальной ширины карточки
 *  sidebar   — узкая колонка + основная
 *  masonry   — кладка: элементы разной высоты без дыр
 *  absolute  — свободные координаты (холст)
 */
export type LayoutType =
  | "stack" | "row" | "columns" | "auto-grid" | "sidebar" | "masonry" | "absolute";

/**
 * ТИП КОНТЕЙНЕРА — насколько широко расходится содержимое.
 * Фон при этом остаётся во всю ширину: за него отвечает сам узел,
 * а за ширину контента — maxWidth + центрирование.
 */
export type ContainerType = "full" | "wide" | "default" | "narrow" | "text" | "custom";

/**
 * Шаг шкалы отступов. Хранить токен, а не пиксели: смена темы меняет ритм
 * всей страницы сразу, и на макете не появляется 78/80/82px «на глаз».
 */
export type SpaceToken = "none" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";

/** Значение отступа: токен темы либо точные пиксели. */
export type SpaceValue = SpaceToken | number;

/** Настройки адаптивной сетки (auto-grid). */
export interface AutoGridSpec {
  /** Минимальная ширина карточки в px — от неё считается число колонок. */
  minColumnWidth: number;
  /** auto-fit сжимает пустые дорожки, auto-fill оставляет их. */
  mode: "auto-fit" | "auto-fill";
}

/**
 * Отступы по сторонам. Раньше padding был одним числом, и импорт реального
 * сайта разваливался: `padding: 90px 4vw` схлопывался в 90 со всех сторон,
 * а лонгхенды `padding-top`/`padding-left` не читались вовсе.
 * Число по-прежнему допустимо (равномерный отступ) — старые проекты живут.
 */
export interface Sides {
  t: number;
  r: number;
  b: number;
  l: number;
}

export type PaddingValue = number | Sides;

/** Дорожка grid-сетки: доля свободного места либо фиксированные пиксели. */
export interface GridTrack {
  fr?: number;
  px?: number;
}

/** Auto-layout свойства узла (отображаются во flexbox/grid почти 1:1). */
export interface LayoutProps {
  /** flow — участвует в потоке родителя; absolute — escape hatch, точные координаты. */
  position: "flow" | "absolute";
  /** Координаты: у absolute-узлов — относительно родителя, у фреймов — мировые (на холсте). */
  x: number;
  y: number;
  /**
   * Правая/нижняя привязка absolute-узла. Когда заданы обе стороны по оси
   * (как у `inset: 0`), узел РАСТЯГИВАЕТСЯ между ними — так работают
   * полноэкранные фото-подложки и градиентные шторки hero-секций.
   */
  right?: number | null;
  bottom?: number | null;
  width: SizeMode;
  height: SizeMode;
  /** Потолок ширины (CSS max-width) — та самая «колонка страницы». */
  maxWidth?: number;
  /** margin-inline: auto — контент центрируется внутри родителя. */
  centered?: boolean;
  /**
   * Внешние отступы. В модели их не было вовсе, и весь вертикальный ритм
   * импортированной страницы пропадал: `.eyebrow{margin:0 0 28px}`,
   * `.hero-content{margin-left:8vw}` — блоки слипались и прижимались к краю.
   * Схлопывание соседних вертикальных margin (как в блочном потоке CSS)
   * НЕ выполняется: раскладка здесь flex/grid, где его тоже нет.
   */
  margin?: Sides;
  /** Свойства контейнера (direction/gap/padding/align/justify) — для frame и container. */
  direction: Direction;
  gap: number;
  /** Межрядный зазор в сетке (grid row-gap); для flex не используется. */
  rowGap?: number;
  padding: PaddingValue;
  align: Align;
  justify: Justify;
  /**
   * Колонки CSS Grid. Если задано — контейнер раскладывается сеткой:
   * дети переносятся по рядам, ряд высотой по самому высокому элементу.
   * Без этого grid-вёрстка (а её на реальных сайтах большинство)
   * схлопывалась в одну строку.
   */
  gridTracks?: GridTrack[];
  /** Сколько колонок занимает элемент в сетке родителя ("full" = вся строка). */
  gridSpan?: number | "full";
  /**
   * ПРЕСЕТ РАСКЛАДКИ. Хранится вместе с развёрнутыми свойствами, а не вместо
   * них: решателю нужны конкретные dorozhki, а интерфейсу — понятное имя.
   * Пресет — источник истины при переключении, дальше можно донастроить руками.
   */
  preset?: LayoutType;
  /** Число колонок для пресета "columns" (2–6). */
  columns?: number;
  /** Адаптивная сетка: колонки считаются от доступной ширины. */
  autoGrid?: AutoGridSpec;
  /** Сайдбар: ширина узкой колонки и с какой она стороны. */
  sidebar?: { width: number; side: "left" | "right" };
  /** Перенос строк в ряду (flex-wrap). */
  wrap?: boolean;
  /** Обратный порядок детей (row-reverse / column-reverse). */
  reverse?: boolean;
  /**
   * ПРЕСЕТ КОНТЕЙНЕРА: ограничение ширины содержимого. Разворачивается в
   * maxWidth + centered + боковые отступы, значения берутся из темы.
   */
  container?: ContainerType;
  /** Поворот вокруг центра, в градусах. Визуальный transform, не влияет на flow-раскладку. */
  rotation: number;
}

/** Визуальный стиль узла. */
export interface StyleProps {
  /** Заливка (hex) или "transparent". */
  fill: string;
  /** Прозрачность заливки 0..1 (из rgba). Полупрозрачные шапки и шторки. */
  fillAlpha?: number;
  textColor: string;
  radius: number;
  fontSize: number;
  fontWeight: 400 | 500 | 600 | 700;
  /**
   * Семейство шрифта (список как в CSS: `Georgia, 'Times New Roman', serif`).
   * КРИТИЧНО для раскладки: измеритель и рендерер обязаны брать шрифт отсюда.
   * Пока поля не было, всё мерилось шрифтом темы по эвристике «кегль ≥ 24»,
   * метрики расходились с оригиналом — и текст «съезжал».
   */
  fontFamily?: string;
  /** Фоновая картинка (url). Именно так реальные сайты несут hero-фото. */
  backgroundImage?: string;
  /** Фоновый градиент — сырое CSS-значение, в кодоген уходит без потерь. */
  backgroundGradient?: string;
  /** Как вписывать фон/картинку. */
  backgroundSize?: "cover" | "contain" | "auto";
  backgroundPosition?: string;
  /** object-fit для картинок. */
  objectFit?: "cover" | "contain" | "fill";
  /** Типографика (панель форматирования текста). */
  italic?: boolean;
  strike?: boolean;
  textAlign?: "left" | "center" | "right";
  /** Межбуквенный интервал в px (letter-spacing) — важен для люкс-типографики. */
  letterSpacing?: number;
  /** ЗАГЛАВНЫЕ (text-transform: uppercase). */
  uppercase?: boolean;
  /** Множитель межстрочного интервала (line-height). */
  lineHeight?: number;
  /** Рамка: толщина + цвет (border). */
  borderWidth?: number;
  borderColor?: string;
  /**
   * Рамка на одной стороне. Реальные сайты рисуют так разделители:
   * `border-top` у секций, `border-bottom` у полей формы,
   * `border-left` у колонок-карточек.
   */
  borderTop?: boolean;
  borderBottom?: boolean;
  borderLeft?: boolean;
  /** Подчёркивание ссылки. false — источник явно снял его (`text-decoration:none`). */
  underline?: boolean;
  /** Прозрачность 0..1. */
  opacity?: number;
}

/** Анимация появления при прокрутке (reveal-on-scroll). */
export interface RevealSpec {
  /** Тип: fade / вверх / вниз / масштаб. */
  kind: "fade" | "up" | "down" | "zoom";
  /** Длительность, мс. */
  duration: number;
  /** Задержка, мс. */
  delay: number;
}

/** Узел scene graph. Дети хранятся как массив id — модель плоская (Record). */
export interface SceneNode {
  id: string;
  type: NodeType;
  name: string;
  layout: LayoutProps;
  style: StyleProps;
  /** Текстовое содержимое (text / button / placeholder для input). */
  text?: string;
  /** URL картинки (image). */
  src?: string;
  /**
   * Собственные пропорции картинки (ширина/высота). Нужны, чтобы фото не
   * растягивалось: высота считается от реальной ширины, а не от константы 160.
   */
  aspectRatio?: number;
  /** Ссылка (text / button) — в коде элемент становится <a href>. */
  href?: string;
  /** Пункты списка (type="list"). */
  items?: string[];
  /** Нумерованный список вместо маркированного. */
  ordered?: boolean;
  /** Автор цитаты (type="quote"). */
  cite?: string;
  /** Имя иконки из встроенного набора (type="icon"). */
  iconName?: string;
  /** Провайдер видео и его адрес (type="video"). */
  videoProvider?: "youtube" | "vimeo" | "file";
  /** Пропорции рамки видео/встраивания, например 16/9. */
  frameRatio?: number;
  /** Для type="instance": id компонента из doc.components. */
  componentRef?: string;
  /** Для type="cmslist": id таблицы БД из doc.dbTables. */
  tableRef?: string;
  /** Код-слот (two-way Phase 1): свой JS, выполняется по клику; round-trip через маркеры PLX-SLOT. */
  customCode?: string;
  /** Шапка: закрепить сверху (position: sticky; top: 0). */
  sticky?: boolean;
  /** Шапка: фон при прокрутке (токен/hex) — «затвердевание» как у site-header.scrolled. */
  scrollFill?: string;
  /** Якорь: HTML id элемента — цель для ссылок #id (навигация по секциям). */
  anchorId?: string;
  /** Семантическая роль — влияет на тег в коде и на подпись в редакторе. */
  role?: "header" | "footer" | "section" | "nav";
  /** Анимация появления при прокрутке. */
  reveal?: RevealSpec;
  children: string[];
  parent: string | null;
}

/** Компонент («символ»): мастер живёт на холсте, экземпляры его отражают. */
export interface ComponentDef {
  name: string;
  rootId: string;
}

/** Триггер связи. v1 — клик; дальше: submit, hover, load, таймер… */
export type WireTrigger = "click";

/**
 * Действие связи («провода»):
 *  - navigate — перейти на страницу (цель — фрейм);
 *  - toggle   — показать/скрыть цель;
 *  - submit   — собрать поля контейнера-цели и отправить в бэкенд.
 */
export type WireAction = "navigate" | "toggle" | "submit";

/** Связь «триггер → действие» между элементами (визуально — провод). */
export interface Wire {
  id: string;
  sourceId: string;
  targetId: string;
  trigger: WireTrigger;
  action: WireAction;
}

/* ---------------- база данных (визуальная схема → Prisma) ---------------- */

export type DbFieldType = "String" | "Int" | "Float" | "Boolean" | "DateTime";

export interface DbField {
  id: string;
  name: string;
  type: DbFieldType;
  required: boolean;
}

export interface DbTable {
  id: string;
  name: string;
  x: number;
  y: number;
  fields: DbField[];
}

/** Связь «один-ко-многим»: from (один) → to (многие). */
export interface DbRelation {
  id: string;
  fromTableId: string;
  toTableId: string;
}

export type SiteTarget = "static" | "next";
export type DbProvider = "sqlite" | "postgres";

/** Документ: узлы + страницы + связи + компоненты + тема + схема БД. */
export interface SceneDocument {
  nodes: Record<string, SceneNode>;
  rootFrames: string[];
  wires: Wire[];
  components: Record<string, ComponentDef>;
  theme: ThemeSpec;
  dbTables: Record<string, DbTable>;
  dbRelations: DbRelation[];
  dbProvider: DbProvider;
  /** Целевой кодоген: статический сайт или Next.js + Prisma. */
  siteTarget: SiteTarget;
}

/** Прямоугольник в мировых координатах (результат решателя раскладки). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Камера холста: world → screen: sx = (wx - x) * zoom. */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

/** Умная направляющая (v — вертикальная линия на x=at, h — горизонтальная на y=at). */
export interface Guide {
  axis: "v" | "h";
  at: number;
  from: number;
  to: number;
}

/** Бейдж расстояния между элементами (PowerPoint-style "N px"). */
export interface GapBadge {
  x: number;
  y: number;
  label: string;
}

/** Индикатор места вставки при перетаскивании flow-ребёнка. */
export interface InsertionLine {
  axis: "v" | "h";
  at: number;
  from: number;
  to: number;
}

/** Результат измерения текста. */
export interface TextSize {
  w: number;
  h: number;
}

/**
 * Функция измерения текста — внедряется снаружи.
 * ВАЖНО: реализация обязана использовать тот же движок, что и рендерер
 * (Pixi CanvasTextMetrics), чтобы перенос строк в раскладке и на экране
 * совпадал байт-в-байт. wrapWidth задаёт перенос по словам.
 */
export type MeasureFn = (
  text: string,
  fontSize: number,
  fontWeight: number,
  fontFamily: string,
  wrapWidth?: number,
  extra?: { letterSpacing?: number; lineHeight?: number; uppercase?: boolean },
) => TextSize;

/** Реэкспорт: описание поддерева живёт в scene.ts, но нужно и в типах. */
export type { NodeSpec } from "./scene";

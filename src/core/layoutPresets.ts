/**
 * ПРЕСЕТЫ РАСКЛАДКИ И КОНТЕЙНЕРА.
 *
 * Пользователь выбирает «авто-сетка» или «узкий контейнер», а не
 * `grid-template-columns: repeat(auto-fit, minmax(250px, 1fr))` и
 * `max-width: 960px; margin-inline: auto`. Этот модуль — единственное место,
 * где имя превращается в конкретные свойства раскладки.
 *
 * Почему пресет хранится ВМЕСТЕ с развёрнутыми свойствами, а не вместо них:
 * решателю и кодогену нужны дорожки и направление, а интерфейсу — понятное
 * имя и возможность донастроить результат руками, не теряя подписи.
 *
 * Модуль чистый: ни DOM, ни Pixi, ни React.
 */
import type {
  Align, ContainerType, Justify, LayoutProps, LayoutType, NodeType, Sides, SpaceToken,
} from "./types";
import { CONTAINER_WIDTHS, SPACE_SCALE, type ResolvedTheme } from "./themes";

/* ------------------------------------------------------------------ */
/* Метаданные для панели инструментов                                  */
/* ------------------------------------------------------------------ */

export interface LayoutPresetDef {
  type: LayoutType;
  label: string;
  /** Что это даёт — подсказка в интерфейсе, а не название CSS-свойства. */
  hint: string;
  /** Схематичное превью результата: иконка должна показывать РЕЗУЛЬТАТ. */
  glyph: string;
}

export const LAYOUT_PRESETS: LayoutPresetDef[] = [
  { type: "stack", label: "Стек", hint: "Друг под другом сверху вниз", glyph: "▤" },
  { type: "row", label: "Ряд", hint: "В одну строку, можно с переносом", glyph: "▥" },
  { type: "columns", label: "Колонки", hint: "Строго N колонок равной ширины", glyph: "▦" },
  { type: "auto-grid", label: "Авто-сетка", hint: "Колонки сами перестраиваются под ширину", glyph: "⊞" },
  { type: "sidebar", label: "Сайдбар", hint: "Узкая колонка плюс основная", glyph: "▧" },
  { type: "masonry", label: "Кладка", hint: "Разная высота без дыр", glyph: "▩" },
  { type: "absolute", label: "Свободно", hint: "Точные координаты внутри блока", glyph: "✥" },
];

export interface ContainerPresetDef {
  type: ContainerType;
  label: string;
  /** Ширина в px или null для «во всю ширину». */
  width: number | null;
  hint: string;
}

export const CONTAINER_PRESETS: ContainerPresetDef[] = [
  { type: "full", label: "Во всю ширину", width: null, hint: "Слайдеры, карты, фоновое видео" },
  { type: "wide", label: "Широкий", width: 1400, hint: "Галереи, широкие сетки" },
  { type: "default", label: "Обычный", width: 1200, hint: "Основной контейнер сайта" },
  { type: "narrow", label: "Узкий", width: 960, hint: "Формы, тарифы" },
  { type: "text", label: "Текстовый", width: 720, hint: "Длинный текст, ~70 знаков в строке" },
  { type: "custom", label: "Свой", width: null, hint: "Точное значение вручную" },
];

/* ------------------------------------------------------------------ */
/* Ограничения из документа                                            */
/* ------------------------------------------------------------------ */

/** Колонок меньше двух не бывает, больше шести — нечитаемо даже на десктопе. */
export const COLUMNS_MIN = 2;
export const COLUMNS_MAX = 6;
/** Уже — и карточки превращаются в полоски. */
export const MIN_COLUMN_WIDTH_FLOOR = 160;
/** Глубина вложенности контейнеров: защита от неуправляемого дерева. */
export const MAX_GROUP_DEPTH = 4;

/**
 * Какие раскладки осмысленны для роли узла. Свободный выбор всех типов
 * для всего порождает бессмысленные комбинации (авто-сетка у заголовка).
 */
export const ALLOWED_LAYOUTS: Record<string, LayoutType[]> = {
  header: ["row", "columns"],
  footer: ["row", "columns", "stack"],
  nav: ["row"],
  section: ["stack", "row", "columns", "auto-grid", "sidebar", "masonry", "absolute"],
};

/* ------------------------------------------------------------------ */
/* Разворачивание пресета раскладки                                    */
/* ------------------------------------------------------------------ */

const clampColumns = (n: number | undefined): number =>
  Math.max(COLUMNS_MIN, Math.min(COLUMNS_MAX, Math.round(n ?? 3)));

/**
 * Возвращает НОВУЮ раскладку с развёрнутым пресетом.
 *
 * Сохраняет то, что пользователь уже настроил (промежутки, отступы,
 * выравнивание), и меняет только то, что определяет сам тип раскладки:
 * направление, дорожки сетки, перенос.
 */
export function applyLayoutPreset(
  layout: LayoutProps,
  preset: LayoutType,
  theme?: ResolvedTheme,
): LayoutProps {
  const next: LayoutProps = { ...layout, preset };
  // чистим свойства предыдущего пресета, чтобы они не «протекали»
  delete next.gridTracks;
  delete next.autoGrid;
  delete next.sidebar;
  delete next.columns;
  next.wrap = undefined;

  switch (preset) {
    case "stack":
      next.direction = "column";
      break;

    case "row":
      next.direction = "row";
      next.wrap = layout.wrap ?? false;
      break;

    case "columns": {
      const n = clampColumns(layout.columns);
      next.direction = "row";
      next.columns = n;
      next.gridTracks = Array.from({ length: n }, () => ({ fr: 1 }));
      break;
    }

    case "auto-grid":
      // дорожки не фиксируем: их считает решатель от доступной ширины,
      // а кодоген выводит настоящий repeat(auto-fit, minmax(...))
      next.direction = "row";
      next.autoGrid = {
        minColumnWidth: Math.max(MIN_COLUMN_WIDTH_FLOOR, layout.autoGrid?.minColumnWidth ?? 260),
        mode: layout.autoGrid?.mode ?? "auto-fit",
      };
      break;

    case "sidebar": {
      const width = Math.max(120, layout.sidebar?.width ?? 280);
      const side = layout.sidebar?.side ?? "left";
      next.direction = "row";
      next.sidebar = { width, side };
      next.gridTracks = side === "left" ? [{ px: width }, { fr: 1 }] : [{ fr: 1 }, { px: width }];
      break;
    }

    case "masonry": {
      const n = clampColumns(layout.columns);
      next.direction = "row";
      next.columns = n;
      break;
    }

    case "absolute":
      // сам контейнер остаётся в потоке; absolute — про его ДЕТЕЙ,
      // поэтому высота обязана быть задана, иначе блок схлопнется в ноль
      next.direction = "column";
      if (typeof next.height !== "number") next.height = 480;
      break;
  }

  if (theme && next.gap === 0 && preset !== "stack") next.gap = theme.space.md;
  return next;
}

/**
 * Пресет, которому соответствует текущая раскладка.
 * Нужен для узлов, пришедших из импорта: у них пресета нет, но структура
 * уже читается — и панель свойств должна показать осмысленное имя.
 */
export function inferLayoutPreset(layout: LayoutProps): LayoutType {
  if (layout.preset) return layout.preset;
  if (layout.autoGrid) return "auto-grid";
  if (layout.sidebar) return "sidebar";
  if (layout.gridTracks && layout.gridTracks.length > 1) {
    const allFr = layout.gridTracks.every((t) => t.fr !== undefined);
    const equal = new Set(layout.gridTracks.map((t) => t.fr)).size === 1;
    if (allFr && equal) return "columns";
    if (layout.gridTracks.length === 2 && layout.gridTracks.some((t) => t.px !== undefined)) return "sidebar";
    return "columns";
  }
  return layout.direction === "row" ? "row" : "stack";
}

/* ------------------------------------------------------------------ */
/* Разворачивание пресета контейнера                                   */
/* ------------------------------------------------------------------ */

/**
 * Ограничение ширины содержимого.
 *
 * Боковые отступы (gutter) обязаны жить на контейнере, а не на секции:
 * иначе на узком экране текст прилипает к краю. При «во всю ширину»
 * gutter обнуляется — иначе полная ширина получается не полной.
 */
export function applyContainerPreset(
  layout: LayoutProps,
  container: ContainerType,
  gutter: SpaceToken | number = "md",
  theme?: ResolvedTheme,
  customWidth?: number,
): LayoutProps {
  const scale = theme?.space ?? SPACE_SCALE;
  const widths = theme?.containers ?? CONTAINER_WIDTHS;
  const next: LayoutProps = { ...layout, container };

  const width =
    container === "custom" ? (customWidth ?? layout.maxWidth ?? 1200) : widths[container];

  if (width === null) {
    delete next.maxWidth;
    next.centered = false;
  } else {
    next.maxWidth = width;
    next.centered = true;
  }

  const pad = typeof layout.padding === "object" ? { ...layout.padding } : {
    t: layout.padding, r: layout.padding, b: layout.padding, l: layout.padding,
  } as Sides;
  const g = container === "full" ? 0 : typeof gutter === "number" ? gutter : (scale[gutter] ?? 24);
  pad.l = g;
  pad.r = g;
  next.padding = pad;
  return next;
}

/* ------------------------------------------------------------------ */
/* Две оси — источник большинства недоразумений                        */
/* ------------------------------------------------------------------ */

/**
 * Физические оси из семантических подписей.
 *
 * `justify` работает по ГЛАВНОЙ оси, `align` — по поперечной, а главная ось
 * зависит от направления. Если в панели свойств писать «по горизонтали /
 * по вертикали», а физику считать здесь, пользователь не путается —
 * и это снимает самую частую претензию к конструкторам.
 */
export function resolveAxes(layout: LayoutProps): {
  horizontal: Justify | Align;
  vertical: Justify | Align;
} {
  const isColumn = layout.direction === "column" && !layout.gridTracks;
  return isColumn
    ? { horizontal: layout.align, vertical: layout.justify }
    : { horizontal: layout.justify, vertical: layout.align };
}

/** Обратное преобразование: подписи интерфейса → свойства модели. */
export function axesToLayout(
  layout: LayoutProps,
  horizontal: string,
  vertical: string,
): Partial<LayoutProps> {
  const isColumn = layout.direction === "column" && !layout.gridTracks;
  return isColumn
    ? { align: horizontal as Align, justify: vertical as Justify }
    : { justify: horizontal as Justify, align: vertical as Align };
}

/* ------------------------------------------------------------------ */
/* Валидация                                                           */
/* ------------------------------------------------------------------ */

export interface ValidationIssue {
  nodeId: string;
  level: "warn" | "err";
  message: string;
}

/**
 * Правила из каталога типов. Не блокируют работу, а предупреждают:
 * блокировка в конструкторе раздражает сильнее, чем подсказка.
 */
export function validateNode(
  node: { id: string; type: NodeType; layout: LayoutProps; children: string[]; text?: string; src?: string },
  depth: number,
): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const L = node.layout;

  if (L.preset === "absolute" && typeof L.height !== "number") {
    out.push({
      nodeId: node.id,
      level: "err",
      message: "Свободная раскладка без заданной высоты: блок схлопнется в ноль",
    });
  }
  if (L.container === "full" && typeof L.padding === "object" && (L.padding.l > 0 || L.padding.r > 0)) {
    out.push({ nodeId: node.id, level: "warn", message: "Контейнер «во всю ширину» с боковыми отступами" });
  }
  if (L.columns !== undefined && (L.columns < COLUMNS_MIN || L.columns > COLUMNS_MAX)) {
    out.push({ nodeId: node.id, level: "warn", message: `Колонок вне диапазона ${COLUMNS_MIN}–${COLUMNS_MAX}` });
  }
  if (L.autoGrid && L.autoGrid.minColumnWidth < MIN_COLUMN_WIDTH_FLOOR) {
    out.push({ nodeId: node.id, level: "warn", message: "Минимальная ширина карточки меньше 160px: колонки станут полосками" });
  }
  if (depth > MAX_GROUP_DEPTH) {
    out.push({ nodeId: node.id, level: "warn", message: `Вложенность глубже ${MAX_GROUP_DEPTH}: дерево станет неуправляемым` });
  }
  if (node.type === "image" && !node.src) {
    out.push({ nodeId: node.id, level: "warn", message: "Картинка без источника" });
  }
  const m = L.margin;
  if (m && (m.t < -200 || m.b < -200 || m.l < -200 || m.r < -200)) {
    out.push({ nodeId: node.id, level: "warn", message: "Отрицательный отступ больше 200px: блок уедет за пределы страницы" });
  }
  return out;
}

/**
 * Операции над scene graph: фабрики узлов, обход, hit-test, стартовый документ.
 * Модуль чистый: никаких сайд-эффектов, никакого UI.
 */
import { uid } from "./ids";
import { deg2rad, rotateAround } from "./geometry";
import { DEFAULT_THEME, type ThemeSpec } from "./themes";
import type {
  Breakpoint, LayoutProps, NodeType, PaddingValue, Rect, SceneDocument, SceneNode, Sides, StyleProps,
} from "./types";

/* ------------------------------------------------------------------ */
/* Отступы: число ↔ стороны                                            */
/* ------------------------------------------------------------------ */

/** Приводит padding (число или стороны) к сторонам. Единая точка доступа. */
export const padBox = (p: PaddingValue | undefined): Sides =>
  typeof p === "object" && p !== null
    ? p
    : { t: (p as number) || 0, r: (p as number) || 0, b: (p as number) || 0, l: (p as number) || 0 };

/** Сумма отступов по горизонтали / вертикали. */
export const padX = (p: PaddingValue | undefined): number => {
  const b = padBox(p);
  return b.l + b.r;
};
export const padY = (p: PaddingValue | undefined): number => {
  const b = padBox(p);
  return b.t + b.b;
};

/** Сворачивает стороны обратно в число, если они равны (компактнее в json). */
export const packPadding = (s: Sides): PaddingValue =>
  s.t === s.r && s.r === s.b && s.b === s.l ? s.t : s;

/* ------------------------------------------------------------------ */
/* Брейкпоинты: каскад и разрешение значений                           */
/* ------------------------------------------------------------------ */

/**
 * Брейкпоинты по умолчанию. Планшет и телефон закрывают 90% случаев;
 * промежуточные ширины намеренно не заводим — каждый лишний брейкпоинт
 * пользователю приходится обслуживать руками.
 */
export const DEFAULT_BREAKPOINTS: Breakpoint[] = [
  { id: "bp-tablet", name: "Планшет", maxWidth: 1024 },
  { id: "bp-phone", name: "Телефон", maxWidth: 640 },
];

/** Инвариант документа: от широкого к узкому. */
export const sortBreakpoints = (list: Breakpoint[]): Breakpoint[] =>
  [...list].sort((a, b) => b.maxWidth - a.maxWidth);

/**
 * КАСКАД БРЕЙКПОИНТОВ — неочевидное, но важное решение.
 *
 * Переопределения НЕ независимы: на 640 действует всё, что задано на 1024,
 * если на 640 это не переопределено явно. То есть значение собирается
 * слоями: база → 1024 → 640.
 *
 * Почему так, а не «каждый брейкпоинт от базы»:
 *  1. Это ровно поведение CSS. Оба блока `@media (max-width: 1024px)` и
 *     `@media (max-width: 640px)` действуют при ширине 600px, и побеждает
 *     тот, что идёт в файле позже (узкий). Если бы модель каскад не
 *     повторяла, холст показывал бы одно, а экспортированный сайт — другое.
 *  2. Иначе «поставить в один столбец на планшете и уже» требовало бы
 *     повторить то же самое на телефоне, и любая правка планшета молча
 *     расходилась бы с телефоном.
 *
 * Возвращает срез списка до указанного брейкпоинта включительно.
 */
const cascadeChain = (breakpoints: Breakpoint[], breakpointId: string | null): Breakpoint[] => {
  if (!breakpointId) return [];
  const index = breakpoints.findIndex((b) => b.id === breakpointId);
  return index < 0 ? [] : breakpoints.slice(0, index + 1);
};

/**
 * Итоговые layout/style узла на брейкпоинте (null = базовое состояние).
 * `hidden` истинно, если узел скрыт на ЛЮБОМ звене каскада и ниже это явно
 * не отменено.
 */
export function resolveNodeAt(
  node: SceneNode,
  breakpoints: Breakpoint[],
  breakpointId: string | null,
): { layout: LayoutProps; style: StyleProps; hidden: boolean } {
  const chain = cascadeChain(breakpoints, breakpointId);
  if (chain.length === 0 || !node.responsive) {
    return { layout: node.layout, style: node.style, hidden: false };
  }
  let layout = node.layout;
  let style = node.style;
  let hidden = false;
  let touched = false;
  for (const bp of chain) {
    const ov = node.responsive[bp.id];
    if (!ov) continue;
    if (ov.layout) {
      layout = touched ? Object.assign(layout, ov.layout) : { ...layout, ...ov.layout };
      touched = true;
    }
    if (ov.style) style = { ...style, ...ov.style };
    if (ov.hidden !== undefined) hidden = ov.hidden;
  }
  return { layout, style, hidden };
}

/**
 * Какой брейкпоинт активен при заданной ширине вьюпорта.
 *
 * Действуют ВСЕ брейкпоинты с maxWidth >= width, а побеждает самый узкий из
 * них (он идёт в CSS последним). Поэтому берём последний подходящий в
 * отсортированном по убыванию списке — это и есть конец каскадной цепочки.
 */
export const breakpointForWidth = (breakpoints: Breakpoint[], width: number): Breakpoint | null => {
  let match: Breakpoint | null = null;
  for (const bp of breakpoints) if (bp.maxWidth >= width) match = bp;
  return match;
};

/**
 * Проекция документа на брейкпоинт: узлы с разрешёнными layout/style,
 * скрытые — выброшены из детей родителя (и из rootFrames).
 *
 * Так решатель и кодоген получают ОБЫЧНЫЙ документ и не знают про
 * адаптивность вовсе: вся логика брейкпоинтов заканчивается здесь.
 * Возвращает исходный документ без копирования, если разрешать нечего.
 */
export function resolveDocAt(doc: SceneDocument, breakpointId: string | null): SceneDocument {
  const chain = cascadeChain(doc.breakpoints, breakpointId);
  if (chain.length === 0) return doc;
  const ids = new Set(chain.map((b) => b.id));
  const affected = Object.values(doc.nodes).some(
    (n) => n.responsive && Object.keys(n.responsive).some((k) => ids.has(k)),
  );
  if (!affected) return doc;

  const nodes: Record<string, SceneNode> = {};
  const hiddenIds = new Set<string>();
  for (const node of Object.values(doc.nodes)) {
    const r = resolveNodeAt(node, doc.breakpoints, breakpointId);
    if (r.hidden) hiddenIds.add(node.id);
    nodes[node.id] = r.layout === node.layout && r.style === node.style
      ? node
      : { ...node, layout: r.layout, style: r.style };
  }
  if (hiddenIds.size > 0) {
    for (const node of Object.values(nodes)) {
      if (node.children.some((c) => hiddenIds.has(c))) {
        nodes[node.id] = { ...node, children: node.children.filter((c) => !hiddenIds.has(c)) };
      }
    }
  }
  return {
    ...doc,
    nodes,
    rootFrames: hiddenIds.size > 0 ? doc.rootFrames.filter((f) => !hiddenIds.has(f)) : doc.rootFrames,
  };
}

/**
 * Что вообще разрешено переопределять. Перечни дублируют типы
 * ResponsiveLayout/ResponsiveStyle, потому что типы существуют только на
 * этапе компиляции, а фильтровать патч из инспектора нужно в рантайме.
 */
export const RESPONSIVE_LAYOUT_KEYS: ReadonlySet<string> = new Set<keyof LayoutProps>([
  "width", "height", "maxWidth", "maxHeight", "scrollX", "centered",
  "direction", "gap", "rowGap", "padding", "margin",
  "align", "justify",
  "preset", "columns", "autoGrid", "sidebar", "gridTracks", "gridSpan", "gridColumn", "gridRow", "gridRowSpan",
  "wrap", "container",
]);

export const RESPONSIVE_STYLE_KEYS: ReadonlySet<string> = new Set<keyof StyleProps>([
  "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textAlign", "uppercase",
]);

/**
 * Раскладывает патч из инспектора на две части: что уходит в переопределение
 * брейкпоинта и что обязано лечь в базу.
 *
 * Неадаптивные свойства (координаты, поворот) пишутся в базу ДАЖЕ при
 * активном брейкпоинте — иначе перетаскивание узла в режиме «Телефон»
 * молча не давало бы результата.
 */
export function splitResponsivePatch<T extends object>(
  patch: T,
  allowed: ReadonlySet<string>,
): { override: Partial<T>; base: Partial<T> } {
  const override: Record<string, unknown> = {};
  const base: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (allowed.has(k)) override[k] = v;
    else base[k] = v;
  }
  return { override: override as Partial<T>, base: base as Partial<T> };
}

/**
 * Предыдущее (более широкое) звено каскада: null — база.
 * Нужно там, где переопределение считается ДИФФОМ: сравнивать надо с тем, что
 * уже действует на этой ширине, а не с базой (см. пресеты раскладки в сторе).
 */
export const previousBreakpointId = (breakpoints: Breakpoint[], id: string): string | null => {
  const i = breakpoints.findIndex((b) => b.id === id);
  return i > 0 ? breakpoints[i - 1].id : null;
};

/** Есть ли у узла переопределение свойства на конкретном брейкпоинте. */
export const hasOverride = (
  node: SceneNode,
  breakpointId: string | null,
  kind: "layout" | "style",
  key: string,
): boolean => {
  if (!breakpointId || !node.responsive) return false;
  const group = node.responsive[breakpointId]?.[kind] as Record<string, unknown> | undefined;
  return group !== undefined && key in group;
};

/** Сколько переопределений у узла на брейкпоинте (для бейджа в инспекторе). */
export const overrideCount = (node: SceneNode, breakpointId: string | null): number => {
  if (!breakpointId || !node.responsive) return 0;
  const ov = node.responsive[breakpointId];
  if (!ov) return 0;
  return (
    Object.keys(ov.layout ?? {}).length +
    Object.keys(ov.style ?? {}).length +
    (ov.hidden !== undefined ? 1 : 0)
  );
};

/**
 * Записывает переопределение в узел (мутирует — вызывается на драфте стора).
 * Пустые группы и пустой объект переопределения удаляются: документ не
 * должен копить мусор вида `responsive: { "bp-phone": {} }`.
 */
export function setOverride(
  node: SceneNode,
  breakpointId: string,
  kind: "layout" | "style",
  patch: Record<string, unknown>,
): void {
  if (Object.keys(patch).length === 0) return;
  const all = (node.responsive ??= {});
  const ov = (all[breakpointId] ??= {});
  const group = { ...(ov[kind] as Record<string, unknown> | undefined) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete group[k];
    else group[k] = v;
  }
  if (Object.keys(group).length === 0) delete ov[kind];
  else (ov as Record<string, unknown>)[kind] = group;
  pruneOverrides(node, breakpointId);
}

/** Убирает опустевшие переопределения. */
export function pruneOverrides(node: SceneNode, breakpointId: string): void {
  const ov = node.responsive?.[breakpointId];
  if (!ov) return;
  if (!ov.layout && !ov.style && ov.hidden === undefined) delete node.responsive![breakpointId];
  if (node.responsive && Object.keys(node.responsive).length === 0) delete node.responsive;
}

/* ------------------------------------------------------------------ */
/* Дефолты                                                             */
/* ------------------------------------------------------------------ */

const baseLayout = (): LayoutProps => ({
  position: "flow",
  x: 0,
  y: 0,
  width: "hug",
  height: "hug",
  direction: "column",
  gap: 0,
  padding: 0,
  align: "start",
  justify: "start",
  rotation: 0,
});

const baseStyle = (): StyleProps => ({
  fill: "transparent",
  textColor: "$text", // токен темы: перекрашивается при смене стиля
  radius: 0,
  fontSize: 16,
  fontWeight: 400,
});

/** Человекочитаемые имена для новых узлов. */
export const NODE_LABELS: Record<NodeType, string> = {
  frame: "Фрейм",
  container: "Контейнер",
  text: "Текст",
  button: "Кнопка",
  image: "Картинка",
  input: "Поле ввода",
  instance: "Компонент",
  autonav: "Авто-навбар",
  autofooter: "Авто-подвал",
  breadcrumbs: "Хлебные крошки",
  cmslist: "Список из БД",
  divider: "Разделитель",
  spacer: "Распорка",
  list: "Список",
  quote: "Цитата",
  icon: "Иконка",
  video: "Видео",
  embed: "Встраивание",
};

/** Фабрика узла с разумными дефолтами под каждый тип. */
export function createNode(type: NodeType, name?: string): SceneNode {
  const node: SceneNode = {
    id: uid(type === "frame" ? "frame" : "node"),
    type,
    name: name ?? NODE_LABELS[type],
    layout: baseLayout(),
    style: baseStyle(),
    children: [],
    parent: null,
  };

  switch (type) {
    case "frame":
      node.layout = { ...node.layout, width: 1200, height: 800, padding: 0, gap: 0 };
      node.style = { ...node.style, fill: "$bg" };
      break;
    case "container":
      node.layout = { ...node.layout, direction: "row", gap: 16, padding: 16, width: "fill" };
      break;
    case "text":
      node.text = "Новый текст";
      node.style = { ...node.style, fontSize: 16 };
      break;
    case "button":
      // тёмная кнопка = текст-на-фоне наоборот: инвертируется в любом стиле
      node.text = "Кнопка";
      node.style = { ...node.style, fill: "$text", textColor: "$bg", radius: 10, fontSize: 15, fontWeight: 600 };
      break;
    case "image":
      node.layout = { ...node.layout, width: 240, height: 160 };
      node.style = { ...node.style, radius: 8 };
      break;
    case "input":
      node.text = "Введите текст…";
      node.layout = { ...node.layout, width: 240, height: 40 };
      node.style = { ...node.style, fill: "$surface", radius: 8, fontSize: 14, textColor: "$muted" };
      break;
    case "instance":
      node.layout = { ...node.layout, width: "hug", height: "hug" };
      break;
    case "autonav":
      node.layout = { ...node.layout, width: "fill", height: "hug" };
      break;
    case "autofooter":
      node.layout = { ...node.layout, width: "fill", height: "hug" };
      break;
    case "breadcrumbs":
      node.layout = { ...node.layout, width: "hug", height: "hug" };
      break;
    case "cmslist":
      node.layout = { ...node.layout, width: "fill", height: "hug" };
      break;

    /* ---- элементы из каталога типов ---- */
    case "divider":
      // разделительная линия: высота нулевая, рисует её рамка сверху
      node.layout = { ...node.layout, width: "fill", height: 1 };
      node.style = { ...node.style, fill: "$line", borderWidth: 1, borderColor: "$line", borderTop: true };
      break;
    case "spacer":
      // управляемый вертикальный воздух — честнее, чем пустой контейнер
      node.layout = { ...node.layout, width: "fill", height: 48 };
      break;
    case "list":
      node.items = ["Первый пункт", "Второй пункт", "Третий пункт"];
      node.layout = { ...node.layout, width: "fill", height: "hug" };
      node.style = { ...node.style, fontSize: 16, lineHeight: 1.6 };
      break;
    case "quote":
      node.text = "Цитата, которая объясняет ценность продукта словами клиента.";
      node.cite = "Имя, должность";
      node.layout = { ...node.layout, width: "fill", height: "hug", padding: { t: 8, r: 0, b: 8, l: 20 } };
      node.style = { ...node.style, fontSize: 20, italic: true, borderWidth: 2, borderColor: "$accent", borderLeft: true };
      break;
    case "icon":
      node.iconName = "star";
      node.layout = { ...node.layout, width: 40, height: 40 };
      node.style = { ...node.style, textColor: "$accent" };
      break;
    case "video":
      node.videoProvider = "youtube";
      node.frameRatio = 16 / 9;
      node.layout = { ...node.layout, width: "fill", height: "hug" };
      node.style = { ...node.style, fill: "#0d1114", radius: 10 };
      break;
    case "embed":
      node.frameRatio = 16 / 9;
      node.layout = { ...node.layout, width: "fill", height: "hug" };
      node.style = { ...node.style, fill: "$surface", radius: 10 };
      break;
  }
  return node;
}

/* ------------------------------------------------------------------ */
/* Обход                                                               */
/* ------------------------------------------------------------------ */

export const getNode = (doc: SceneDocument, id: string): SceneNode | undefined => doc.nodes[id];

export function* descendants(doc: SceneDocument, id: string): Generator<SceneNode> {
  const node = doc.nodes[id];
  if (!node) return;
  yield node;
  for (const childId of node.children) yield* descendants(doc, childId);
}

/** Может ли узел содержать детей. */
export const isContainerLike = (n: SceneNode): boolean => n.type === "frame" || n.type === "container";

/** Цепочка родителей от узла до корневого фрейма (для хлебных крошек в статусбаре). */
export function parentChain(doc: SceneDocument, id: string): SceneNode[] {
  const chain: SceneNode[] = [];
  let cur = doc.nodes[id];
  while (cur) {
    chain.unshift(cur);
    cur = cur.parent ? doc.nodes[cur.parent]! : (undefined as never);
    if (!cur) break;
  }
  return chain;
}

/**
 * Hit-test: самый глубокий узел под точкой (мировые координаты).
 * Поздние братья рисуются поверх ранних, поэтому обходим с конца.
 */
export function findDeepestAt(
  doc: SceneDocument,
  rects: Map<string, Rect>,
  wx: number,
  wy: number,
): string | null {
  // Точка спускается по дереву, на каждом узле снимаем его поворот вокруг центра.
  const hit = (id: string, px: number, py: number): string | null => {
    const r = rects.get(id);
    if (!r) return null;
    const node = doc.nodes[id]!;
    const a = deg2rad(node.layout.rotation || 0);
    let lx = px;
    let ly = py;
    if (a !== 0) {
      const local = rotateAround(px, py, r.x + r.w / 2, r.y + r.h / 2, -a);
      lx = local.x;
      ly = local.y;
    }
    const inside = lx >= r.x && ly >= r.y && lx <= r.x + r.w && ly <= r.y + r.h;
    // ВАЖНО: дети проверяются даже если точка вне рамки родителя —
    // элементы, вылезшие за пределы страницы, всё равно кликабельны
    for (let i = node.children.length - 1; i >= 0; i--) {
      const deeper = hit(node.children[i], lx, ly);
      if (deeper) return deeper;
    }
    return inside ? id : null;
  };
  for (let i = doc.rootFrames.length - 1; i >= 0; i--) {
    const found = hit(doc.rootFrames[i], wx, wy);
    if (found) return found;
  }
  return null;
}

/** Глубокое клонирование поддерева с новыми id (для Ctrl+D). */
export function cloneSubtree(
  doc: SceneDocument,
  rootId: string,
): { newRootId: string; nodes: Record<string, SceneNode> } {
  const out: Record<string, SceneNode> = {};
  const walk = (id: string, parent: string | null): string => {
    const src = doc.nodes[id]!;
    const copy: SceneNode = structuredClone(src);
    copy.id = uid(src.type === "frame" ? "frame" : "node");
    copy.parent = parent;
    copy.children = src.children.map((c) => walk(c, copy.id));
    out[copy.id] = copy;
    return copy.id;
  };
  return { newRootId: walk(rootId, doc.nodes[rootId]!.parent), nodes: out };
}

/* ------------------------------------------------------------------ */
/* Стартовый документ — Plexus «ест свой корм»: лендинг о самом себе   */
/* ------------------------------------------------------------------ */

/** Начальные данные для нового узла (пресеты вставки). */
export interface NodeInit {
  name?: string;
  text?: string;
  src?: string;
  style?: Partial<StyleProps>;
  layout?: Partial<LayoutProps>;
}

/**
 * ОПИСАНИЕ ПОДДЕРЕВА для вставки готовых блоков.
 *
 * Раньше вставить можно было только одиночный узел, поэтому «сетка карточек»
 * или «тарифы» собирались руками из десятка элементов. Спецификация —
 * это рецепт: реестр блоков описывает структуру декларативно, а
 * `materialize` разворачивает её в реальные узлы документа.
 */
export interface NodeSpec {
  type: NodeType;
  name?: string;
  text?: string;
  src?: string;
  href?: string;
  items?: string[];
  ordered?: boolean;
  cite?: string;
  iconName?: string;
  videoProvider?: SceneNode["videoProvider"];
  frameRatio?: number;
  role?: SceneNode["role"];
  anchorId?: string;
  sticky?: boolean;
  customCode?: string;
  layout?: Partial<LayoutProps>;
  style?: Partial<StyleProps>;
  children?: NodeSpec[];
}

/**
 * Разворачивает спецификацию в узлы документа и возвращает id корня.
 * Дефолты типа сохраняются: спецификация только переопределяет нужное.
 */
export function materialize(
  doc: SceneDocument,
  spec: NodeSpec,
  parentId: string | null,
  index?: number,
): string {
  const node = createNode(spec.type, spec.name);
  if (spec.text !== undefined) node.text = spec.text;
  if (spec.src !== undefined) node.src = spec.src;
  if (spec.href !== undefined) node.href = spec.href;
  if (spec.items !== undefined) node.items = [...spec.items];
  if (spec.ordered !== undefined) node.ordered = spec.ordered;
  if (spec.cite !== undefined) node.cite = spec.cite;
  if (spec.iconName !== undefined) node.iconName = spec.iconName;
  if (spec.videoProvider !== undefined) node.videoProvider = spec.videoProvider;
  if (spec.frameRatio !== undefined) node.frameRatio = spec.frameRatio;
  if (spec.role !== undefined) node.role = spec.role;
  if (spec.anchorId !== undefined) node.anchorId = spec.anchorId;
  if (spec.sticky !== undefined) node.sticky = spec.sticky;
  if (spec.customCode !== undefined) node.customCode = spec.customCode;
  if (spec.layout) Object.assign(node.layout, spec.layout);
  if (spec.style) Object.assign(node.style, spec.style);

  node.parent = parentId;
  doc.nodes[node.id] = node;
  if (parentId) {
    const kids = doc.nodes[parentId]!.children;
    if (index === undefined || index < 0 || index > kids.length) kids.push(node.id);
    else kids.splice(index, 0, node.id);
  }
  for (const child of spec.children ?? []) materialize(doc, child, node.id);
  return node.id;
}

export interface InsertPreset {
  label: string;
  type: NodeType;
  init?: NodeInit;
}

/** Пресеты меню «Вставка» и контекстного меню холста. */
export const INSERT_PRESETS: InsertPreset[] = [
  { label: "Заголовок", type: "text", init: { name: "Заголовок", text: "Заголовок", style: { fontSize: 44, fontWeight: 700 } } },
  { label: "Подзаголовок", type: "text", init: { name: "Подзаголовок", text: "Подзаголовок", style: { fontSize: 24, fontWeight: 600 } } },
  { label: "Текст", type: "text" },
  { label: "Подпись", type: "text", init: { name: "Подпись", text: "Подпись", style: { fontSize: 13, textColor: "$muted" } } },
  { label: "Кнопка", type: "button" },
  { label: "Кнопка (акцент)", type: "button", init: { name: "Кнопка акцентная", style: { fill: "$accent", textColor: "$accentInk", radius: 12 } } },
  { label: "Контейнер", type: "container" },
  { label: "Картинка", type: "image" },
  { label: "Поле ввода", type: "input" },
  { label: "— Авто-навбар", type: "autonav" },
  { label: "— Авто-подвал", type: "autofooter" },
  { label: "— Хлебные крошки", type: "breadcrumbs" },
  { label: "— Список из БД", type: "cmslist" },
];

/** Подписи действий связей для UI. */
export const WIRE_ACTION_LABELS: Record<string, string> = {
  navigate: "Перейти на страницу",
  toggle: "Показать/скрыть",
  submit: "Отправить в бэкенд",
};

/**
 * Миграция документа к текущей схеме: старые сохранения (v0.1.0)
 * не имели wires и rotation — дозаполняем, ничего не ломая.
 */
export function normalizeDoc(doc: SceneDocument): SceneDocument {
  if (!Array.isArray(doc.wires)) doc.wires = [];
  if (!doc.components) doc.components = {};
  if (!doc.theme) doc.theme = { ...DEFAULT_THEME };
  if (!doc.dbTables) doc.dbTables = {};
  if (!Array.isArray(doc.dbRelations)) doc.dbRelations = [];
  if (!doc.dbProvider) doc.dbProvider = "sqlite";
  if (!doc.siteTarget) doc.siteTarget = "static";
  /* Сохранения до адаптивности брейкпоинтов не знали. Дозаполнять их
     дефолтами НЕЛЬЗЯ: пустой список — единственное состояние, при котором
     кодоген выдаёт CSS байт-в-байт как раньше, а старый проект не должен
     внезапно обрасти медиазапросами. */
  if (!Array.isArray(doc.breakpoints)) doc.breakpoints = [];
  else doc.breakpoints = sortBreakpoints(doc.breakpoints.filter((b) => b && b.id && Number(b.maxWidth) > 0));
  doc.dbRelations = doc.dbRelations.filter(
    (r) => doc.dbTables[r.fromTableId] && doc.dbTables[r.toTableId],
  );
  for (const node of Object.values(doc.nodes)) {
    if (typeof node.layout.rotation !== "number") node.layout.rotation = 0;
    // padding стал возможен по сторонам: число из старых сохранений валидно
    // как равномерный отступ, ничего конвертировать не нужно — но битые
    // значения (undefined после ручной правки json) приводим к нулю
    if (node.layout.padding === undefined || node.layout.padding === null) node.layout.padding = 0;
    if (typeof node.layout.padding === "object") {
      const p = node.layout.padding as Sides;
      node.layout.padding = {
        t: Number(p.t) || 0,
        r: Number(p.r) || 0,
        b: Number(p.b) || 0,
        l: Number(p.l) || 0,
      };
    }
    // сетка: пустой массив дорожек — это не сетка
    if (node.layout.gridTracks && node.layout.gridTracks.length === 0) delete node.layout.gridTracks;
    /* Потолок высоты появился позже колонок и в старых сохранениях его нет.
       Отсутствие = коробка растёт под содержимое, как было раньше. */
    if (node.layout.maxHeight !== undefined) {
      const mh = Number(node.layout.maxHeight);
      if (Number.isFinite(mh) && mh > 0) node.layout.maxHeight = Math.round(mh);
      else delete node.layout.maxHeight;
    }
    /* Горизонтальная прокрутка появилась позже: в старых сохранениях её нет,
       и отсутствие обязано означать прежнее поведение — ряд ужимается. */
    if (node.layout.scrollX !== undefined && node.layout.scrollX !== true) delete node.layout.scrollX;
    /* Номер колонки появился позже: в старых сохранениях его нет, и это
       нормально (раскладка подряд). А вот мусор из ручной правки json
       убираем — иначе решатель уедет в отрицательные индексы. */
    for (const key of ["gridColumn", "gridRow", "gridRowSpan"] as const) {
      const v = node.layout[key];
      if (v === undefined) continue;
      if (!(Number.isFinite(v) && v >= 1)) delete node.layout[key];
      else node.layout[key] = Math.round(v);
    }
  }
  // выбрасываем провода, ссылающиеся на несуществующие узлы
  doc.wires = doc.wires.filter((w) => doc.nodes[w.sourceId] && doc.nodes[w.targetId]);
  // компоненты без мастера и экземпляры без компонента
  for (const [id, comp] of Object.entries(doc.components)) {
    if (!doc.nodes[comp.rootId]) delete doc.components[id];
  }
  return doc;
}

export interface StarterOptions {
  theme?: ThemeSpec;
  /** Добавить вторую страницу «О нас» (многостраничный шаблон). */
  secondPage?: boolean;
  /** Целевой кодоген (шаблон «с БД» → next). */
  siteTarget?: SceneDocument["siteTarget"];
}

export function createStarterDocument(options?: StarterOptions): SceneDocument {
  const doc: SceneDocument = {
    nodes: {},
    rootFrames: [],
    wires: [],
    components: {},
    theme: options?.theme ? { ...options.theme } : { ...DEFAULT_THEME },
    dbTables: {},
    dbRelations: [],
    dbProvider: "sqlite",
    siteTarget: options?.siteTarget ?? "static",
    breakpoints: DEFAULT_BREAKPOINTS.map((b) => ({ ...b })),
  };
  const add = (node: SceneNode, parent: SceneNode | null): SceneNode => {
    node.parent = parent?.id ?? null;
    doc.nodes[node.id] = node;
    if (parent) parent.children.push(node.id);
    else if (node.type === "frame") doc.rootFrames.push(node.id);
    return node;
  };

  const frame = createNode("frame", "Главная");
  frame.layout.x = 160;
  frame.layout.y = 120;
  add(frame, null);

  /* --- Навбар ------------------------------------------------------ */
  const navbar = createNode("container", "Навбар");
  navbar.layout = { ...navbar.layout, direction: "row", justify: "between", align: "center", padding: 24, gap: 24, width: "fill", height: "hug" };
  add(navbar, frame);

  const logo = createNode("text", "Логотип");
  logo.text = "Plexus";
  logo.style = { ...logo.style, fontSize: 20, fontWeight: 700 };
  add(logo, navbar);

  const menu = createNode("container", "Меню");
  menu.layout = { ...menu.layout, direction: "row", gap: 28, padding: 0, align: "center", width: "hug" };
  add(menu, navbar);

  const link1 = createNode("text", "Пункт меню");
  link1.text = "Возможности";
  link1.style = { ...link1.style, fontSize: 15, textColor: "$muted" };
  add(link1, menu);

  const link2 = createNode("text", "Пункт меню");
  link2.text = "Цены";
  link2.style = { ...link2.style, fontSize: 15, textColor: "$muted" };
  add(link2, menu);

  const login = createNode("button", "Кнопка входа");
  login.text = "Войти";
  add(login, menu);

  /* --- Hero --------------------------------------------------------- */
  const hero = createNode("container", "Hero");
  hero.layout = { ...hero.layout, direction: "column", gap: 20, padding: 72, align: "center", justify: "center", width: "fill", height: "fill" };
  add(hero, frame);

  const h1 = createNode("text", "Заголовок");
  h1.text = "Собирай сайты как схемы";
  h1.style = { ...h1.style, fontSize: 44, fontWeight: 700 };
  add(h1, hero);

  const sub = createNode("text", "Подзаголовок");
  sub.text = "Холст, логика и база данных — в одной системе.";
  sub.style = { ...sub.style, fontSize: 18, textColor: "$muted" };
  add(sub, hero);

  const cta = createNode("container", "Кнопки CTA");
  cta.layout = { ...cta.layout, direction: "row", gap: 12, padding: 0, width: "hug" };
  add(cta, hero);

  const primary = createNode("button", "Основная кнопка");
  primary.text = "Начать бесплатно";
  primary.style = { ...primary.style, fill: "$accent", textColor: "$accentInk", radius: 12 };
  add(primary, cta);

  const secondary = createNode("button", "Вторичная кнопка");
  secondary.text = "Документация";
  secondary.style = { ...secondary.style, fill: "$surface", textColor: "$text", radius: 12 };
  add(secondary, cta);

  /* --- Вторая страница (многостраничный шаблон) --- */
  if (options?.secondPage) {
    const page2 = createNode("frame", "О нас");
    page2.layout.x = frame.layout.x + 1200 + 120;
    page2.layout.y = frame.layout.y;
    add(page2, null);

    const body = createNode("container", "Содержимое");
    body.layout = { ...body.layout, direction: "column", gap: 18, padding: 72, align: "start", width: "fill", height: "fill" };
    add(body, page2);

    const h2 = createNode("text", "Заголовок страницы");
    h2.text = "О нас";
    h2.style = { ...h2.style, fontSize: 36, fontWeight: 700 };
    add(h2, body);

    const p2 = createNode("text", "Абзац");
    p2.text = "Расскажи здесь о проекте. Свяжи страницы кнопками через режим проводов.";
    p2.style = { ...p2.style, fontSize: 16, textColor: "$muted" };
    add(p2, body);

    const back = createNode("button", "Кнопка назад");
    back.text = "На главную";
    add(back, body);

    // готовая связь: «На главную» → переход на первую страницу
    doc.wires.push({ id: uid("wire"), sourceId: back.id, targetId: frame.id, trigger: "click", action: "navigate" });
  }

  return doc;
}

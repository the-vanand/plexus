/**
 * Состояние редактора (zustand): документ, выделение, вкладки, логи, undo/redo.
 *
 * Правила:
 *  - Документ меняется только иммутабельно (клон → мутация → set) — так
 *    undo/redo и подписки рендерера остаются тривиально корректными.
 *  - Live-перетаскивание пишет без истории; снапшот кладётся один раз
 *    в начале жеста (beginGesture) и фиксируется на отпускании.
 */
import { create } from "zustand";
import type {
  ContainerType, DbField, DbProvider, LayoutProps, LayoutType, NodeType, SceneDocument, SceneNode,
  SiteTarget, SpaceValue, WireAction,
} from "./types";
import {
  cloneSubtree,
  createNode,
  createStarterDocument,
  isContainerLike,
  materialize,
  normalizeDoc,
  previousBreakpointId,
  pruneOverrides,
  resolveNodeAt,
  RESPONSIVE_LAYOUT_KEYS,
  RESPONSIVE_STYLE_KEYS,
  setOverride,
  splitResponsivePatch,
  WIRE_ACTION_LABELS,
  type NodeSpec,
  type NodeInit,
} from "./scene";
import { useUi } from "./uiStore";
import { generateProject } from "./codegen";
import { importHtmlToDoc, type ImportOutcome } from "./importer";
import { BLOCK_BY_TYPE, type BlockType } from "./blocks";
import {
  applyContainerPreset, applyLayoutPreset, CONTAINER_PRESETS, LAYOUT_PRESETS, validateNode,
} from "./layoutPresets";
import { ensureImportedFonts } from "./themes";
import { uid } from "./ids";
import { resolveTheme, type ThemeSpec } from "./themes";
import { formatSourceReport } from "./css/source";
import { collectorScript, type PageSnapshot } from "./snapshot";
import { importSnapshotToDoc } from "./importSnapshot";
import * as host from "../tauri/api";

export type LogLevel = "info" | "ok" | "err";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  msg: string;
  /** Ошибка привязана к элементу холста — лог получает кнопку «Показать». */
  nodeId?: string;
}

/** Путь виртуального/реального файла проекта, открываемого вкладкой. */
export type FilePath = string;

interface PlexusState {
  doc: SceneDocument;
  selection: string[];
  hoverId: string | null;
  openTabs: FilePath[];
  activeTab: "canvas" | FilePath;
  logs: LogEntry[];
  savedAt: number | null;
  /** Счётчик ревизий документа — дешёвый сигнал для перерисовки холста. */
  rev: number;

  projectName: string;
  projectPath: string | null;

  /** Сигнал холсту сфокусироваться на фрейме (страница). */
  focusNonce: number;
  focusTargetId: string | null;

  init: () => Promise<void>;
  select: (ids: string[]) => void;
  setHover: (id: string | null) => void;

  addNode: (type: NodeType, parentId: string, index?: number, init?: NodeInit) => string;
  /** Вставить готовый блок из реестра (поддерево целиком). */
  insertBlock: (blockType: BlockType, parentId?: string, index?: number) => string | null;
  /** Вставить отдельный элемент по рецепту из каталога. */
  insertSpec: (spec: NodeSpec, parentId?: string, index?: number) => string | null;
  /** Переключить пресет раскладки узла. */
  setLayoutPreset: (id: string, preset: LayoutType) => void;
  /** Переключить пресет контейнера узла. */
  setContainerPreset: (id: string, container: ContainerType, gutter?: SpaceValue) => void;
  /** Проверить документ по правилам каталога и высыпать замечания в логи. */
  validateDocument: () => void;
  /* содержимое элементов каталога */
  setItems: (id: string, items: string[]) => void;
  setOrdered: (id: string, ordered: boolean) => void;
  setCite: (id: string, cite: string) => void;
  setIconName: (id: string, name: string) => void;
  setVideoProvider: (id: string, provider: "youtube" | "vimeo" | "file") => void;
  setFrameRatio: (id: string, ratio: number) => void;
  addFrameAt: (wx: number, wy: number) => string;
  setSrc: (id: string, src: string) => void;
  setHref: (id: string, href: string) => void;
  /**
   * Правка свойств узла. При активном брейкпоинте адаптивная часть патча
   * уходит в переопределения, остальное — в базу (см. реализацию).
   */
  updateLayout: (id: string, patch: Partial<SceneDocument["nodes"][string]["layout"]>) => void;
  updateStyle: (id: string, patch: Partial<SceneDocument["nodes"][string]["style"]>) => void;
  /** Скрыть/показать узел на брейкпоинте. */
  setNodeHiddenAt: (id: string, breakpointId: string, hidden: boolean) => void;
  /** Сбросить все переопределения узла на брейкпоинте. */
  clearOverrides: (id: string, breakpointId: string) => void;
  setText: (id: string, text: string) => void;
  rename: (id: string, name: string) => void;
  removeNodes: (ids: string[]) => void;
  duplicateNodes: (ids: string[]) => void;
  reorderChild: (parentId: string, from: number, to: number) => void;

  /** Жест перетаскивания: снапшот один раз в начале, живые правки без истории. */
  beginGesture: () => void;
  moveAbsolute: (id: string, x: number, y: number) => void;
  /** Живой патч раскладки без истории (ресайз/поворот тягой). */
  patchLayoutLive: (id: string, patch: Partial<SceneDocument["nodes"][string]["layout"]>) => void;

  /** Страницы (корневые фреймы). */
  addPage: () => string;
  requestFocus: (id: string) => void;

  /** Режим «глазик»: показать провода связей. */
  eyeMode: boolean;
  toggleEye: () => void;
  addWire: (sourceId: string, targetId: string, action: WireAction) => void;
  removeWire: (wireId: string) => void;

  /** Стиль сайта (дизайн-токены). */
  setTheme: (patch: Partial<ThemeSpec>) => void;

  /** Компоненты-символы. */
  createComponent: (nodeId: string) => void;
  addInstance: (componentId: string, parentId: string) => void;

  /** Визуальная схема БД. */
  addDbTable: () => void;
  removeDbTable: (tableId: string) => void;
  patchDbTable: (tableId: string, patch: Partial<{ name: string; x: number; y: number }>) => void;
  addDbField: (tableId: string) => void;
  patchDbField: (tableId: string, fieldId: string, patch: Partial<DbField>) => void;
  removeDbField: (tableId: string, fieldId: string) => void;
  addDbRelation: (fromTableId: string, toTableId: string) => void;
  removeDbRelation: (relationId: string) => void;
  setDbProvider: (p: DbProvider) => void;
  setSiteTarget: (t: SiteTarget) => void;

  /** Код-слоты и привязки умных элементов. */
  setCustomCode: (id: string, code: string) => void;
  setTableRef: (id: string, tableId: string) => void;

  /** Шапка: закрепить сверху и фон при прокрутке. */
  setSticky: (id: string, sticky: boolean) => void;
  setScrollFill: (id: string, fill: string) => void;

  /** Ссылки и якоря. */
  setHrefValue: (id: string, href: string) => void;
  setAnchorId: (id: string, anchorId: string) => void;

  /** Разобрать умный элемент (навбар/подвал) на редактируемые узлы. */
  detachSmart: (id: string) => void;

  /** Роль (header/footer/nav/section) и reveal-анимация. */
  setRole: (id: string, role: "header" | "footer" | "section" | "nav" | "") => void;
  setReveal: (id: string, reveal: SceneNode["reveal"]) => void;
  /** Подогнать высоту страницы под содержимое. */
  fitFrame: (frameId: string, contentH: number) => void;
  /** Two-way Phase 1: залить содержимое PLX-SLOT из файла обратно в модель. */
  syncSlotsFromCode: (slots: Record<string, string>) => void;

  /** Импорт HTML-сайта: новая страница из существующей вёрстки. */
  importHtmlSite: (opts: { htmlPath: string; viewportWidth?: number }) => Promise<void>;
  /** Импорт сайта по ссылке. */
  importUrlSite: (url: string, viewportWidth?: number) => Promise<void>;
  /** Импорт по снимку живой страницы (через настоящий браузер). */
  importUrlViaBrowser: (url: string, viewportWidth?: number) => Promise<void>;

  undo: () => void;
  redo: () => void;

  openTab: (path: FilePath) => void;
  closeTab: (path: FilePath) => void;
  setActiveTab: (tab: "canvas" | FilePath) => void;
  getFileContent: (path: FilePath) => string;
  /** Открыть текстовый файл с диска вкладкой (читает через Rust). */
  openFsFile: (path: string) => Promise<void>;
  /** Список всех открываемых файлов проекта (модель + генерируемые страницы). */
  getProjectFiles: () => string[];

  log: (level: LogLevel, msg: string, nodeId?: string) => void;
  exportSite: () => Promise<void>;
  saveProject: () => Promise<void>;
  newProject: (opts: {
    parentDir?: string;
    name: string;
    theme?: ThemeSpec;
    secondPage?: boolean;
    siteTarget?: SiteTarget;
  }) => Promise<void>;
  openProject: (dir: string) => Promise<void>;
  renameProject: (name: string) => void;
}


/**
 * Шрифты импортированной страницы.
 *
 * Без этого измеритель считает метрику ПОДСТАВНЫМ шрифтом: перенос строк
 * не совпадает с оригиналом, и текст «съезжает». Ссылки (Google Fonts,
 * @font-face) вставляем в документ — дальше срабатывает уже существующий
 * пересчёт по `fonts.loadingdone` / `fonts.ready`.
 */
function applyImportedFonts(outcome: ImportOutcome, log: (k: "ok" | "info" | "err", m: string) => void): void {
  if (outcome.fontLinks.length > 0) ensureImportedFonts(outcome.fontLinks);
  if (outcome.fontFamilies.length > 0) {
    log("info", `Шрифты страницы: ${outcome.fontFamilies.map((f) => f.split(",")[0].replace(/['"]/g, "")).join(", ")}`);
  }
}

/**
 * Разбор источника в логи.
 *
 * Молчаливый пустой результат — худшее, что может выдать импорт: выглядит
 * как поломка приложения. Поэтому цифры проговариваются прямо: сколько
 * тегов и текста реально прислал сервер и что с этим делать.
 */
function reportImportSource(
  outcome: ImportOutcome,
  log: (k: "ok" | "info" | "err", m: string) => void,
): void {
  const r = outcome.source;
  log(r.kind === "static" ? "info" : "err", formatSourceReport(r));
  if (r.kind !== "static") {
    log("info", r.advice);
    for (const m of r.markers.slice(0, 3)) log("info", `  признак: ${m}`);
    for (const st of r.embeddedState) {
      log("info", `  контент есть в ${st.name} (${st.kilobytes} КБ), но как JSON — разметки для него сервер не прислал`);
    }
  }
  if (outcome.widgets.length > 0) {
    log("info", `Сторонние виджеты (${outcome.widgets.length}): ${outcome.widgets.slice(0, 6).join("; ")}`);
  }
}

/**
 * Куда вставлять блок, если цель не указана явно.
 *
 * Выбранный контейнер — если выбран контейнер; иначе родитель выбранного узла;
 * иначе активная страница. Так вставка «просто работает» из панели
 * инструментов, не требуя предварительно выделить рамку.
 */
function defaultTarget(state: { doc: SceneDocument; selection: string[] }): string | null {
  const { doc, selection } = state;
  const sel = selection[0] ? doc.nodes[selection[0]] : undefined;
  if (sel) {
    if (isContainerLike(sel)) return sel.id;
    if (sel.parent && doc.nodes[sel.parent]) return sel.parent;
  }
  return doc.rootFrames[0] ?? null;
}

/* ---------------- история (модульная, вне реактивного состояния) --------- */

let past: string[] = [];
let future: string[] = [];
const HISTORY_LIMIT = 100;
/** Коалесценция истории при наборе текста: Ctrl+Z отменяет фразу, а не букву. */
let lastTextPush: { id: string; ts: number } | null = null;
/** Кеш содержимого файлов, открытых с диска (read-only вкладки). */
const fsCache = new Map<string, string>();

/** Куда вставлять новый элемент: выделенный контейнер → родитель-контейнер → первая страница. */
export function getInsertTarget(): string | null {
  const s = useStore.getState();
  const selId = s.selection[0];
  if (selId) {
    let cur = s.doc.nodes[selId];
    while (cur) {
      if (isContainerLike(cur)) return cur.id;
      cur = cur.parent ? s.doc.nodes[cur.parent]! : (undefined as never);
      if (!cur) break;
    }
  }
  return s.doc.rootFrames[0] ?? null;
}

/**
 * Активный брейкпоинт редактирования — из состояния интерфейса, но только
 * если он реально есть в документе. Так переключатель не может заставить
 * писать переопределения в брейкпоинт, который уже удалили.
 */
function activeBreakpointOf(doc: SceneDocument): string | null {
  const id = useUi.getState().activeBreakpoint;
  return id && doc.breakpoints.some((b) => b.id === id) ? id : null;
}

/**
 * Записывает НОВЫЙ ЦЕЛИКОМ layout узла с учётом активного брейкпоинта.
 *
 * Пресеты раскладки и контейнера не патчат отдельные поля, а пересобирают
 * layout полностью. На брейкпоинте писать его в базу нельзя (пресет «стек»
 * для телефона снёс бы сетку на десктопе), поэтому берётся ДИФФ против того,
 * что уже действует на этой ширине, и только он ложится в переопределение.
 */
function writeLayout(doc: SceneDocument, node: SceneNode, next: LayoutProps): void {
  const bp = activeBreakpointOf(doc);
  if (!bp) {
    node.layout = next;
    return;
  }
  const inherited = resolveNodeAt(node, doc.breakpoints, previousBreakpointId(doc.breakpoints, bp))
    .layout as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  const base: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) {
    if (JSON.stringify(v) === JSON.stringify(inherited[k])) continue;
    if (RESPONSIVE_LAYOUT_KEYS.has(k)) patch[k] = v;
    else base[k] = v;
  }
  setOverride(node, bp, "layout", patch);
  if (Object.keys(base).length > 0) Object.assign(node.layout, base);
}

const snapshot = (doc: SceneDocument): string => JSON.stringify(doc);

function pushHistory(doc: SceneDocument): void {
  past.push(snapshot(doc));
  if (past.length > HISTORY_LIMIT) past.shift();
  future = [];
}

/* ---------------- стор ---------------------------------------------------- */

export const useStore = create<PlexusState>()((set, get) => {
  /** Клон текущего документа для иммутабельной мутации. */
  const draft = (): SceneDocument => structuredClone(get().doc);
  const commit = (doc: SceneDocument): void => set((s) => ({ doc, rev: s.rev + 1 }));

  return {
    doc: createStarterDocument(),
    selection: [],
    hoverId: null,
    openTabs: [],
    activeTab: "canvas",
    logs: [],
    savedAt: null,
    rev: 0,
    projectName: "Мой первый сайт",
    projectPath: null,
    focusNonce: 0,
    focusTargetId: null,
    eyeMode: false,

    init: async () => {
      const saved = await host.loadProjectFile();
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as { doc: SceneDocument; name?: string };
          if (parsed.doc?.nodes) {
            commit(normalizeDoc(parsed.doc));
            if (parsed.name) set({ projectName: parsed.name });
            get().log("ok", "Проект загружен из plexus.json");
            return;
          }
        } catch {
          get().log("err", "plexus.json повреждён — загружен стартовый шаблон");
        }
      }
      get().log("info", `Plexus готов. Среда: ${host.isTauri() ? "десктоп (Tauri)" : "браузер (превью)"}.`);
    },

    select: (ids) => set({ selection: ids }),
    setHover: (id) => set({ hoverId: id }),

    addNode: (type, parentId, index, init) => {
      const doc = draft();
      pushHistory(get().doc);
      const node = createNode(type);
      if (init) {
        if (init.name) node.name = init.name;
        if (init.text !== undefined) node.text = init.text;
        if (init.src !== undefined) node.src = init.src;
        if (init.style) Object.assign(node.style, init.style);
        if (init.layout) Object.assign(node.layout, init.layout);
      }
      node.parent = parentId;
      doc.nodes[node.id] = node;
      const parent = doc.nodes[parentId]!;
      if (index === undefined || index < 0 || index > parent.children.length) {
        parent.children.push(node.id);
      } else {
        parent.children.splice(index, 0, node.id);
      }
      commit(doc);
      set({ selection: [node.id] });
      get().log("info", `Добавлен «${node.name}» → ${parent.name}`);
      return node.id;
    },

    insertBlock: (blockType, parentId, index) => {
      const def = BLOCK_BY_TYPE.get(blockType);
      if (!def) {
        get().log("err", `Неизвестный блок: ${blockType}`);
        return null;
      }
      const target = parentId ?? defaultTarget(get());
      if (!target) {
        get().log("info", "Некуда вставлять: сначала создай страницу");
        return null;
      }
      const doc = draft();
      pushHistory(get().doc);
      const id = materialize(doc, def.build(), target, index);
      commit(doc);
      set((st) => ({ selection: [id], focusNonce: st.focusNonce + 1, focusTargetId: id }));
      get().log("ok", `Вставлен блок «${def.label}»`);
      return id;
    },

    insertSpec: (spec, parentId, index) => {
      const target = parentId ?? defaultTarget(get());
      if (!target) {
        get().log("info", "Некуда вставлять: сначала создай страницу");
        return null;
      }
      const doc = draft();
      pushHistory(get().doc);
      const id = materialize(doc, spec, target, index);
      commit(doc);
      set({ selection: [id] });
      get().log("info", `Добавлен «${doc.nodes[id]!.name}»`);
      return id;
    },

    setLayoutPreset: (id, preset) => {
      const doc = draft();
      const node = doc.nodes[id];
      if (!node) return;
      pushHistory(get().doc);
      writeLayout(doc, node, applyLayoutPreset(resolveNodeAt(node, doc.breakpoints, activeBreakpointOf(doc)).layout, preset, resolveTheme(doc.theme)));
      commit(doc);
      const label = LAYOUT_PRESETS.find((l) => l.type === preset)?.label ?? preset;
      get().log("info", `Раскладка «${node.name}» → ${label}`);
    },

    setContainerPreset: (id, container, gutter) => {
      const doc = draft();
      const node = doc.nodes[id];
      if (!node) return;
      pushHistory(get().doc);
      writeLayout(doc, node, applyContainerPreset(resolveNodeAt(node, doc.breakpoints, activeBreakpointOf(doc)).layout, container, gutter ?? "md", resolveTheme(doc.theme)));
      commit(doc);
      const label = CONTAINER_PRESETS.find((c) => c.type === container)?.label ?? container;
      get().log("info", `Контейнер «${node.name}» → ${label}`);
    },

    validateDocument: () => {
      const { doc, log } = get();
      const issues: ReturnType<typeof validateNode> = [];
      const walk = (id: string, depth: number): void => {
        const node = doc.nodes[id];
        if (!node) return;
        issues.push(...validateNode(node, depth));
        for (const c of node.children) walk(c, depth + 1);
      };
      for (const f of doc.rootFrames) walk(f, 0);

      // один <h1> на страницу — правило из каталога типов
      for (const frameId of doc.rootFrames) {
        let big = 0;
        const count = (id: string): void => {
          const n = doc.nodes[id];
          if (!n) return;
          if (n.type === "text" && n.style.fontSize >= 32) big += 1;
          for (const c of n.children) count(c);
        };
        count(frameId);
        if (big > 1) {
          issues.push({
            nodeId: frameId,
            level: "warn",
            message: `Страница «${doc.nodes[frameId]!.name}»: заголовков уровня h1 — ${big}, должен быть один`,
          });
        }
      }

      if (issues.length === 0) {
        log("ok", "Проверка пройдена: замечаний нет");
        return;
      }
      for (const issue of issues.slice(0, 20)) {
        const name = doc.nodes[issue.nodeId]?.name ?? issue.nodeId;
        log(issue.level === "err" ? "err" : "info", `${name}: ${issue.message}`);
      }
      log("info", `Проверка: замечаний ${issues.length}`);
    },

    setItems: (id, items) => {
      const doc = draft();
      const node = doc.nodes[id];
      if (!node) return;
      // пустые строки отбрасываем: пользователь просто переносит строку
      node.items = items.map((i) => i.trim()).filter(Boolean);
      commit(doc);
    },
    setOrdered: (id, ordered) => {
      const doc = draft();
      if (!doc.nodes[id]) return;
      pushHistory(get().doc);
      doc.nodes[id]!.ordered = ordered;
      commit(doc);
    },
    setCite: (id, cite) => {
      const doc = draft();
      if (!doc.nodes[id]) return;
      doc.nodes[id]!.cite = cite.trim() || undefined;
      commit(doc);
    },
    setIconName: (id, name) => {
      const doc = draft();
      if (!doc.nodes[id]) return;
      doc.nodes[id]!.iconName = name;
      commit(doc);
    },
    setVideoProvider: (id, provider) => {
      const doc = draft();
      if (!doc.nodes[id]) return;
      doc.nodes[id]!.videoProvider = provider;
      commit(doc);
    },
    setFrameRatio: (id, ratio) => {
      const doc = draft();
      if (!doc.nodes[id]) return;
      pushHistory(get().doc);
      doc.nodes[id]!.frameRatio = ratio;
      commit(doc);
    },

    addFrameAt: (wx, wy) => {
      const doc = draft();
      pushHistory(get().doc);
      const frame = createNode("frame", `Страница ${doc.rootFrames.length + 1}`);
      frame.layout.x = Math.round(wx);
      frame.layout.y = Math.round(wy);
      doc.nodes[frame.id] = frame;
      doc.rootFrames.push(frame.id);
      commit(doc);
      set({ selection: [frame.id] });
      get().log("info", `Создан фрейм «${frame.name}»`);
      return frame.id;
    },

    updateLayout: (id, patch) => {
      const doc = draft();
      pushHistory(get().doc);
      const node = doc.nodes[id]!;
      /* ПРАВКА НА БРЕЙКПОИНТЕ идёт в переопределения, а не в базу — иначе,
         подгоняя страницу под телефон, пользователь ломал бы десктоп.
         Неадаптивная часть патча всё равно ложится в базу. */
      const bp = activeBreakpointOf(doc);
      if (bp) {
        const { override, base } = splitResponsivePatch(patch, RESPONSIVE_LAYOUT_KEYS);
        setOverride(node, bp, "layout", override as Record<string, unknown>);
        if (Object.keys(base).length > 0) Object.assign(node.layout, base);
      } else {
        Object.assign(node.layout, patch);
      }
      commit(doc);
    },

    updateStyle: (id, patch) => {
      const doc = draft();
      pushHistory(get().doc);
      const node = doc.nodes[id]!;
      const bp = activeBreakpointOf(doc);
      if (bp) {
        const { override, base } = splitResponsivePatch(patch, RESPONSIVE_STYLE_KEYS);
        setOverride(node, bp, "style", override as Record<string, unknown>);
        if (Object.keys(base).length > 0) Object.assign(node.style, base);
      } else {
        Object.assign(node.style, patch);
      }
      commit(doc);
    },

    setNodeHiddenAt: (id, breakpointId, hidden) => {
      const doc = draft();
      pushHistory(get().doc);
      const node = doc.nodes[id]!;
      const all = (node.responsive ??= {});
      const ov = (all[breakpointId] ??= {});
      if (hidden) ov.hidden = true;
      else delete ov.hidden;
      pruneOverrides(node, breakpointId);
      commit(doc);
    },

    clearOverrides: (id, breakpointId) => {
      const doc = draft();
      const node = doc.nodes[id]!;
      if (!node.responsive?.[breakpointId]) return;
      pushHistory(get().doc);
      delete node.responsive[breakpointId];
      if (Object.keys(node.responsive).length === 0) delete node.responsive;
      commit(doc);
      get().log("info", "Переопределения брейкпоинта сброшены");
    },

    setSrc: (id, src) => {
      const doc = draft();
      pushHistory(get().doc);
      doc.nodes[id]!.src = src.trim() || undefined;
      commit(doc);
      get().log("info", src ? "Картинка обновлена" : "Картинка убрана");
    },

    setHref: (id, href) => {
      const doc = draft();
      pushHistory(get().doc);
      doc.nodes[id]!.href = href.trim() || undefined;
      commit(doc);
      get().log("info", href ? `Ссылка: ${href}` : "Ссылка убрана");
    },

    setText: (id, text) => {
      const doc = draft();
      const now = Date.now();
      const coalesce = lastTextPush && lastTextPush.id === id && now - lastTextPush.ts < 800;
      if (!coalesce) pushHistory(get().doc);
      lastTextPush = { id, ts: now };
      doc.nodes[id]!.text = text;
      commit(doc);
    },

    rename: (id, name) => {
      const doc = draft();
      pushHistory(get().doc);
      doc.nodes[id]!.name = name || doc.nodes[id]!.name;
      commit(doc);
    },

    removeNodes: (ids) => {
      if (ids.length === 0) return;
      const doc = draft();
      pushHistory(get().doc);
      const removeOne = (id: string): void => {
        const node = doc.nodes[id];
        if (!node) return;
        [...node.children].forEach(removeOne);
        if (node.parent) {
          const p = doc.nodes[node.parent]!;
          p.children = p.children.filter((c) => c !== id);
        } else {
          doc.rootFrames = doc.rootFrames.filter((f) => f !== id);
        }
        delete doc.nodes[id];
      };
      ids.forEach(removeOne);
      // компоненты без мастера исчезают, их экземпляры — тоже
      for (const [cid, comp] of Object.entries(doc.components)) {
        if (!doc.nodes[comp.rootId]) delete doc.components[cid];
      }
      const orphanInstances = Object.values(doc.nodes)
        .filter((n) => n.type === "instance" && !doc.components[n.componentRef ?? ""])
        .map((n) => n.id);
      orphanInstances.forEach(removeOne);
      // провода, потерявшие конец, удаляются вместе с узлами
      doc.wires = doc.wires.filter((w) => doc.nodes[w.sourceId] && doc.nodes[w.targetId]);
      commit(doc);
      set({ selection: [], hoverId: null });
      get().log("info", `Удалено узлов: ${ids.length}`);
    },

    duplicateNodes: (ids) => {
      if (ids.length === 0) return;
      const doc = draft();
      pushHistory(get().doc);
      const newIds: string[] = [];
      for (const id of ids) {
        const src = doc.nodes[id];
        if (!src) continue;
        const { newRootId, nodes } = cloneSubtree(doc, id);
        Object.assign(doc.nodes, nodes);
        const copy = doc.nodes[newRootId]!;
        if (copy.layout.position === "absolute" || src.type === "frame") {
          copy.layout.x += 24;
          copy.layout.y += 24;
        }
        if (src.parent) {
          const p = doc.nodes[src.parent]!;
          p.children.splice(p.children.indexOf(id) + 1, 0, newRootId);
        } else {
          doc.rootFrames.push(newRootId);
        }
        newIds.push(newRootId);
      }
      commit(doc);
      set({ selection: newIds });
      get().log("info", "Дублировано (Ctrl+D)");
    },

    reorderChild: (parentId, from, to) => {
      if (from === to) return;
      const doc = draft();
      pushHistory(get().doc);
      const children = doc.nodes[parentId]!.children;
      const [moved] = children.splice(from, 1);
      children.splice(to > from ? to - 1 : to, 0, moved);
      commit(doc);
    },

    beginGesture: () => pushHistory(get().doc),

    moveAbsolute: (id, x, y) => {
      // Без истории: снапшот уже положен beginGesture()
      const doc = draft();
      const node = doc.nodes[id]!;
      node.layout.x = Math.round(x);
      node.layout.y = Math.round(y);
      commit(doc);
    },

    patchLayoutLive: (id, patch) => {
      // Без истории (снапшот кладёт beginGesture в начале жеста)
      const doc = draft();
      const node = doc.nodes[id];
      if (!node) return;
      const rounded = { ...patch };
      for (const k of ["x", "y", "gap", "padding"] as const) {
        if (typeof rounded[k] === "number") rounded[k] = Math.round(rounded[k] as number);
      }
      if (typeof rounded.width === "number") rounded.width = Math.round(rounded.width);
      if (typeof rounded.height === "number") rounded.height = Math.round(rounded.height);
      Object.assign(node.layout, rounded);
      commit(doc);
    },

    addPage: () => {
      const doc = draft();
      pushHistory(get().doc);
      const frame = createNode("frame", `Страница ${doc.rootFrames.length + 1}`);
      // разместить справа от самого правого существующего фрейма
      let maxRight = 120;
      let topY = 120;
      for (const id of doc.rootFrames) {
        const f = doc.nodes[id]!;
        const w = typeof f.layout.width === "number" ? f.layout.width : 1200;
        maxRight = Math.max(maxRight, f.layout.x + w);
        topY = Math.min(topY, f.layout.y);
      }
      frame.layout.x = doc.rootFrames.length === 0 ? 160 : maxRight + 120;
      frame.layout.y = topY;
      doc.nodes[frame.id] = frame;
      doc.rootFrames.push(frame.id);
      commit(doc);
      set((s) => ({ selection: [frame.id], focusNonce: s.focusNonce + 1, focusTargetId: frame.id }));
      get().log("info", `Добавлена страница «${frame.name}»`);
      return frame.id;
    },

    requestFocus: (id) => set((s) => ({ focusNonce: s.focusNonce + 1, focusTargetId: id })),

    toggleEye: () => {
      const eyeMode = !get().eyeMode;
      set({ eyeMode, hoverId: null });
      get().log("info", eyeMode ? "Режим проводов включён: тяни от голубого порта к цели" : "Режим проводов выключен");
    },

    addWire: (sourceId, targetId, action) => {
      const { doc: cur, log } = get();
      if (sourceId === targetId) return;
      const dup = cur.wires.some(
        (w) => w.sourceId === sourceId && w.targetId === targetId && w.action === action,
      );
      if (dup) {
        log("info", "Такая связь уже есть");
        return;
      }
      const doc = draft();
      pushHistory(cur);
      doc.wires.push({ id: uid("wire"), sourceId, targetId, trigger: "click", action });
      commit(doc);
      const s = cur.nodes[sourceId]?.name ?? sourceId;
      const t = cur.nodes[targetId]?.name ?? targetId;
      log("ok", `Связь: «${s}» → ${WIRE_ACTION_LABELS[action].toLowerCase()} → «${t}»`);
    },

    removeWire: (wireId) => {
      const doc = draft();
      pushHistory(get().doc);
      doc.wires = doc.wires.filter((w) => w.id !== wireId);
      commit(doc);
      get().log("info", "Связь удалена");
    },

    addDbTable: () => {
      const doc = draft();
      pushHistory(get().doc);
      const count = Object.keys(doc.dbTables).length;
      const id = uid("tbl");
      doc.dbTables[id] = {
        id,
        name: `Table${count + 1}`,
        x: 60 + (count % 4) * 260,
        y: 60 + Math.floor(count / 4) * 220,
        fields: [
          { id: uid("fld"), name: "title", type: "String", required: true },
        ],
      };
      commit(doc);
      get().log("info", "Добавлена таблица — переименуй и добавь поля");
    },

    removeDbTable: (tableId) => {
      const doc = draft();
      pushHistory(get().doc);
      delete doc.dbTables[tableId];
      doc.dbRelations = doc.dbRelations.filter(
        (r) => r.fromTableId !== tableId && r.toTableId !== tableId,
      );
      // cmslist-узлы, смотревшие на таблицу, отвязываются
      for (const n of Object.values(doc.nodes)) {
        if (n.tableRef === tableId) n.tableRef = undefined;
      }
      commit(doc);
    },

    patchDbTable: (tableId, patch) => {
      const doc = draft();
      pushHistory(get().doc);
      Object.assign(doc.dbTables[tableId] ?? {}, patch);
      commit(doc);
    },

    addDbField: (tableId) => {
      const doc = draft();
      pushHistory(get().doc);
      doc.dbTables[tableId]?.fields.push({ id: uid("fld"), name: "field", type: "String", required: false });
      commit(doc);
    },

    patchDbField: (tableId, fieldId, patch) => {
      const doc = draft();
      pushHistory(get().doc);
      const field = doc.dbTables[tableId]?.fields.find((f) => f.id === fieldId);
      if (field) Object.assign(field, patch);
      commit(doc);
    },

    removeDbField: (tableId, fieldId) => {
      const doc = draft();
      pushHistory(get().doc);
      const table = doc.dbTables[tableId];
      if (table) table.fields = table.fields.filter((f) => f.id !== fieldId);
      commit(doc);
    },

    addDbRelation: (fromTableId, toTableId) => {
      const cur = get().doc;
      if (fromTableId === toTableId) return;
      if (cur.dbRelations.some((r) => r.fromTableId === fromTableId && r.toTableId === toTableId)) {
        get().log("info", "Такая связь уже есть");
        return;
      }
      const doc = draft();
      pushHistory(cur);
      doc.dbRelations.push({ id: uid("rel"), fromTableId, toTableId });
      commit(doc);
      const a = cur.dbTables[fromTableId]?.name;
      const b = cur.dbTables[toTableId]?.name;
      get().log("ok", `Связь БД: ${a} (1) → (N) ${b}`);
    },

    removeDbRelation: (relationId) => {
      const doc = draft();
      pushHistory(get().doc);
      doc.dbRelations = doc.dbRelations.filter((r) => r.id !== relationId);
      commit(doc);
    },

    setDbProvider: (p) => {
      const doc = draft();
      pushHistory(get().doc);
      doc.dbProvider = p;
      commit(doc);
      get().log("info", `Провайдер БД: ${p === "sqlite" ? "SQLite (локально, без установки)" : "PostgreSQL (docker-compose в комплекте)"}`);
    },

    setSiteTarget: (t) => {
      const doc = draft();
      pushHistory(get().doc);
      doc.siteTarget = t;
      commit(doc);
      get().log("ok", `Цель генерации: ${t === "next" ? "Next.js + Prisma" : "статический сайт"}`);
    },

    setCustomCode: (id, code) => {
      const doc = draft();
      pushHistory(get().doc);
      doc.nodes[id]!.customCode = code.trim() || undefined;
      commit(doc);
    },

    setTableRef: (id, tableId) => {
      const doc = draft();
      pushHistory(get().doc);
      doc.nodes[id]!.tableRef = tableId || undefined;
      commit(doc);
    },

    setSticky: (id, sticky) => {
      const doc = draft();
      pushHistory(get().doc);
      doc.nodes[id]!.sticky = sticky || undefined;
      commit(doc);
      get().log("info", sticky ? "Элемент закреплён сверху (sticky)" : "Открепление");
    },

    setScrollFill: (id, fill) => {
      const doc = draft();
      pushHistory(get().doc);
      doc.nodes[id]!.scrollFill = fill || undefined;
      commit(doc);
    },

    setRole: (id, role) => {
      const doc = draft();
      pushHistory(get().doc);
      doc.nodes[id]!.role = role || undefined;
      commit(doc);
      get().log("info", role ? `Роль элемента: ${role} (семантический тег в коде)` : "Роль снята");
    },

    setReveal: (id, reveal) => {
      const doc = draft();
      pushHistory(get().doc);
      doc.nodes[id]!.reveal = reveal;
      commit(doc);
      get().log("info", reveal ? `Анимация появления: ${reveal.kind}, ${reveal.duration}мс` : "Анимация убрана");
    },

    fitFrame: (frameId, contentH) => {
      const doc = draft();
      pushHistory(get().doc);
      const frame = doc.nodes[frameId];
      if (!frame || frame.type !== "frame") return;
      frame.layout.height = Math.max(200, Math.round(contentH));
      commit(doc);
      get().log("ok", `Страница подогнана по содержимому: ${Math.round(contentH)}px`);
    },

    setHrefValue: (id, href) => {
      const doc = draft();
      pushHistory(get().doc);
      doc.nodes[id]!.href = href.trim() || undefined;
      commit(doc);
    },

    setAnchorId: (id, anchorId) => {
      const doc = draft();
      pushHistory(get().doc);
      // валидный html id: латиница/цифры/дефис
      const clean = anchorId.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
      doc.nodes[id]!.anchorId = clean || undefined;
      commit(doc);
      if (clean) get().log("info", `Якорь: ссылки #${clean} прокручивают сюда`);
    },

    detachSmart: (id) => {
      const cur = get().doc;
      const node = cur.nodes[id];
      if (!node || (node.type !== "autonav" && node.type !== "autofooter")) return;
      const isNav = node.type === "autonav";
      const doc = draft();
      pushHistory(cur);
      const n = doc.nodes[id]!;
      const slug = (s: string): string =>
        s.toLowerCase().replace(/[^a-z0-9Ѐ-ӿ]+/g, "-").replace(/^-|-$/g, "") || "section";

      const mk = (type: NodeType, name: string, parentId: string): SceneDocument["nodes"][string] => {
        const c = createNode(type, name);
        c.parent = parentId;
        doc.nodes[c.id] = c;
        doc.nodes[parentId]!.children.push(c.id);
        return doc.nodes[c.id]!;
      };

      // превращаем умный узел в обычный контейнер
      n.type = "container";
      n.children = [];
      n.tableRef = undefined;
      n.layout = {
        ...n.layout,
        direction: isNav ? "row" : "column",
        gap: isNav ? 24 : 12,
        padding: isNav ? 20 : 24,
        align: isNav ? "center" : "start",
        justify: isNav ? "between" : "start",
        width: "fill",
      };
      if (n.style.fill === "transparent") n.style.fill = isNav ? "$surface" : "$surface";

      const pages = doc.rootFrames;
      if (isNav) {
        const brand = mk("text", "Логотип", id);
        brand.text = get().projectName;
        brand.style = { ...brand.style, fontSize: 20, fontWeight: 700, textColor: "$text" };

        const menu = mk("container", "Меню", id);
        menu.layout = { ...menu.layout, direction: "row", gap: 24, align: "center", width: "hug", padding: 0 };
        for (const f of pages) {
          const l = mk("text", "Ссылка", menu.id);
          l.text = doc.nodes[f]!.name;
          l.style = { ...l.style, fontSize: 15, textColor: "$muted" };
          l.href = `#${slug(doc.nodes[f]!.name)}`;
        }
      } else {
        const links = mk("container", "Ссылки подвала", id);
        links.layout = { ...links.layout, direction: "row", gap: 18, width: "hug", padding: 0 };
        for (const f of pages) {
          const l = mk("text", "Ссылка", links.id);
          l.text = doc.nodes[f]!.name;
          l.style = { ...l.style, fontSize: 13, textColor: "$muted" };
          l.href = `#${slug(doc.nodes[f]!.name)}`;
        }
        const cop = mk("text", "Копирайт", id);
        cop.text = `© ${new Date().getFullYear()} ${get().projectName}`;
        cop.style = { ...cop.style, fontSize: 12, textColor: "$muted" };
      }
      commit(doc);
      set({ selection: [id] });
      get().log("ok", `${isNav ? "Навбар" : "Подвал"} разобран — теперь редактируется как обычные элементы`);
    },

    syncSlotsFromCode: (slots) => {
      const doc = draft();
      pushHistory(get().doc);
      let updated = 0;
      for (const [nodeId, code] of Object.entries(slots)) {
        const node = doc.nodes[nodeId];
        if (node && (node.customCode ?? "") !== code.trim()) {
          node.customCode = code.trim() || undefined;
          updated += 1;
        }
      }
      commit(doc);
      get().log(updated > 0 ? "ok" : "info", `Слоты из кода: обновлено ${updated}`);
    },

    setTheme: (patch) => {
      const doc = draft();
      pushHistory(get().doc);
      doc.theme = { ...doc.theme, ...patch };
      commit(doc);
      get().log("ok", `Стиль сайта: ${doc.theme.preset}, акцент ${doc.theme.accent}`);
    },

    createComponent: (nodeId) => {
      const cur = get().doc;
      const node = cur.nodes[nodeId];
      if (!node || node.type === "frame" || node.type === "instance") {
        get().log("err", "Компонент можно создать из любого элемента, кроме страницы и экземпляра");
        return;
      }
      const already = Object.values(cur.components).some((c) => c.rootId === nodeId);
      if (already) {
        get().log("info", "Этот элемент уже является компонентом");
        return;
      }
      const doc = draft();
      pushHistory(cur);
      doc.components[uid("comp")] = { name: node.name, rootId: nodeId };
      commit(doc);
      get().log("ok", `Создан компонент «${node.name}» — вставляй экземпляры через меню «Вставка»`);
    },

    addInstance: (componentId, parentId) => {
      const cur = get().doc;
      const comp = cur.components[componentId];
      if (!comp) return;
      const doc = draft();
      pushHistory(cur);
      const node = createNode("instance", `⟐ ${comp.name}`);
      node.componentRef = componentId;
      node.parent = parentId;
      doc.nodes[node.id] = node;
      doc.nodes[parentId]!.children.push(node.id);
      commit(doc);
      set({ selection: [node.id] });
      get().log("info", `Вставлен экземпляр «${comp.name}» — правь мастер, экземпляры обновятся`);
    },

    undo: () => {
      if (past.length === 0) return;
      future.push(snapshot(get().doc));
      const doc = JSON.parse(past.pop()!) as SceneDocument;
      set((s) => ({
        doc,
        rev: s.rev + 1,
        selection: s.selection.filter((id) => doc.nodes[id]),
        hoverId: null,
      }));
    },

    redo: () => {
      if (future.length === 0) return;
      past.push(snapshot(get().doc));
      const doc = JSON.parse(future.pop()!) as SceneDocument;
      set((s) => ({
        doc,
        rev: s.rev + 1,
        selection: s.selection.filter((id) => doc.nodes[id]),
        hoverId: null,
      }));
    },

    openTab: (path) => {
      set((s) => ({
        openTabs: s.openTabs.includes(path) ? s.openTabs : [...s.openTabs, path],
        activeTab: path,
      }));
    },

    closeTab: (path) => {
      set((s) => {
        const openTabs = s.openTabs.filter((t) => t !== path);
        const activeTab = s.activeTab === path ? "canvas" : s.activeTab;
        return { openTabs, activeTab };
      });
    },

    setActiveTab: (tab) => set({ activeTab: tab }),

    getFileContent: (path) => {
      const { doc, projectName } = get();
      const cached = fsCache.get(path);
      if (cached !== undefined) return cached;
      if (path === "plexus.json") return JSON.stringify({ version: 1, name: projectName, doc }, null, 2);
      const { files } = generateProject(doc, projectName);
      return files[path] ?? `// Файл не найден: ${path}`;
    },

    openFsFile: async (path) => {
      try {
        const content = await host.readTextFile(path);
        fsCache.set(path, content);
        get().openTab(path);
      } catch (e) {
        get().log("err", `Не удалось открыть файл: ${String(e)}`);
      }
    },

    getProjectFiles: () => {
      const { doc, projectName } = get();
      const { files } = generateProject(doc, projectName);
      // index.html первым, styles.css последним, остальные страницы между
      const site = Object.keys(files).sort((a, b) => {
        const rank = (p: string) => (p.endsWith("index.html") ? 0 : p.endsWith(".css") ? 2 : 1);
        return rank(a) - rank(b) || a.localeCompare(b);
      });
      return ["plexus.json", ...site];
    },

    log: (level, msg, nodeId) =>
      set((s) => ({ logs: [...s.logs.slice(-199), { ts: Date.now(), level, msg, nodeId }] })),

    exportSite: async () => {
      const { doc, projectName, log, openTab } = get();
      const { files } = generateProject(doc, projectName);
      const written = await host.writeSiteFiles(files);
      openTab("site/index.html");
      const count = Object.keys(files).length;
      if (written) log("ok", `Экспорт: ${count} файлов записано в site/ на диск`);
      else log("info", `Экспорт: ${count} файлов сгенерировано (веб-режим — виртуальные, открыты вкладками)`);
    },

    saveProject: async () => {
      const { doc, projectName, log } = get();
      const payload = JSON.stringify({ version: 1, name: projectName, doc }, null, 2);
      const persisted = await host.saveProjectFile(payload);
      set({ savedAt: Date.now(), projectPath: host.getActiveRoot() });
      log("ok", persisted ? "Сохранено: plexus.json" : "Сохранено локально (localStorage)");
    },

    newProject: async ({ parentDir, name, theme, secondPage, siteTarget }) => {
      const doc = createStarterDocument({ theme, secondPage, siteTarget });
      // сброс истории — новый проект начинается с чистого листа
      past = [];
      future = [];
      const cleanName = name.trim() || "plexus-site";
      commit(doc);
      set({ selection: [], projectName: cleanName });
      if (host.isTauri() && parentDir) {
        const root = `${parentDir.replace(/[\\/]+$/, "")}/${cleanName}`;
        host.setActiveRoot(root);
        await host.saveProjectFile(JSON.stringify({ version: 1, name: cleanName, doc }, null, 2));
        set({ projectPath: root, savedAt: Date.now() });
        get().log("ok", `Создан проект «${cleanName}» → ${root}`);
      } else {
        host.setActiveRoot(null);
        set({ projectPath: null });
        get().log("info", `Новый проект «${cleanName}» (веб-режим, хранится локально)`);
      }
      set((s) => ({ focusNonce: s.focusNonce + 1, focusTargetId: doc.rootFrames[0] ?? null }));
    },

    importHtmlSite: async ({ htmlPath, viewportWidth }) => {
      const { log } = get();
      try {
        const html = await host.readTextFile(htmlPath);
        const dir = htmlPath.replace(/[\\/][^\\/]*$/, "");
        // подтягиваем локальные CSS из <link href="…"> (кавычки любые, пути нормализуем)
        let css = "";
        let cssFound = 0;
        for (const m of html.matchAll(/<link[^>]+href=["']([^"']+\.css)(?:\?[^"']*)?["'][^>]*>/g)) {
          if (/^https?:/.test(m[1])) continue;
          const rel = m[1].replace(/^\.?\//, "");
          try {
            css += `\n${await host.readTextFile(`${dir}/${rel}`)}`;
            cssFound += 1;
          } catch {
            log("info", `CSS не найден рядом с html: ${rel}`);
          }
        }
        if (cssFound > 0) log("info", `CSS подключено: файлов ${cssFound}`);
        const pageName =
          /<title>([^<]*)<\/title>/.exec(html)?.[1]?.trim().split(/[—|-]/)[0]?.trim() ||
          htmlPath.split(/[\\/]/).pop()!.replace(/\.html?$/, "");

        const doc = draft();
        pushHistory(get().doc);
        const outcome = importHtmlToDoc(doc, { html, css, pageName, sourceDir: dir, viewportWidth });
        commit(doc);
        set((s) => ({ selection: [outcome.frameId], focusNonce: s.focusNonce + 1, focusTargetId: outcome.frameId }));
        log("ok", `Импортирована страница «${pageName}»: узлов ${outcome.nodesAdded}${outcome.warnings.length ? `, замечания: ${[...new Set(outcome.warnings)].join("; ")}` : ""}`);
        applyImportedFonts(outcome, log);
        reportImportSource(outcome, log);


        // локальные картинки копируем в assets проекта (если проект на диске)
        const root = await host.projectRoot();
        if (root && outcome.imagesToCopy.length > 0) {
          const doc2 = draft();
          let copied = 0;
          for (const img of outcome.imagesToCopy) {
            try {
              const rel = await host.copyIntoAssetsFrom(img.absPath);
              if (rel && doc2.nodes[img.nodeId]) {
                doc2.nodes[img.nodeId]!.src = rel;
                copied += 1;
              }
            } catch {
              /* картинка не нашлась — оставляем как есть */
            }
          }
          if (copied > 0) {
            commit(doc2);
            log("ok", `Картинки скопированы в site/assets: ${copied}`);
          }
        } else if (outcome.imagesToCopy.length > 0) {
          log("info", "Сохрани проект на диск (Ctrl+S) и повтори импорт, чтобы картинки скопировались в assets");
        }
      } catch (e) {
        log("err", `Импорт не удался: ${String(e)}`);
      }
    },

    importUrlSite: async (url, viewportWidth) => {
      const { log } = get();
      const pageUrl = /^https?:\/\//.test(url) ? url : `https://${url}`;
      try {
        log("info", `Скачиваю ${pageUrl}…`);
        const html = await host.fetchUrl(pageUrl);
        // связанные CSS: <link rel=stylesheet href> → абсолютные URL → скачать
        let css = "";
        let cssN = 0;
        for (const m of html.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]*>/gi)) {
          if (!/stylesheet/i.test(m[0]) && !/\.css(\?|$)/i.test(m[1])) continue;
          try {
            const abs = new URL(m[1], pageUrl).href;
            css += `\n${await host.fetchUrl(abs)}`;
            cssN += 1;
          } catch {
            /* пропускаем недоступный css */
          }
        }
        const pageName =
          /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim().split(/[—|-]/)[0]?.trim() ||
          new URL(pageUrl).hostname;

        const doc = draft();
        pushHistory(get().doc);
        const outcome = importHtmlToDoc(doc, { html, css, pageName, baseUrl: pageUrl, viewportWidth });
        commit(doc);
        set((s) => ({ selection: [outcome.frameId], focusNonce: s.focusNonce + 1, focusTargetId: outcome.frameId }));
        log(
          "ok",
          `Импортировано с ${new URL(pageUrl).hostname}: узлов ${outcome.nodesAdded}, css-файлов ${cssN}${
            outcome.warnings.length ? `; ${[...new Set(outcome.warnings)].join("; ")}` : ""
          }`,
        );
        applyImportedFonts(outcome, log);
        reportImportSource(outcome, log);

      } catch (e) {
        log("err", `Импорт по ссылке не удался: ${String(e)}. В десктоп-версии CORS обходится, в браузере — нет.`);
      }
    },

    importUrlViaBrowser: async (url, viewportWidth) => {
      const { log } = get();
      const pageUrl = /^https?:\/\//.test(url) ? url : `https://${url}`;
      const width = viewportWidth ?? 1440;
      try {
        log("info", `Открываю ${pageUrl} в браузере и жду сборки страницы…`);
        const snapshot = (await host.captureSnapshot({
          url: pageUrl,
          /* В приложении сборщик — единственный, кто знает о готовности
             страницы: в отличие от стенда, здесь никто заранее не ждёт
             затишья сети средствами браузера. Поэтому порог ожидания выше:
             полторы секунды не хватало, снимок уходил до гидратации. */
          collector: collectorScript({ settleMs: 2500, quietMs: 1200, ceilingMs: 25000 }),
          width,
          height: Math.round(width * 0.625),
        })) as PageSnapshot;

        if (!snapshot || !Array.isArray(snapshot.nodes)) {
          log("err", "Снимок не получен: страница ничего не вернула");
          return;
        }
        log(
          "ok",
          `Снимок готов: элементов ${snapshot.nodes.length}, скрытых пропущено ${snapshot.skipped}, ` +
            `ждали ${snapshot.settleMs} мс` +
            (snapshot.settleReason ? ` (${snapshot.settleReason})` : ""),
        );

        const doc = draft();
        pushHistory(get().doc);
        const outcome = importSnapshotToDoc(doc, {
          snapshot,
          pageName: snapshot.title.split(/[—|-]/)[0]?.trim() || new URL(pageUrl).hostname,
          baseUrl: pageUrl,
        });
        commit(doc);
        set((st) => ({
          selection: [outcome.frameId],
          focusNonce: st.focusNonce + 1,
          focusTargetId: outcome.frameId,
        }));
        log("ok", `Импортировано узлов ${outcome.nodesAdded}, служебных обёрток свёрнуто ${outcome.collapsed}`);
        if (outcome.fontFamilies.length > 0) {
          log("info", `Шрифты страницы: ${outcome.fontFamilies.map((f) => f.split(",")[0].replace(/['"]/g, "")).join(", ")}`);
        }
        if (outcome.widgets.length > 0) {
          log("info", `Сторонние виджеты: ${outcome.widgets.join("; ")}`);
        }
        for (const w of outcome.warnings) log("info", w);
      } catch (e) {
        log("err", `Снимок не удался: ${String(e instanceof Error ? e.message : e)}`);
      }
    },

    renameProject: (name) => {
      const clean = name.trim();
      if (!clean || clean === get().projectName) return;
      set({ projectName: clean });
      get().log("info", `Проект переименован: «${clean}» (Ctrl+S — сохранить)`);
    },

    openProject: async (dir) => {
      const clean = dir.replace(/[\\/]+$/, "");
      host.setActiveRoot(clean);
      const saved = await host.loadProjectFile();
      if (!saved) {
        get().log("err", `В папке нет plexus.json: ${clean}`);
        return;
      }
      try {
        const parsed = JSON.parse(saved) as { doc: SceneDocument; name?: string };
        if (!parsed.doc?.nodes) throw new Error("нет поля doc");
        past = [];
        future = [];
        const name = parsed.name || clean.split(/[\\/]/).pop() || "project";
        commit(normalizeDoc(parsed.doc));
        set({
          selection: [],
          projectPath: clean,
          projectName: name,
          savedAt: Date.now(),
        });
        set((s) => ({ focusNonce: s.focusNonce + 1, focusTargetId: parsed.doc.rootFrames[0] ?? null }));
        get().log("ok", `Открыт проект: ${clean}`);
      } catch (e) {
        get().log("err", `plexus.json повреждён: ${String(e)}`);
      }
    },
  };
});

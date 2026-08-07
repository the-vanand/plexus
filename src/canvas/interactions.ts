/**
 * КОНТРОЛЛЕР ВЗАИМОДЕЙСТВИЙ С ХОЛСТОМ.
 *
 * Осознанное решение: слушаем «сырые» DOM-события и делаем собственный
 * hit-test по прямоугольникам решателя раскладки, НЕ полагаясь на систему
 * событий Pixi. Так контроллер остаётся независимым от рендерера — при
 * переходе на Rust + wgpu он переезжает без изменений.
 *
 * Жесты:
 *  - колесо: пан;  Ctrl/Cmd + колесо: зум к курсору;
 *  - средняя кнопка / Space + drag: пан;
 *  - drag по пустоте: рамка выделения (Shift — добавить, Alt — исключить);
 *  - левый клик: выделение (Shift/Alt — переключить узел в наборе);
 *    drag выделенного:
 *      absolute/фрейм → живое перемещение со снапом и направляющими,
 *      flow-ребёнок  → перестановка внутри родителя с индикатором вставки;
 *  - правый клик: контекстное меню (добавление элементов);
 *  - Del, Ctrl+Z/Shift+Z, Ctrl+D, Ctrl+S, Esc.
 */
import type { Camera, GapBadge, Guide, InsertionLine, Rect } from "../core/types";
import { useStore } from "../core/store";
import { useUi } from "../core/uiStore";
import {
  collectInMarquee,
  findDeepestAt,
  isContainerLike,
  mergeSelection,
  padBox,
  type MarqueeMode,
} from "../core/scene";
import { computeSnap } from "./guides";
import { GRID_SIZE } from "./renderer";
import {
  computeHandles,
  deg2rad,
  rad2deg,
  rotateAround,
  rotateVec,
  rectFromPoints,
  HANDLE_DIRS,
  HANDLE_CURSOR,
  HANDLE_KEYS,
  type HandleKey,
} from "../core/geometry";

export interface ContextMenuRequest {
  screenX: number;
  screenY: number;
  worldX: number;
  worldY: number;
  targetId: string | null;
}

export interface WireMenuRequest {
  sourceId: string;
  targetId: string;
  screenX: number;
  screenY: number;
}

export interface WireCutRequest {
  wireId: string;
  screenX: number;
  screenY: number;
}

export interface ControllerHooks {
  /** Актуальные прямоугольники раскладки (кэш держит PixiCanvas). */
  getRects: () => Map<string, Rect>;
  requestRender: () => void;
  openContextMenu: (req: ContextMenuRequest) => void;
  /** Провод дотянут до цели — выбрать действие связи. */
  openWireMenu: (req: WireMenuRequest) => void;
  /** Клик по существующему проводу — предложить разрезать. */
  openWireCut: (req: WireCutRequest) => void;
  onZoomChange: (zoom: number) => void;
}

type Mode =
  | "idle"
  | "pan"
  | "marquee"
  | "maybe-drag"
  | "drag-abs"
  | "drag-flow"
  | "resize"
  | "rotate"
  | "wire";

const DRAG_THRESHOLD_PX = 4;
const ZOOM_MIN = 0.08;
const ZOOM_MAX = 4;
const MIN_SIZE = 8;
const ROT_HANDLE_SCREEN = 26;
const HANDLE_HIT_PX = 10;

export class InteractionController {
  camera: Camera = { x: 0, y: 0, zoom: 1 };

  /** Визуальное состояние жеста — читает рендерер. */
  guides: Guide[] = [];
  badges: GapBadge[] = [];
  insertion: InsertionLine | null = null;
  dragOutline: Rect | null = null;
  /** Рамка выделения в мировых координатах; null — пока порог не пройден. */
  marquee: Rect | null = null;

  private mode: Mode = "idle";
  private spaceDown = false;
  private shiftDown = false;
  private downScreen = { x: 0, y: 0 };
  private lastScreen = { x: 0, y: 0 };
  private dragId: string | null = null;
  private grabOffset = { x: 0, y: 0 };
  private flowDropIndex = -1;

  // состояние рамки выделения (фиксируется в начале жеста)
  private marqueeStart = { x: 0, y: 0 };
  private marqueeBase: string[] = [];
  private marqueeMode: MarqueeMode = "replace";

  // состояние ресайза/поворота (захватывается один раз в начале жеста)
  private activeHandle: HandleKey | null = null;
  private startRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private startRotationDeg = 0;
  private startPointerAngle = 0;
  /* Исходные режимы размера захватываются в начале жеста: ресайз по одной
     оси не должен затирать hug/fill на другой (см. updateResize). */
  private startSizeW: number | "hug" | "fill" = "hug";
  private startSizeH: number | "hug" | "fill" = "hug";

  /* Shift-перетаскивание (как в PowerPoint): ось выбирается по первому
     движению и держится до конца жеста. */
  private axisLock: "x" | "y" | null = null;
  private dragStartWorld = { x: 0, y: 0 };

  // состояние тяги провода (режим «глазик») — читает рендерер
  wireDrag: { fromId: string; toX: number; toY: number } | null = null;
  wireTargetId: string | null = null;

  private readonly disposers: Array<() => void> = [];

  constructor(
    private readonly el: HTMLCanvasElement,
    private readonly hooks: ControllerHooks,
  ) {
    this.listen(el, "pointerdown", this.onPointerDown);
    this.listen(window, "pointermove", this.onPointerMove);
    this.listen(window, "pointerup", this.onPointerUp);
    this.listen(el, "wheel", this.onWheel, { passive: false });
    this.listen(el, "contextmenu", this.onContextMenu);
    this.listen(window, "keydown", this.onKeyDown);
    this.listen(window, "keyup", this.onKeyUp);
  }

  destroy(): void {
    this.disposers.forEach((d) => d());
  }

  /** Вписать все фреймы в вьюпорт при старте. */
  fitToContent(viewportW: number, viewportH: number): void {
    const rects = this.hooks.getRects();
    const { doc } = useStore.getState();
    const frames = doc.rootFrames.map((id) => rects.get(id)).filter(Boolean) as Rect[];
    if (frames.length === 0) return;
    const minX = Math.min(...frames.map((r) => r.x));
    const minY = Math.min(...frames.map((r) => r.y));
    const maxX = Math.max(...frames.map((r) => r.x + r.w));
    const maxY = Math.max(...frames.map((r) => r.y + r.h));
    const pad = 80;
    const zoom = Math.min(
      0.95,
      viewportW / (maxX - minX + pad * 2),
      viewportH / (maxY - minY + pad * 2),
    );
    this.camera = {
      zoom,
      x: minX - (viewportW / zoom - (maxX - minX)) / 2,
      y: minY - (viewportH / zoom - (maxY - minY)) / 2,
    };
    this.hooks.onZoomChange(zoom);
  }

  /* ---------------- координаты ---------------- */

  private screenPoint(e: MouseEvent): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: this.camera.x + sx / this.camera.zoom, y: this.camera.y + sy / this.camera.zoom };
  }

  private toScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - this.camera.x) * this.camera.zoom, y: (wy - this.camera.y) * this.camera.zoom };
  }

  /** Проверка попадания в ручку выделенного узла. Возвращает ключ, "rotate" или null. */
  private hitTestHandles(id: string, s: { x: number; y: number }): HandleKey | "rotate" | null {
    const r = this.hooks.getRects().get(id);
    const node = useStore.getState().doc.nodes[id];
    if (!r || !node) return null;
    const a = deg2rad(node.layout.rotation || 0);
    const H = computeHandles(r, a, ROT_HANDLE_SCREEN / this.camera.zoom);
    const near = (wx: number, wy: number): boolean => {
      const p = this.toScreen(wx, wy);
      return Math.hypot(p.x - s.x, p.y - s.y) <= HANDLE_HIT_PX;
    };
    if (near(H.rotate.x, H.rotate.y)) return "rotate";
    for (const key of HANDLE_KEYS) {
      if (near(H.points[key].x, H.points[key].y)) {
        /* ХВАТКА ИЗНУТРИ — ЭТО ПЕРЕНОС, А НЕ РЕСАЙЗ.
           У мелкого узла (иконка 16-24px) зоны ручек накрывают его
           целиком: любая попытка перетащить превращалась в ресайз, и
           элемент «расширялся вместо смены координат». Как в Figma:
           ресайз начинается с границы или снаружи; точка глубже 3px
           ВНУТРИ коробки принадлежит переносу. Проверка в локальных
           осях узла, чтобы работала и на повёрнутых. */
        const wpt = this.toWorld(s.x, s.y);
        const cx = r.x + r.w / 2;
        const cy = r.y + r.h / 2;
        const loc = rotateVec(wpt.x - cx, wpt.y - cy, -a);
        const inset = 3 / Math.max(this.camera.zoom, 0.05);
        const deepInside =
          Math.abs(loc.x) < r.w / 2 - inset && Math.abs(loc.y) < r.h / 2 - inset;
        if (deepInside) return null;
        return key;
      }
    }
    return null;
  }

  /** Центрировать камеру на фрейме (страница) — вызывается из панели «Страницы». */
  focusOn(id: string): void {
    const r = this.hooks.getRects().get(id);
    if (!r) return;
    const vw = this.el.clientWidth;
    const vh = this.el.clientHeight;
    const pad = 80;
    const zoom = Math.min(1.2, vw / (r.w + pad * 2), vh / (r.h + pad * 2));
    this.camera = {
      zoom,
      x: r.x - (vw / zoom - r.w) / 2,
      y: r.y - (vh / zoom - r.h) / 2,
    };
    this.hooks.onZoomChange(zoom);
    this.hooks.requestRender();
  }

  /* ---------------- события ---------------- */

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button === 2) return; // контекст-меню обрабатывается отдельно
    const s = this.screenPoint(e);
    this.downScreen = s;
    this.lastScreen = s;

    if (e.button === 1 || this.spaceDown) {
      this.mode = "pan";
      return;
    }

    // Режим «глазик»: тяга провода от порта или разрез существующего провода
    if (useStore.getState().eyeMode) {
      const portId = this.hitTestOutputPort(s);
      if (portId) {
        const w = this.toWorld(s.x, s.y);
        this.wireDrag = { fromId: portId, toX: w.x, toY: w.y };
        this.wireTargetId = null;
        this.mode = "wire";
        return;
      }
      const wireId = this.hitTestWire(s);
      if (wireId) {
        const rect = this.el.getBoundingClientRect();
        this.hooks.openWireCut({ wireId, screenX: rect.left + s.x, screenY: rect.top + s.y });
        return;
      }
      this.mode = "pan"; // в режиме проводов холст только панорамируется
      return;
    }

    // Ручки трансформации выделенного узла имеют приоритет над выделением
    const sel = useStore.getState().selection;
    if (sel.length === 1) {
      const handle = this.hitTestHandles(sel[0], s);
      if (handle === "rotate") {
        this.dragId = sel[0];
        this.startRotate();
        return;
      }
      if (handle) {
        this.dragId = sel[0];
        this.activeHandle = handle;
        this.startResize();
        return;
      }
    }

    const w = this.toWorld(s.x, s.y);
    const store = useStore.getState();
    const hit = findDeepestAt(store.doc, this.hooks.getRects(), w.x, w.y);

    if (!hit) {
      /* ПРОТЯЖКА ПО ПУСТОМУ МЕСТУ — РАМКА ВЫДЕЛЕНИЯ, А НЕ ПАНОРАМА.
         Панорамирование никуда не делось: средняя кнопка, Space + drag и
         колесо. А вот выделить группу узлов больше нечем, и жест «потянуть
         по пустоте» — то, что пользователь ждёт с рабочего стола.
         Выделение не сбрасываем сразу: оно нужно как база для Shift/Alt,
         а при клике без протяжки сбросится на отпускании. */
      this.marqueeBase = store.selection;
      this.marqueeMode = marqueeModeOf(e);
      this.marqueeStart = { x: w.x, y: w.y };
      this.marquee = null;
      this.mode = "marquee";
      return;
    }

    /* Клик с модификатором правит набор, а не начинает перетаскивание:
       Shift — переключить узел, Alt — убрать из набора. */
    if (e.shiftKey || e.altKey) {
      const sel = store.selection;
      const inSet = sel.includes(hit);
      store.select(
        e.altKey || inSet ? sel.filter((id) => id !== hit) : [...sel, hit],
      );
      this.mode = "idle";
      this.hooks.requestRender();
      return;
    }

    store.select([hit]);
    this.dragId = hit;
    this.mode = "maybe-drag";

    const rect = this.hooks.getRects().get(hit)!;
    this.grabOffset = { x: w.x - rect.x, y: w.y - rect.y };
  };

  private onPointerMove = (e: PointerEvent): void => {
    const s = this.screenPoint(e);
    const dx = s.x - this.lastScreen.x;
    const dy = s.y - this.lastScreen.y;
    this.lastScreen = s;
    this.shiftDown = e.shiftKey;

    switch (this.mode) {
      case "pan": {
        this.camera.x -= dx / this.camera.zoom;
        this.camera.y -= dy / this.camera.zoom;
        this.hooks.requestRender();
        return;
      }
      case "marquee": {
        this.updateMarquee(s);
        return;
      }
      case "maybe-drag": {
        const moved = Math.hypot(s.x - this.downScreen.x, s.y - this.downScreen.y);
        if (moved < DRAG_THRESHOLD_PX) return;
        this.beginDrag();
        return;
      }
      case "drag-abs":
        this.updateAbsDrag(s);
        return;
      case "drag-flow":
        this.updateFlowDrag(s);
        return;
      case "resize":
        this.updateResize(s);
        return;
      case "rotate":
        this.updateRotate(s);
        return;
      case "wire":
        this.updateWireDrag(s);
        return;
      default: {
        // idle: курсор над ручкой + ховер по элементам
        const store = useStore.getState();
        if (store.eyeMode) {
          this.el.style.cursor = this.hitTestOutputPort(s)
            ? "crosshair"
            : this.hitTestWire(s)
              ? "pointer"
              : "default";
          return;
        }
        let overHandle = false;
        if (store.selection.length === 1) {
          const h = this.hitTestHandles(store.selection[0], s);
          if (h === "rotate") {
            this.el.style.cursor = "grab";
            overHandle = true;
          } else if (h) {
            this.el.style.cursor = HANDLE_CURSOR[h];
            overHandle = true;
          }
        }
        if (!overHandle) this.el.style.cursor = "default";

        const w = this.toWorld(s.x, s.y);
        const hit = findDeepestAt(store.doc, this.hooks.getRects(), w.x, w.y);
        if (hit !== store.hoverId) {
          store.setHover(hit);
          this.hooks.requestRender();
        }
      }
    }
  };

  /* ---------------- рамка выделения ---------------- */

  /**
   * Обновление рамки: набор пересчитывается на каждом движении, поэтому
   * подсветка выделенных узлов идёт вживую, а не появляется на отпускании.
   * Порог в пикселях защищает от дрожания руки при обычном клике по пустоте.
   */
  private updateMarquee(s: { x: number; y: number }): void {
    if (this.marquee === null) {
      const moved = Math.hypot(s.x - this.downScreen.x, s.y - this.downScreen.y);
      if (moved < DRAG_THRESHOLD_PX) return;
    }
    const w = this.toWorld(s.x, s.y);
    this.marquee = rectFromPoints(this.marqueeStart.x, this.marqueeStart.y, w.x, w.y);
    const store = useStore.getState();
    const hits = collectInMarquee(store.doc, this.hooks.getRects(), this.marquee);
    const next = mergeSelection(this.marqueeBase, hits, this.marqueeMode);
    /* Записываем в стор, только когда набор реально изменился: иначе каждое
       движение мыши перерисовывает инспектор и дерево слоёв впустую. */
    const cur = store.selection;
    if (next.length !== cur.length || next.some((id, i) => id !== cur[i])) {
      store.select(next);
    }
    this.hooks.requestRender();
  }

  /* ---------------- провода («глазик») ---------------- */

  /** Попадание в голубой выходной порт (правый центр элемента). */
  private hitTestOutputPort(s: { x: number; y: number }): string | null {
    const store = useStore.getState();
    for (const [id, r] of this.hooks.getRects()) {
      const node = store.doc.nodes[id];
      if (!node || node.type === "frame") continue;
      const p = this.toScreen(r.x + r.w, r.y + r.h / 2);
      if (Math.hypot(p.x - s.x, p.y - s.y) <= HANDLE_HIT_PX) return id;
    }
    return null;
  }

  /**
   * Попадание в провод: кривая та же, что рисует рендерер (кубический Безье
   * с горизонтальными «усами»), сэмплируем 25 точек в экранных координатах.
   */
  private hitTestWire(s: { x: number; y: number }): string | null {
    const store = useStore.getState();
    const rects = this.hooks.getRects();
    for (const wire of store.doc.wires) {
      const sr = rects.get(wire.sourceId);
      const tr = rects.get(wire.targetId);
      if (!sr || !tr) continue;
      const a = this.toScreen(sr.x + sr.w, sr.y + sr.h / 2);
      const b = this.toScreen(tr.x, tr.y + tr.h / 2);
      const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
      const c1 = { x: a.x + dx, y: a.y };
      const c2 = { x: b.x - dx, y: b.y };
      for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        const mt = 1 - t;
        const px = mt ** 3 * a.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t ** 3 * b.x;
        const py = mt ** 3 * a.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t ** 3 * b.y;
        if (Math.hypot(px - s.x, py - s.y) <= 8) return wire.id;
      }
    }
    return null;
  }

  private updateWireDrag(s: { x: number; y: number }): void {
    if (!this.wireDrag) return;
    const w = this.toWorld(s.x, s.y);
    this.wireDrag = { ...this.wireDrag, toX: w.x, toY: w.y };
    const store = useStore.getState();
    const hit = findDeepestAt(store.doc, this.hooks.getRects(), w.x, w.y);
    this.wireTargetId = hit && hit !== this.wireDrag.fromId ? hit : null;
    this.hooks.requestRender();
  }

  /* ---------------- ресайз и поворот ---------------- */

  private startResize(): void {
    const store = useStore.getState();
    const r = this.hooks.getRects().get(this.dragId!);
    const node = store.doc.nodes[this.dragId!];
    if (!r || !node) {
      this.mode = "idle";
      return;
    }
    if (node.type === "instance") {
      store.log("info", "Размер экземпляра диктует мастер компонента — меняй мастер");
      this.mode = "idle";
      return;
    }
    this.startRect = { ...r };
    this.startRotationDeg = node.layout.rotation || 0;
    this.startSizeW = node.layout.width;
    this.startSizeH = node.layout.height;
    store.beginGesture();
    this.mode = "resize";
  }

  private updateResize(s: { x: number; y: number }): void {
    const store = useStore.getState();
    const node = store.doc.nodes[this.dragId!];
    if (!node || !this.activeHandle) return;

    const r = this.startRect;
    const a = deg2rad(this.startRotationDeg);
    const [hx, hy] = HANDLE_DIRS[this.activeHandle];
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;

    // Неподвижный якорь = противоположная ручка (в мировых координатах)
    const anchor = rotateAround(cx - (hx * r.w) / 2, cy - (hy * r.h) / 2, cx, cy, a);
    const pw = this.toWorld(s.x, s.y);
    // Вектор от якоря к курсору в локальных осях узла
    const local = rotateVec(pw.x - anchor.x, pw.y - anchor.y, -a);

    const newW = hx !== 0 ? Math.max(MIN_SIZE, Math.abs(local.x)) : r.w;
    const newH = hy !== 0 ? Math.max(MIN_SIZE, Math.abs(local.y)) : r.h;

    // Новый центр так, чтобы якорь остался на месте
    const off = rotateVec((hx * newW) / 2, (hy * newH) / 2, a);
    const ncx = anchor.x + off.x;
    const ncy = anchor.y + off.y;
    const nx = ncx - newW / 2;
    const ny = ncy - newH / 2;

    /* НЕТРОНУТАЯ ОСЬ СОХРАНЯЕТ РЕЖИМ РАЗМЕРА.
       Ресайз писал ЧИСЛА по обеим осям всегда: потянул за нижнюю ручку —
       и ширина «fill» молча стала фиксированными пикселями. Внешне ничего
       не менялось, но узел переставал тянуться за родителем — а при
       следующем пересчёте раскладки «неожиданно расширялся». Ось, за
       которую пользователь не тянул, остаётся в своём режиме (hug/fill
       или прежнее число).
       УГЛОВАЯ РУЧКА ТЯНЕТ ОБЕ ОСИ — и обе честно становятся числами:
       пользователь явно задал оба размера, как в Figma. Правило выше
       касается только осей, не участвующих в жесте. */
    const outW: number | "hug" | "fill" = hx !== 0 ? newW : typeof this.startSizeW === "number" ? newW : this.startSizeW;
    const outH: number | "hug" | "fill" = hy !== 0 ? newH : typeof this.startSizeH === "number" ? newH : this.startSizeH;

    if (node.type === "frame") {
      store.patchLayoutLive(node.id, { width: outW, height: outH, x: nx, y: ny });
    } else if (node.layout.position === "absolute" && node.parent) {
      const p = this.hooks.getRects().get(node.parent);
      const px = p ? p.x : 0;
      const py = p ? p.y : 0;
      store.patchLayoutLive(node.id, { width: outW, height: outH, x: nx - px, y: ny - py });
    } else {
      // flow-узел: меняем только размер (в фикс px), позицию определяет раскладка
      store.patchLayoutLive(node.id, { width: outW, height: outH });
    }
    this.hooks.requestRender();
  }

  private startRotate(): void {
    const store = useStore.getState();
    const r = this.hooks.getRects().get(this.dragId!);
    const node = store.doc.nodes[this.dragId!];
    if (!r || !node) {
      this.mode = "idle";
      return;
    }
    this.startRect = { ...r };
    this.startRotationDeg = node.layout.rotation || 0;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const pw = this.toWorld(this.downScreen.x, this.downScreen.y);
    this.startPointerAngle = Math.atan2(pw.y - cy, pw.x - cx);
    store.beginGesture();
    this.mode = "rotate";
    this.el.style.cursor = "grabbing";
  }

  private updateRotate(s: { x: number; y: number }): void {
    const store = useStore.getState();
    if (!this.dragId) return;
    const r = this.startRect;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const pw = this.toWorld(s.x, s.y);
    const ang = Math.atan2(pw.y - cy, pw.x - cx);
    let deg = this.startRotationDeg + rad2deg(ang - this.startPointerAngle);
    if (this.shiftDown) deg = Math.round(deg / 15) * 15; // Shift — шаг 15°
    deg = ((deg % 360) + 360) % 360;
    store.patchLayoutLive(this.dragId, { rotation: Math.round(deg * 10) / 10 });
    this.hooks.requestRender();
  }

  private beginDrag(): void {
    const store = useStore.getState();
    const node = store.doc.nodes[this.dragId!];
    if (!node) {
      this.mode = "idle";
      return;
    }
    const isFree = node.layout.position === "absolute" || node.type === "frame";
    /* Shift: ось выбирается по первому движению (как в PowerPoint) и
       держится весь жест. Стартовая позиция запоминается для фиксации. */
    const rect0 = this.hooks.getRects().get(this.dragId!);
    if (rect0) this.dragStartWorld = { x: rect0.x, y: rect0.y };
    const dxs = this.lastScreen.x - this.downScreen.x;
    const dys = this.lastScreen.y - this.downScreen.y;
    this.axisLock = Math.abs(dxs) >= Math.abs(dys) ? "x" : "y";
    if (isFree) {
      store.beginGesture(); // один снапшот на весь жест
      this.mode = "drag-abs";
    } else {
      this.mode = "drag-flow";
      this.flowDropIndex = -1;
    }
  }

  private updateAbsDrag(s: { x: number; y: number }): void {
    const store = useStore.getState();
    const node = store.doc.nodes[this.dragId!];
    const rects = this.hooks.getRects();
    const rect = rects.get(this.dragId!);
    if (!node || !rect) return;

    const w = this.toWorld(s.x, s.y);
    const target: Rect = { ...rect, x: w.x - this.grabOffset.x, y: w.y - this.grabOffset.y };

    /* Shift — движение по одной оси (как в PowerPoint): вторая ось
       зафиксирована на стартовом значении жеста. */
    if (this.shiftDown && this.axisLock === "x") target.y = this.dragStartWorld.y;
    else if (this.shiftDown && this.axisLock === "y") target.x = this.dragStartWorld.x;

    /* привязка к сетке (Вид → Привязка к сетке): сначала сетка, потом умные направляющие */
    if (useUi.getState().gridSnap) {
      target.x = Math.round(target.x / GRID_SIZE) * GRID_SIZE;
      target.y = Math.round(target.y / GRID_SIZE) * GRID_SIZE;
    }

    /* соседи для снапа: братья по родителю (для фреймов — другие фреймы) */
    const siblingIds =
      node.type === "frame"
        ? store.doc.rootFrames.filter((f) => f !== node.id)
        : (store.doc.nodes[node.parent!]?.children ?? []).filter((c) => c !== node.id);
    const siblingRects = siblingIds
      .map((id) => rects.get(id))
      .filter(Boolean) as Rect[];
    // для absolute-детей добавляем внутреннюю рамку родителя
    if (node.type !== "frame" && node.parent) {
      const p = rects.get(node.parent);
      if (p) siblingRects.push(p);
    }

    const snap = computeSnap(target, siblingRects, this.camera.zoom);
    this.guides = snap.guides;
    this.badges = snap.badges;

    /* При Shift зафиксированная ось не поддаётся и снапу: примагничивание
       вдоль свободной оси остаётся, поперёк — нет. Плюс линия оси через
       холст, чтобы ограничение было видно глазом. */
    if (this.shiftDown && this.axisLock) {
      const span = 100000;
      if (this.axisLock === "x") {
        snap.y = this.dragStartWorld.y;
        this.guides = [
          ...this.guides.filter((g) => g.axis !== "h"),
          { axis: "h", at: this.dragStartWorld.y, from: target.x - span, to: target.x + span },
        ];
      } else {
        snap.x = this.dragStartWorld.x;
        this.guides = [
          ...this.guides.filter((g) => g.axis !== "v"),
          { axis: "v", at: this.dragStartWorld.x, from: target.y - span, to: target.y + span },
        ];
      }
    }

    if (node.type === "frame") {
      store.moveAbsolute(node.id, snap.x, snap.y);
    } else {
      const parentRect = rects.get(node.parent!)!;
      store.moveAbsolute(node.id, snap.x - parentRect.x, snap.y - parentRect.y);
    }
    this.hooks.requestRender();
  }

  private updateFlowDrag(s: { x: number; y: number }): void {
    const store = useStore.getState();
    const node = store.doc.nodes[this.dragId!];
    if (!node?.parent) return;
    const parent = store.doc.nodes[node.parent]!;
    const rects = this.hooks.getRects();
    const parentRect = rects.get(parent.id);
    const nodeRect = rects.get(node.id);
    if (!parentRect || !nodeRect) return;

    const w = this.toWorld(s.x, s.y);
    const horizontal = parent.layout.direction === "row";

    /* призрак под курсором */
    this.dragOutline = {
      x: w.x - this.grabOffset.x,
      y: w.y - this.grabOffset.y,
      w: nodeRect.w,
      h: nodeRect.h,
    };

    /* индекс вставки по середины соседей */
    const flowSiblings = parent.children
      .filter((id) => id !== node.id && store.doc.nodes[id]!.layout.position === "flow")
      .map((id) => ({ id, rect: rects.get(id)! }))
      .filter((x) => x.rect);

    const pointerMain = horizontal ? w.x : w.y;
    let index = flowSiblings.length;
    for (let i = 0; i < flowSiblings.length; i++) {
      const r = flowSiblings[i].rect;
      const mid = horizontal ? r.x + r.w / 2 : r.y + r.h / 2;
      if (pointerMain < mid) {
        index = i;
        break;
      }
    }
    this.flowDropIndex = index;

    /* линия вставки: между соседями или у края паддинга */
    const padSides = padBox(parent.layout.padding);
    let at: number;
    if (flowSiblings.length === 0) {
      at = horizontal ? parentRect.x + padSides.l : parentRect.y + padSides.t;
    } else if (index === 0) {
      const r = flowSiblings[0].rect;
      at = (horizontal ? r.x : r.y) - parent.layout.gap / 2;
    } else if (index >= flowSiblings.length) {
      const r = flowSiblings[flowSiblings.length - 1].rect;
      at = (horizontal ? r.x + r.w : r.y + r.h) + parent.layout.gap / 2;
    } else {
      const prev = flowSiblings[index - 1].rect;
      const next = flowSiblings[index].rect;
      at = horizontal ? (prev.x + prev.w + next.x) / 2 : (prev.y + prev.h + next.y) / 2;
    }
    this.insertion = horizontal
      ? { axis: "v", at, from: parentRect.y + padSides.t, to: parentRect.y + parentRect.h - padSides.b }
      : { axis: "h", at, from: parentRect.x + padSides.l, to: parentRect.x + parentRect.w - padSides.r };

    this.hooks.requestRender();
  }

  private onPointerUp = (): void => {
    if (this.mode === "wire" && this.wireDrag && this.wireTargetId) {
      this.hooks.openWireMenu({
        sourceId: this.wireDrag.fromId,
        targetId: this.wireTargetId,
        screenX: this.el.getBoundingClientRect().left + this.lastScreen.x,
        screenY: this.el.getBoundingClientRect().top + this.lastScreen.y,
      });
    }
    if (this.mode === "wire") {
      this.wireDrag = null;
      this.wireTargetId = null;
    }
    if (this.mode === "marquee") {
      // клик по пустоте без протяжки — привычный сброс выделения
      if (this.marquee === null && this.marqueeMode === "replace") {
        useStore.getState().select([]);
      }
      this.marqueeBase = [];
    }
    if (this.mode === "drag-flow" && this.dragId && this.flowDropIndex >= 0) {
      const store = useStore.getState();
      const node = store.doc.nodes[this.dragId];
      if (node?.parent) {
        const parent = store.doc.nodes[node.parent]!;
        const from = parent.children.indexOf(node.id);
        /* индекс считался без учёта самого узла — переводим в индексы полного массива */
        const flowIds = parent.children.filter(
          (id) => id !== node.id && store.doc.nodes[id]!.layout.position === "flow",
        );
        const anchorId = flowIds[this.flowDropIndex] ?? null;
        const to = anchorId ? parent.children.indexOf(anchorId) : parent.children.length;
        store.reorderChild(parent.id, from, to);
      }
    }
    this.mode = "idle";
    this.dragId = null;
    this.activeHandle = null;
    this.guides = [];
    this.badges = [];
    this.insertion = null;
    this.dragOutline = null;
    this.marquee = null;
    this.flowDropIndex = -1;
    this.axisLock = null;
    this.el.style.cursor = "default";
    this.hooks.requestRender();
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const s = this.screenPoint(e);
    if (e.ctrlKey || e.metaKey) {
      const before = this.toWorld(s.x, s.y);
      const factor = Math.exp(-e.deltaY * 0.0015);
      const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.camera.zoom * factor));
      this.camera.zoom = zoom;
      this.camera.x = before.x - s.x / zoom;
      this.camera.y = before.y - s.y / zoom;
      this.hooks.onZoomChange(zoom);
    } else {
      this.camera.x += e.deltaX / this.camera.zoom;
      this.camera.y += e.deltaY / this.camera.zoom;
    }
    this.hooks.requestRender();
  };

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    if (useStore.getState().eyeMode) return; // в режиме проводов меню добавления не нужно
    const s = this.screenPoint(e);
    const w = this.toWorld(s.x, s.y);
    const store = useStore.getState();
    const targetId = findDeepestAt(store.doc, this.hooks.getRects(), w.x, w.y);
    if (targetId) store.select([targetId]);
    this.hooks.openContextMenu({
      screenX: e.clientX,
      screenY: e.clientY,
      worldX: w.x,
      worldY: w.y,
      targetId,
    });
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target?.isContentEditable;
    if (typing) return;

    const store = useStore.getState();
    const mod = e.ctrlKey || e.metaKey;

    if (e.code === "Space") {
      this.spaceDown = true;
      return;
    }
    if (e.key === "Escape") {
      if (store.eyeMode) {
        store.toggleEye();
        return;
      }
      store.select([]);
      this.hooks.requestRender();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && store.selection.length > 0) {
      e.preventDefault();
      store.removeNodes(store.selection);
      return;
    }
    // ВАЖНО: e.code, а не e.key — иначе шорткаты умирают на русской
    // раскладке (Ctrl+Z там приходит как «я», Ctrl+S — как «ы» и т.д.)
    if (mod && e.code === "KeyZ") {
      e.preventDefault();
      if (e.shiftKey) store.redo();
      else store.undo();
      return;
    }
    if (mod && e.code === "KeyY") {
      e.preventDefault();
      store.redo();
      return;
    }
    if (mod && e.code === "KeyD") {
      e.preventDefault();
      store.duplicateNodes(store.selection);
      return;
    }
    if (mod && e.code === "KeyS") {
      e.preventDefault();
      void store.saveProject();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === "Space") this.spaceDown = false;
  };

  /* ---------------- утилита подписки ---------------- */

  private listen<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    fn: (e: WindowEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void;
  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    fn: (e: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void;
  private listen(
    target: Window | HTMLElement,
    type: string,
    fn: (e: never) => void,
    opts?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, fn as EventListener, opts);
    this.disposers.push(() => target.removeEventListener(type, fn as EventListener, opts));
  }
}

/**
 * Модификатор рамки. Ctrl/Cmd сознательно НЕ занят: с колесом это зум, а на
 * macOS Ctrl+клик — это вторичный клик, который открывает контекстное меню.
 * Остаются Shift (добавить) и Alt (исключить) — та же пара, что в проводнике.
 */
function marqueeModeOf(e: PointerEvent): MarqueeMode {
  if (e.shiftKey) return "add";
  if (e.altKey) return "subtract";
  return "replace";
}

/** Утилита для контекст-меню: может ли узел принимать детей. */
export function canAcceptChildren(id: string | null): boolean {
  if (!id) return false;
  const node = useStore.getState().doc.nodes[id];
  return node ? isContainerLike(node) : false;
}

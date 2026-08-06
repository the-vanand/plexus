/**
 * РЕНДЕРЕР ХОЛСТА (PixiJS / WebGL).
 *
 * Заменяемый слой: потребляет только модель (doc + rects + camera) и не знает
 * про React. Поворот узла реализован обёрткой-контейнером с pivot в центре —
 * дети внутри сохраняют абсолютные мировые координаты, вложенные повороты
 * композируются корректно.
 */
import { Application, Assets, Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import type { Camera, GapBadge, Guide, InsertionLine, Rect, SceneDocument, SceneNode } from "../core/types";
import { computeHandles, deg2rad, rotateAround, HANDLE_KEYS } from "../core/geometry";
import { resolveColor, resolveTheme, type ResolvedTheme } from "../core/themes";
import { iconGlyph } from "../core/codegen";
import { padBox } from "../core/scene";
import { resolveAssetUrl } from "../tauri/api";
import { LINE_HEIGHT_K, measureText } from "./measure";

const COMPONENT_TINT = 0xb28dff; // фиолетовый — мастера и экземпляры компонентов

/* ---------- кеш текстур картинок (общий на приложение) ---------- */
const texCache = new Map<string, Texture | "loading" | "error">();
let invalidate: (() => void) | null = null;

/** PixiCanvas отдаёт колбэк перерисовки — вызывается, когда текстура догрузилась. */
export function setTextureInvalidator(fn: () => void): void {
  invalidate = fn;
}

function requestTexture(src: string): Texture | null {
  const cached = texCache.get(src);
  if (cached instanceof Texture) return cached;
  if (cached === undefined) {
    texCache.set(src, "loading");
    Assets.load<Texture>(src)
      .then((tex) => {
        texCache.set(src, tex);
        invalidate?.();
      })
      .catch(() => texCache.set(src, "error"));
  }
  return null;
}

const ACCENT = 0xa9c9ea;
const BRONZE = 0xaa816a;
const CANVAS_BG = 0x1d2226;
const ROT_HANDLE_SCREEN = 26;

const hex = (color: string): number =>
  color.startsWith("#") ? parseInt(color.slice(1), 16) : 0x000000;

export interface RenderView {
  doc: SceneDocument;
  rects: Map<string, Rect>;
  camera: Camera;
  selection: string[];
  hoverId: string | null;
  guides: Guide[];
  badges: GapBadge[];
  insertion: InsertionLine | null;
  dragOutline: Rect | null;
  /** Сетка точек на холсте (переключается в меню «Вид»). */
  gridShow: boolean;
  /** Режим «глазик»: показать провода связей. */
  eyeMode: boolean;
  /** Тянущийся провод: от порта источника к курсору (мировые координаты). */
  wireDrag: { fromId: string; toX: number; toY: number } | null;
  /** Кандидат-цель под курсором при тяге провода. */
  wireTargetId: string | null;
  screenW: number;
  screenH: number;
}

/** Цвет провода по типу действия. */
const WIRE_COLORS: Record<string, number> = {
  navigate: ACCENT,
  toggle: 0x8fd0a8,
  submit: BRONZE,
};

const WIRE_SHORT_LABELS: Record<string, string> = {
  navigate: "переход",
  toggle: "показать/скрыть",
  submit: "в бэкенд",
};

/** Базовый шаг сетки в мировых единицах (он же — шаг «привязки к сетке»). */
export const GRID_SIZE = 24;

export class CanvasRenderer {
  private readonly grid = new Container();
  private readonly world = new Container();
  private readonly overlay = new Container();
  /** Тема текущего кадра — обновляется в render(). */
  private theme: ResolvedTheme = resolveTheme(undefined);

  constructor(app: Application) {
    app.stage.addChild(this.grid, this.world, this.overlay);
  }

  static backgroundColor = CANVAS_BG;

  render(view: RenderView): void {
    const { camera } = view;
    this.theme = resolveTheme(view.doc.theme);
    this.world.position.set(-camera.x * camera.zoom, -camera.y * camera.zoom);
    this.world.scale.set(camera.zoom);

    this.clear(this.grid);
    this.clear(this.world);
    this.clear(this.overlay);

    if (view.gridShow) this.drawGrid(view);
    for (const frameId of view.doc.rootFrames) {
      this.drawNode(view, frameId, this.world);
    }
    this.drawOverlay(view);
  }

  /** Сетка точек: шаг адаптируется к зуму степенями двойки, рисуем только вьюпорт. */
  private drawGrid(view: RenderView): void {
    const { camera, screenW, screenH } = view;
    const z = camera.zoom;
    let step = GRID_SIZE;
    while (step * z < 24) step *= 2;
    while (step * z > 96) step /= 2;

    const g = new Graphics();
    const startWX = Math.floor(camera.x / step) * step;
    const startWY = Math.floor(camera.y / step) * step;
    for (let wx = startWX; (wx - camera.x) * z <= screenW; wx += step) {
      const sx = (wx - camera.x) * z;
      for (let wy = startWY; (wy - camera.y) * z <= screenH; wy += step) {
        g.circle(sx, (wy - camera.y) * z, 1.2).fill({ color: 0x323a43, alpha: 0.9 });
      }
    }
    this.grid.addChild(g);
  }

  /** Цвет узла с разрешением токенов ($bg/$text/$accent…) через тему. */
  private color(value: string): number {
    return hex(resolveColor(value, this.theme));
  }

  /**
   * Шрифт узла. Порядок ровно тот же, что в решателе (`layout.ts:fontFor`) —
   * иначе экран и раскладка разъедутся. Сначала собственный шрифт узла
   * (пришёл из импорта или инспектора), потом шрифт темы по кеглю.
   */
  private fontFor(node: SceneNode): string {
    if (node.style.fontFamily) return node.style.fontFamily;
    return node.type === "text" && node.style.fontSize >= 24
      ? this.theme.fonts.heading
      : this.theme.fonts.body;
  }

  /**
   * Рисует текстуру в прямоугольник с учётом object-fit.
   * cover — заполнить и обрезать по центру, contain — вписать целиком.
   * Общий код для картинок и для фоновых изображений контейнеров.
   */
  private fitSprite(
    target: Container,
    tex: Texture,
    r: { x: number; y: number; w: number; h: number },
    radius: number,
    fit: "cover" | "contain" | "fill",
  ): void {
    const tw = tex.width || r.w;
    const th = tex.height || r.h;
    const sprite = new Sprite(tex);
    if (fit === "fill") {
      sprite.width = r.w;
      sprite.height = r.h;
      sprite.position.set(r.x, r.y);
    } else {
      const scale = fit === "contain" ? Math.min(r.w / tw, r.h / th) : Math.max(r.w / tw, r.h / th);
      sprite.scale.set(scale);
      sprite.position.set(r.x + (r.w - tw * scale) / 2, r.y + (r.h - th * scale) / 2);
    }
    target.addChild(sprite);
    const mask = new Graphics();
    mask.roundRect(r.x, r.y, r.w, r.h, radius).fill(0xffffff);
    target.addChild(mask);
    sprite.mask = mask;
  }

  private clear(container: Container): void {
    container.removeChildren().forEach((c) => c.destroy({ children: true }));
  }

  private toScreen(view: RenderView, wx: number, wy: number): [number, number] {
    const { camera } = view;
    return [(wx - camera.x) * camera.zoom, (wy - camera.y) * camera.zoom];
  }

  /* ------------------------------------------------------------------ */
  /* Мировой слой: узлы                                                  */
  /* ------------------------------------------------------------------ */

  private drawNode(view: RenderView, id: string, parentTarget: Container, visited?: Set<string>): void {
    const node = view.doc.nodes[id];
    const r = view.rects.get(id);
    if (!node || !r) return;

    // Обёртка поворота вокруг центра узла
    let target = parentTarget;
    const a = deg2rad(node.layout.rotation || 0);
    if (a !== 0) {
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const wrap = new Container();
      wrap.pivot.set(cx, cy);
      wrap.position.set(cx, cy);
      wrap.rotation = a;
      parentTarget.addChild(wrap);
      target = wrap;
    }

    switch (node.type) {
      case "frame": {
        const g = new Graphics();
        g.roundRect(r.x + 4, r.y + 6, r.w, r.h, 2).fill({ color: 0x000000, alpha: 0.35 });
        g.roundRect(r.x, r.y, r.w, r.h, 2).fill(node.style.fill === "transparent" ? 0xffffff : this.color(node.style.fill));
        target.addChild(g);
        break;
      }
      case "container": {
        const hasFill = node.style.fill !== "transparent";
        const bw = node.style.borderWidth ?? 0;
        // фоновая картинка секции: реальные сайты несут hero-фото именно так
        if (node.style.backgroundImage) {
          const bgTex = requestTexture(resolveAssetUrl(node.style.backgroundImage));
          if (bgTex) {
            this.fitSprite(target, bgTex, r, node.style.radius, node.style.backgroundSize === "contain" ? "contain" : "cover");
          }
        }
        if (hasFill || bw > 0) {
          const g = new Graphics();
          g.roundRect(r.x, r.y, r.w, r.h, node.style.radius);
          // альфа заливки (rgba) множится на общую прозрачность узла
          if (hasFill) g.fill({ color: this.color(node.style.fill), alpha: (node.style.opacity ?? 1) * (node.style.fillAlpha ?? 1) });
          // рамка целиком или только верхняя линия (разделители секций)
          if (bw > 0 && !node.style.borderTop && !node.style.borderBottom && !node.style.borderLeft) {
            g.stroke({ width: bw, color: this.color(node.style.borderColor ?? node.style.textColor) });
          }
          target.addChild(g);
          // односторонняя рамка: разделители секций, подчёркивания полей,
          // вертикальные линии между колонками карточек
          const side = node.style.borderTop ? "top" : node.style.borderBottom ? "bottom" : node.style.borderLeft ? "left" : null;
          if (bw > 0 && side) {
            const line = new Graphics();
            const [x1, y1, x2, y2] =
              side === "top" ? [r.x, r.y, r.x + r.w, r.y]
              : side === "bottom" ? [r.x, r.y + r.h, r.x + r.w, r.y + r.h]
              : [r.x, r.y, r.x, r.y + r.h];
            line
              .moveTo(x1, y1)
              .lineTo(x2, y2)
              .stroke({ width: bw, color: this.color(node.style.borderColor ?? node.style.textColor), alpha: 0.5 });
            target.addChild(line);
          }
        }
        break;
      }
      /* ---------- элементы каталога типов ---------- */
      case "divider": {
        const g = new Graphics();
        const bw = Math.max(1, node.style.borderWidth ?? 1);
        g.moveTo(r.x, r.y + r.h / 2).lineTo(r.x + r.w, r.y + r.h / 2)
          .stroke({ width: bw, color: this.color(node.style.borderColor ?? "$line") });
        target.addChild(g);
        break;
      }
      case "spacer": {
        // распорка невидима на сайте, но на холсте её нужно видеть и хватать
        const g = new Graphics();
        g.rect(r.x, r.y, r.w, r.h).fill({ color: ACCENT, alpha: 0.05 });
        for (let x = r.x; x < r.x + r.w; x += 8) {
          g.moveTo(x, r.y + r.h).lineTo(x + 4, r.y).stroke({ width: 0.6, color: ACCENT, alpha: 0.18 });
        }
        target.addChild(g);
        break;
      }
      case "list": {
        const items = node.items ?? [];
        const size = node.style.fontSize;
        const indent = Math.round(size * 1.4);
        let cy = r.y;
        items.forEach((item, i) => {
          const marker = new Text({
            text: node.ordered ? `${i + 1}.` : "•",
            style: {
              fontFamily: this.fontFor(node),
              fontSize: size,
              fill: this.color(node.style.textColor),
            },
          });
          marker.position.set(r.x, cy);
          target.addChild(marker);
          const line = new Text({
            text: item,
            style: {
              fontFamily: this.fontFor(node),
              fontSize: size,
              fill: this.color(node.style.textColor),
              lineHeight: size * (node.style.lineHeight ?? LINE_HEIGHT_K),
              wordWrap: true,
              wordWrapWidth: Math.max(24, r.w - indent),
            },
          });
          line.position.set(r.x + indent, cy);
          target.addChild(line);
          cy += line.height + 6;
        });
        break;
      }
      case "quote": {
        const bw = node.style.borderWidth ?? 2;
        const bar = new Graphics();
        bar.rect(r.x, r.y, bw, r.h).fill(this.color(node.style.borderColor ?? "$accent"));
        target.addChild(bar);
        const pad = padBox(node.layout.padding);
        const body = this.makeText(node, r.x + pad.l, r.y + pad.t, view.camera.zoom, Math.max(24, r.w - pad.l - pad.r));
        target.addChild(body);
        if (node.cite) {
          const author = new Text({
            text: `— ${node.cite}`,
            style: {
              fontFamily: this.fontFor(node),
              fontSize: Math.round(node.style.fontSize * 0.7),
              fill: this.color("$muted"),
            },
          });
          author.position.set(r.x + pad.l, r.y + pad.t + body.height + 8);
          target.addChild(author);
        }
        break;
      }
      case "icon": {
        const glyph = new Text({
          text: iconGlyph(node.iconName),
          style: {
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: Math.round(Math.min(r.w, r.h) * 0.8),
            fill: this.color(node.style.textColor),
          },
        });
        glyph.anchor.set(0.5);
        glyph.position.set(r.x + r.w / 2, r.y + r.h / 2);
        target.addChild(glyph);
        break;
      }
      case "video":
      case "embed": {
        const g = new Graphics();
        g.roundRect(r.x, r.y, r.w, r.h, node.style.radius)
          .fill({ color: this.color(node.style.fill === "transparent" ? "$surface" : node.style.fill) })
          .stroke({ width: 1, color: this.color("$line"), alpha: 0.6 });
        target.addChild(g);
        if (node.type === "video") {
          // треугольник play по центру — узнаваемо без иконочных шрифтов
          const cx = r.x + r.w / 2;
          const cy = r.y + r.h / 2;
          const sz = Math.min(r.w, r.h) * 0.16;
          const play = new Graphics();
          play.circle(cx, cy, sz * 1.5).fill({ color: 0xffffff, alpha: 0.14 });
          play.moveTo(cx - sz * 0.5, cy - sz).lineTo(cx + sz * 0.8, cy).lineTo(cx - sz * 0.5, cy + sz)
            .closePath().fill({ color: 0xffffff, alpha: 0.85 });
          target.addChild(play);
        }
        const label = this.smartText(
          node.type === "video" ? (node.src ? "Видео" : "Видео — укажи ссылку") : "Встраивание",
          11, 500, "$muted", view.camera.zoom,
        );
        label.position.set(r.x + 10, r.y + 8);
        target.addChild(label);
        break;
      }

      case "instance": {
        // экземпляр рисует поддерево мастера со смещением в свою позицию
        const comp = view.doc.components[node.componentRef ?? ""];
        const masterRect = comp ? view.rects.get(comp.rootId) : undefined;
        const seen = visited ?? new Set<string>();
        if (comp && masterRect && !seen.has(node.componentRef!)) {
          seen.add(node.componentRef!);
          const wrap = new Container();
          wrap.position.set(r.x - masterRect.x, r.y - masterRect.y);
          target.addChild(wrap);
          this.drawNode(view, comp.rootId, wrap, seen);
          seen.delete(node.componentRef!);
        } else {
          const g = new Graphics();
          g.roundRect(r.x, r.y, r.w, r.h, 6)
            .fill({ color: COMPONENT_TINT, alpha: 0.1 })
            .stroke({ width: 1.5, color: COMPONENT_TINT });
          target.addChild(g);
        }
        break;
      }
      case "text": {
        /* ПЕРЕНОС НА ЭКРАНЕ — ТОТ ЖЕ, ЧТО В РЕШАТЕЛЕ. Решатель у надписи с
           `noWrap` меряет высоту БЕЗ переноса (см. `wrapHeight`), а экран
           переносил её по ширине коробки: одна и та же надпись выходила
           одной строкой в раскладке и двумя на экране, вторая строка лезла
           на соседа. Паритет обязателен, иначе холст врёт про модель. */
        const t = this.makeText(
          node, 0, 0, view.camera.zoom,
          node.layout.noWrap ? undefined : r.w,
          node.layout.ellipsis ? r.w : undefined,
        );
        // выравнивание внутри своего бокса (когда ширина больше текста)
        const align = node.style.textAlign ?? "left";
        if (align === "center") {
          t.anchor.set(0.5, 0);
          t.position.set(r.x + r.w / 2, r.y);
        } else if (align === "right") {
          t.anchor.set(1, 0);
          t.position.set(r.x + r.w, r.y);
        } else {
          t.position.set(r.x, r.y);
        }
        target.addChild(t);
        // зачёркивание и подчёркивание ссылки — линии поверх текста
        if (node.style.strike || node.href) {
          const startX = align === "center" ? r.x + r.w / 2 - t.width / 2 : align === "right" ? r.x + r.w - t.width : r.x;
          const g = new Graphics();
          const color = this.color(node.style.textColor);
          if (node.style.strike) {
            const y = r.y + t.height * 0.55;
            g.moveTo(startX, y).lineTo(startX + t.width, y).stroke({ width: Math.max(1.5, node.style.fontSize / 12), color });
          }
          if (node.href) {
            const y = r.y + t.height * 0.95;
            g.moveTo(startX, y).lineTo(startX + t.width, y).stroke({ width: 1, color, alpha: 0.7 });
          }
          target.addChild(g);
        }
        break;
      }
      case "button": {
        const g = new Graphics();
        g.roundRect(r.x, r.y, r.w, r.h, node.style.radius).fill(this.color(node.style.fill));
        target.addChild(g);
        // подпись переносится внутри кнопки — не выползает на соседей
        const label = this.makeText(node, 0, 0, view.camera.zoom, Math.max(24, r.w - 16));
        label.anchor.set(0.5);
        label.position.set(r.x + r.w / 2, r.y + r.h / 2);
        target.addChild(label);
        break;
      }
      case "image": {
        const tex = node.src ? requestTexture(resolveAssetUrl(node.src)) : null;
        if (tex) {
          this.fitSprite(target, tex, r, node.style.radius, node.style.objectFit ?? "cover");
        } else {
          const g = new Graphics();
          g.roundRect(r.x, r.y, r.w, r.h, node.style.radius).fill(0xdfe4e9);
          const cx = r.x + r.w / 2;
          const cy = r.y + r.h / 2;
          const s = Math.min(r.w, r.h) * 0.22;
          g.moveTo(cx - s * 1.4, cy + s).lineTo(cx - s * 0.3, cy - s * 0.4).lineTo(cx + s * 0.5, cy + s).closePath().fill(0xb9c2cb);
          g.circle(cx + s * 0.9, cy - s * 0.9, s * 0.32).fill(0xb9c2cb);
          target.addChild(g);
        }
        break;
      }
      case "input": {
        const g = new Graphics();
        g.roundRect(r.x, r.y, r.w, r.h, node.style.radius).fill(this.color(node.style.fill)).stroke({ width: 1, color: 0xc6ccd2 });
        target.addChild(g);
        const placeholder = this.makeText(node, 0, 0, view.camera.zoom);
        placeholder.anchor.set(0, 0.5);
        placeholder.position.set(r.x + 12, r.y + r.h / 2);
        target.addChild(placeholder);
        break;
      }
      case "autonav": {
        // умный элемент: сам знает страницы сайта
        const g = new Graphics();
        g.rect(r.x, r.y, r.w, r.h).fill({ color: this.color("$surface"), alpha: 0.6 });
        g.moveTo(r.x, r.y + r.h).lineTo(r.x + r.w, r.y + r.h).stroke({ width: 1, color: this.color("$muted"), alpha: 0.35 });
        target.addChild(g);
        let tx = r.x + 24;
        for (const frameId of view.doc.rootFrames) {
          const t = this.smartText(view.doc.nodes[frameId]?.name ?? "", 15, 500, "$text", view.camera.zoom);
          t.position.set(tx, r.y + r.h / 2);
          t.anchor.set(0, 0.5);
          target.addChild(t);
          tx += t.width + 28;
        }
        break;
      }
      case "autofooter": {
        const g = new Graphics();
        g.rect(r.x, r.y, r.w, r.h).fill({ color: this.color("$surface"), alpha: 0.8 });
        target.addChild(g);
        let tx = r.x + 24;
        for (const frameId of view.doc.rootFrames) {
          const t = this.smartText(view.doc.nodes[frameId]?.name ?? "", 13, 400, "$muted", view.camera.zoom);
          t.position.set(tx, r.y + 26);
          t.anchor.set(0, 0.5);
          target.addChild(t);
          tx += t.width + 22;
        }
        const cop = this.smartText(`© ${new Date().getFullYear()} — авто-подвал`, 12, 400, "$muted", view.camera.zoom);
        cop.position.set(r.x + 24, r.y + r.h - 22);
        cop.anchor.set(0, 0.5);
        target.addChild(cop);
        break;
      }
      case "breadcrumbs": {
        const pageName = (() => {
          let cur = node.parent;
          while (cur && view.doc.nodes[cur]?.type !== "frame") cur = view.doc.nodes[cur]?.parent ?? null;
          return cur ? view.doc.nodes[cur]!.name : "Страница";
        })();
        const t = this.smartText(`Главная / ${pageName}`, 13, 400, "$muted", view.camera.zoom);
        t.position.set(r.x, r.y);
        target.addChild(t);
        break;
      }
      case "cmslist": {
        const table = view.doc.dbTables[node.tableRef ?? ""];
        const rows = 3;
        const rowH = (r.h - 24) / rows;
        for (let i = 0; i < rows; i++) {
          const ry = r.y + 12 + i * rowH;
          const g = new Graphics();
          g.roundRect(r.x, ry, r.w, rowH - 10, 8)
            .fill({ color: this.color("$surface"), alpha: 0.9 })
            .stroke({ width: 1, color: this.color("$muted"), alpha: 0.25 });
          target.addChild(g);
          const title = this.smartText(
            table ? `${table.name} · запись ${i + 1}` : "Выбери таблицу в инспекторе",
            13, 600, "$text", view.camera.zoom,
          );
          title.position.set(r.x + 14, ry + 14);
          target.addChild(title);
          if (table) {
            table.fields.slice(0, 4).forEach((f, fi) => {
              const line = this.smartText(`${f.name}: …`, 12, 400, "$muted", view.camera.zoom);
              line.position.set(r.x + 14, ry + 34 + fi * 18);
              target.addChild(line);
            });
          }
        }
        break;
      }
    }

    for (const childId of node.children) this.drawNode(view, childId, target);
  }

  /** Текст умных элементов: цвет-токен + шрифт темы. */
  private smartText(text: string, size: number, weight: number, colorToken: string, zoom: number): Text {
    const t = new Text({
      text,
      style: {
        fontFamily: this.theme.fonts.body,
        fontSize: size,
        fontWeight: `${weight}` as "400" | "500" | "600" | "700",
        fill: this.color(colorToken),
      },
    });
    t.resolution = Math.min(3, Math.max(1, (window.devicePixelRatio || 1) * zoom));
    return t;
  }

  /**
   * ХВОСТ, ЗАМЕНЁННЫЙ МНОГОТОЧИЕМ (`text-overflow: ellipsis`).
   *
   * На странице браузер показал ровно то, что влезло в коробку, и оборвал
   * остаток многоточием. Холст обязан показать то же: иначе надпись
   * выезжает за свою коробку и наезжает на соседа — в таблице файлов
   * GitHub сообщение коммита шириной 474px лезло в колонку с датой,
   * отведённую под 389px.
   *
   * Текст узла НЕ МЕНЯЕТСЯ: усечение — свойство показа, а не содержимого,
   * и в инспекторе, и в экспорте строка остаётся полной (в CSS её режет та
   * же тройка свойств, что и в оригинале).
   *
   * Отрезается по измерителю тем же движком, каким рисует Pixi, поэтому
   * граница совпадает с настоящей.
   */
  private ellipsize(node: SceneNode, width: number): string {
    const full = node.text ?? "";
    const w = (s: string): number =>
      measureText(s, node.style.fontSize, node.style.fontWeight, this.fontFor(node), undefined, {
        letterSpacing: node.style.letterSpacing,
        lineHeight: node.style.lineHeight,
        uppercase: node.style.uppercase,
      }).w;
    if (!full || w(full) <= width) return full;
    let lo = 0;
    let hi = full.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (w(`${full.slice(0, mid)}…`) <= width) lo = mid;
      else hi = mid - 1;
    }
    return lo <= 0 ? "…" : `${full.slice(0, lo)}…`;
  }

  private makeText(node: SceneNode, x: number, y: number, zoom: number, wrapWidth?: number, clipWidth?: number): Text {
    const raw = clipWidth === undefined ? (node.text ?? "") : this.ellipsize(node, clipWidth);
    const t = new Text({
      text: node.style.uppercase ? raw.toUpperCase() : raw,
      style: {
        fontFamily: this.fontFor(node),
        fontSize: node.style.fontSize,
        fontWeight: `${node.style.fontWeight}` as "400" | "500" | "600" | "700",
        fontStyle: node.style.italic ? "italic" : "normal",
        fill: this.color(node.style.textColor),
        // все метрические свойства синхронны с measure.ts (паритет раскладки)
        lineHeight: node.style.fontSize * (node.style.lineHeight ?? LINE_HEIGHT_K),
        letterSpacing: node.style.letterSpacing ?? 0,
        ...(wrapWidth ? { wordWrap: true, wordWrapWidth: Math.max(24, wrapWidth), breakWords: false } : {}),
        ...(node.style.textAlign && node.style.textAlign !== "left" ? { align: node.style.textAlign } : {}),
      },
    });
    t.resolution = Math.min(3, Math.max(1, (window.devicePixelRatio || 1) * zoom));
    t.alpha = node.style.opacity ?? 1;
    t.position.set(x, y);
    return t;
  }

  /* ------------------------------------------------------------------ */
  /* Оверлей (экранные координаты)                                       */
  /* ------------------------------------------------------------------ */

  private drawOverlay(view: RenderView): void {
    const z = view.camera.zoom;

    // подписи фреймов
    for (const frameId of view.doc.rootFrames) {
      const frame = view.doc.nodes[frameId];
      const r = view.rects.get(frameId);
      if (!frame || !r) continue;
      const [sx, sy] = this.toScreen(view, r.x, r.y);
      const label = new Text({
        text: frame.name,
        style: { fontFamily: "Inter, system-ui, sans-serif", fontSize: 12, fill: 0x8b96a0 },
      });
      label.resolution = window.devicePixelRatio || 1;
      label.position.set(sx, sy - 20);
      this.overlay.addChild(label);
    }

    // бейджи мастеров компонентов (фиолетовая обводка + имя)
    for (const comp of Object.values(view.doc.components)) {
      const r = view.rects.get(comp.rootId);
      if (!r) continue;
      const [sx, sy] = this.toScreen(view, r.x, r.y);
      const g = new Graphics();
      g.rect(sx, sy, r.w * z, r.h * z).stroke({ width: 1.5, color: COMPONENT_TINT, alpha: 0.85 });
      this.overlay.addChild(g);
      const label = new Text({
        text: `⟐ ${comp.name}`,
        style: { fontFamily: "Inter, system-ui, sans-serif", fontSize: 11, fontWeight: "600", fill: COMPONENT_TINT },
      });
      label.resolution = window.devicePixelRatio || 1;
      label.position.set(sx, sy - 16);
      this.overlay.addChild(label);
    }

    // бейдж «sticky» (закреплённая шапка)
    for (const [id, r] of view.rects) {
      const node = view.doc.nodes[id];
      if (!node?.sticky) continue;
      const [sx, sy] = this.toScreen(view, r.x + r.w, r.y);
      const t = new Text({
        text: "📌 sticky",
        style: { fontFamily: "Inter, system-ui, sans-serif", fontSize: 11, fontWeight: "600", fill: 0x0d1114 },
      });
      t.resolution = window.devicePixelRatio || 1;
      t.anchor.set(1, 0);
      const bg = new Graphics();
      bg.roundRect(sx - t.width - 12, sy + 2, t.width + 12, t.height + 4, 5).fill(BRONZE);
      t.position.set(sx - 6, sy + 4);
      this.overlay.addChild(bg, t);
    }

    // режим «глазик»: затемнение + провода + порты, обычные украшения не рисуем
    if (view.eyeMode) {
      this.drawEyeLayer(view);
      return;
    }

    // ховер (учёт собственного поворота)
    if (view.hoverId && !view.selection.includes(view.hoverId)) {
      const r = view.rects.get(view.hoverId);
      const node = view.doc.nodes[view.hoverId];
      if (r && node) {
        const a = deg2rad(node.layout.rotation || 0);
        this.strokeRotatedRect(view, r, a, ACCENT, 1.5, 0.6);
      }
    }

    // выделение + рабочие ручки
    if (view.selection.length === 1) {
      const id = view.selection[0];
      const r = view.rects.get(id);
      const node = view.doc.nodes[id];
      if (r && node) {
        const a = deg2rad(node.layout.rotation || 0);
        this.strokeRotatedRect(view, r, a, ACCENT, 2, 1);

        const H = computeHandles(r, a, ROT_HANDLE_SCREEN / z);
        const g = new Graphics();

        // линия к ручке поворота
        const [nx, ny] = this.toScreen(view, H.points.n.x, H.points.n.y);
        const [rx, ry] = this.toScreen(view, H.rotate.x, H.rotate.y);
        g.moveTo(nx, ny).lineTo(rx, ry).stroke({ width: 1.5, color: ACCENT });
        g.circle(rx, ry, 6).fill(0xffffff).stroke({ width: 1.5, color: ACCENT });

        // 8 квадратиков ресайза
        const HS = 9;
        for (const key of HANDLE_KEYS) {
          const [hx, hy] = this.toScreen(view, H.points[key].x, H.points[key].y);
          g.rect(hx - HS / 2, hy - HS / 2, HS, HS).fill(0xffffff).stroke({ width: 1.5, color: ACCENT });
        }
        this.overlay.addChild(g);
      }
    } else {
      for (const id of view.selection) {
        const r = view.rects.get(id);
        const node = view.doc.nodes[id];
        if (r && node) this.strokeRotatedRect(view, r, deg2rad(node.layout.rotation || 0), ACCENT, 2, 1);
      }
    }

    // направляющие (бронза)
    if (view.guides.length > 0) {
      const g = new Graphics();
      for (const guide of view.guides) {
        if (guide.axis === "v") {
          const [sx] = this.toScreen(view, guide.at, 0);
          const [, sy1] = this.toScreen(view, 0, guide.from);
          const [, sy2] = this.toScreen(view, 0, guide.to);
          g.moveTo(sx, sy1).lineTo(sx, sy2).stroke({ width: 1, color: BRONZE });
        } else {
          const [, sy] = this.toScreen(view, 0, guide.at);
          const [sx1] = this.toScreen(view, guide.from, 0);
          const [sx2] = this.toScreen(view, guide.to, 0);
          g.moveTo(sx1, sy).lineTo(sx2, sy).stroke({ width: 1, color: BRONZE });
        }
      }
      this.overlay.addChild(g);
    }

    // бейджи расстояний
    for (const badge of view.badges) {
      const [sx, sy] = this.toScreen(view, badge.x, badge.y);
      const t = new Text({
        text: badge.label,
        style: { fontFamily: "Inter, system-ui, sans-serif", fontSize: 11, fontWeight: "600", fill: 0xffffff },
      });
      t.resolution = window.devicePixelRatio || 1;
      t.anchor.set(0.5);
      const bg = new Graphics();
      bg.roundRect(sx - t.width / 2 - 5, sy - t.height / 2 - 2, t.width + 10, t.height + 4, 4).fill(BRONZE);
      t.position.set(sx, sy);
      this.overlay.addChild(bg, t);
    }

    // индикатор вставки (flow)
    if (view.insertion) {
      const ins = view.insertion;
      const g = new Graphics();
      if (ins.axis === "v") {
        const [sx] = this.toScreen(view, ins.at, 0);
        const [, sy1] = this.toScreen(view, 0, ins.from);
        const [, sy2] = this.toScreen(view, 0, ins.to);
        g.moveTo(sx, sy1).lineTo(sx, sy2).stroke({ width: 3, color: ACCENT });
      } else {
        const [, sy] = this.toScreen(view, 0, ins.at);
        const [sx1] = this.toScreen(view, ins.from, 0);
        const [sx2] = this.toScreen(view, ins.to, 0);
        g.moveTo(sx1, sy).lineTo(sx2, sy).stroke({ width: 3, color: ACCENT });
      }
      this.overlay.addChild(g);
    }

    // призрак перетаскивания flow-узла
    if (view.dragOutline) {
      const r = view.dragOutline;
      const [sx, sy] = this.toScreen(view, r.x, r.y);
      const g = new Graphics();
      g.rect(sx, sy, r.w * z, r.h * z).fill({ color: ACCENT, alpha: 0.08 }).stroke({ width: 1.5, color: ACCENT, alpha: 0.9 });
      this.overlay.addChild(g);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Режим «глазик»: провода связей                                       */
  /* ------------------------------------------------------------------ */

  private drawEyeLayer(view: RenderView): void {
    // затемняем сцену, чтобы провода читались
    const dim = new Graphics();
    dim.rect(0, 0, view.screenW, view.screenH).fill({ color: CANVAS_BG, alpha: 0.55 });
    this.overlay.addChild(dim);

    // существующие провода
    for (const wire of view.doc.wires) {
      const sr = view.rects.get(wire.sourceId);
      const tr = view.rects.get(wire.targetId);
      if (!sr || !tr) continue;
      this.drawWire(
        view,
        { x: sr.x + sr.w, y: sr.y + sr.h / 2 },
        { x: tr.x, y: tr.y + tr.h / 2 },
        WIRE_COLORS[wire.action] ?? ACCENT,
        WIRE_SHORT_LABELS[wire.action] ?? wire.action,
      );
    }

    // порты: голубой выход справа (у элементов), бронзовый вход слева (у всех)
    const g = new Graphics();
    for (const [id, r] of view.rects) {
      const node = view.doc.nodes[id];
      if (!node) continue;
      const [ox, oy] = this.toScreen(view, r.x + r.w, r.y + r.h / 2);
      const [ix, iy] = this.toScreen(view, r.x, r.y + r.h / 2);
      if (node.type !== "frame") {
        g.circle(ox, oy, 5).fill(ACCENT).stroke({ width: 1.5, color: 0x16324b });
      }
      const isTarget = view.wireTargetId === id;
      g.circle(ix, iy, isTarget ? 7 : 4).fill(isTarget ? 0xffffff : BRONZE);
    }
    this.overlay.addChild(g);

    // подсветка кандидата-цели
    if (view.wireTargetId) {
      const r = view.rects.get(view.wireTargetId);
      if (r) {
        const [sx, sy] = this.toScreen(view, r.x, r.y);
        const hl = new Graphics();
        hl.rect(sx, sy, r.w * view.camera.zoom, r.h * view.camera.zoom)
          .stroke({ width: 2, color: 0xffffff, alpha: 0.9 });
        this.overlay.addChild(hl);
      }
    }

    // тянущийся провод к курсору
    if (view.wireDrag) {
      const sr = view.rects.get(view.wireDrag.fromId);
      if (sr) {
        this.drawWire(
          view,
          { x: sr.x + sr.w, y: sr.y + sr.h / 2 },
          { x: view.wireDrag.toX, y: view.wireDrag.toY },
          ACCENT,
          null,
        );
      }
    }
  }

  /** Провод: кубическая кривая с горизонтальными «усами» + бейдж действия. */
  private drawWire(
    view: RenderView,
    a: { x: number; y: number },
    b: { x: number; y: number },
    color: number,
    label: string | null,
  ): void {
    const [ax, ay] = this.toScreen(view, a.x, a.y);
    const [bx, by] = this.toScreen(view, b.x, b.y);
    const dx = Math.max(40, Math.abs(bx - ax) / 2);
    const g = new Graphics();
    g.moveTo(ax, ay)
      .bezierCurveTo(ax + dx, ay, bx - dx, by, bx, by)
      .stroke({ width: 2.5, color, alpha: 0.95 });
    g.circle(ax, ay, 4).fill(color);
    g.circle(bx, by, 4).fill(color);
    this.overlay.addChild(g);

    if (label) {
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const t = new Text({
        text: label,
        style: { fontFamily: "Inter, system-ui, sans-serif", fontSize: 11, fontWeight: "600", fill: 0x0d1114 },
      });
      t.resolution = window.devicePixelRatio || 1;
      t.anchor.set(0.5);
      const bg = new Graphics();
      bg.roundRect(mx - t.width / 2 - 6, my - t.height / 2 - 3, t.width + 12, t.height + 6, 5).fill(color);
      t.position.set(mx, my);
      this.overlay.addChild(bg, t);
    }
  }

  /** Обводка прямоугольника с учётом поворота вокруг центра (в экранных координатах). */
  private strokeRotatedRect(view: RenderView, r: Rect, a: number, color: number, width: number, alpha: number): void {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const corners = [
      rotateAround(r.x, r.y, cx, cy, a),
      rotateAround(r.x + r.w, r.y, cx, cy, a),
      rotateAround(r.x + r.w, r.y + r.h, cx, cy, a),
      rotateAround(r.x, r.y + r.h, cx, cy, a),
    ].map((p) => this.toScreen(view, p.x, p.y));
    const g = new Graphics();
    g.moveTo(corners[0][0], corners[0][1]);
    for (let i = 1; i < corners.length; i++) g.lineTo(corners[i][0], corners[i][1]);
    g.closePath().stroke({ width, color, alpha });
    this.overlay.addChild(g);
  }
}

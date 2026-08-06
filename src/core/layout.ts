/**
 * РЕШАТЕЛЬ AUTO-LAYOUT (v3).
 *
 * Семантика Figma auto-layout / flexbox / grid: direction, gap, padding по
 * сторонам, width/height: px | "hug" | "fill", maxWidth, justify/align,
 * grid-дорожки, absolute как escape hatch.
 *
 * v2 сделал раскладку width-aware (текст переносится по словам).
 * v3 закрывает три дыры, из-за которых импорт реального сайта разъезжался:
 *
 *  1. PADDING ПО СТОРОНАМ. Раньше отступ был одним числом, и `padding: 90px 4vw`
 *     превращался в 90 со всех сторон — вертикальный ритм и боковые поля врали.
 *  2. GRID. `display:grid` схлопывался в одну строку: форма из восьми полей
 *     вставала в ряд, три карточки коллекций — тоже. Теперь дорожки честные,
 *     дети переносятся по рядам, ряд тянется по самому высокому.
 *  3. MAX-WIDTH. Колонка страницы (`max-width:1200px; margin:0 auto`) не
 *     существовала в модели, поэтому строки текста шли во всю ширину экрана
 *     и перенос не совпадал с оригиналом.
 */
import type { GridTrack, MeasureFn, Rect, SceneDocument, SceneNode, SizeMode, Sides } from "./types";
import { breakpointForWidth, isContainerLike, padBox, resolveDocAt } from "./scene";
import { resolveTheme } from "./themes";

const BUTTON_PAD_X = 20;
const BUTTON_PAD_Y = 10;
const MIN_FILL = 24;
/** Пропорции картинки по умолчанию, когда собственные неизвестны. */
const DEFAULT_IMAGE_RATIO = 1.5;
const ZERO_SIDES = { t: 0, r: 0, b: 0, l: 0 } as const;

/**
 * Опции расчёта под конкретную ширину экрана. Оба поля необязательны, и это
 * принципиально: вызов `computeLayout(doc, measure)` — базовое состояние
 * страницы, как и до появления брейкпоинтов.
 */
export interface LayoutOptions {
  /**
   * Ширина вьюпорта. Корневые фреймы считаются по ней вместо собственной
   * ширины — так холст показывает страницу «как на телефоне».
   */
  width?: number;
  /**
   * Брейкпоинт, чьи переопределения применять. Если не задан, а задана
   * width — берётся тот, что действует при этой ширине (как в CSS).
   */
  breakpointId?: string | null;
}

export function computeLayout(
  doc: SceneDocument,
  measure: MeasureFn,
  options?: LayoutOptions,
): Map<string, Rect> {
  const rects = new Map<string, Rect>();

  /* РАЗРЕШЕНИЕ БРЕЙКПОИНТА — единственное место, где решатель знает про
     адаптивность. Дальше работаем с обычным документом: узлы уже несут
     итоговые layout/style, скрытые из дерева выброшены. */
  const activeBp =
    options?.breakpointId !== undefined
      ? options.breakpointId
      : options?.width !== undefined
        ? (breakpointForWidth(doc.breakpoints, options.width)?.id ?? null)
        : null;
  doc = resolveDocAt(doc, activeBp);
  const forcedW = options?.width;

  const theme = resolveTheme(doc.theme);

  /**
   * Шрифт узла. Сначала — СВОЙ шрифт (пришедший из импорта или инспектора),
   * и только потом шрифт темы по эвристике кегля. Пока поля не было, весь
   * импортированный текст мерился чужим шрифтом — отсюда «текст съезжает».
   */
  const fontFor = (node: SceneNode): string =>
    node.style.fontFamily ??
    (node.type === "text" && node.style.fontSize >= 24 ? theme.fonts.heading : theme.fonts.body);

  /* ---------- текст: измерение ДВИЖКОМ РЕНДЕРА (полный паритет) ---------- */
  /** Все типографские свойства, влияющие на метрику. */
  const textExtra = (node: SceneNode) => ({
    letterSpacing: node.style.letterSpacing,
    lineHeight: node.style.lineHeight,
    uppercase: node.style.uppercase,
  });

  const wrapHeight = (node: SceneNode, maxW: number): number =>
    measure(
      node.text ?? "",
      node.style.fontSize,
      node.style.fontWeight,
      fontFor(node),
      /* `noWrap` — это `white-space: nowrap`: переноса нет, и ширина
         обёртки на высоту не влияет вовсе (см. LayoutProps.noWrap). */
      node.layout.noWrap ? undefined : Math.max(24, maxW - (node.layout.wrapInset ?? 0)),
      textExtra(node),
    ).h;

  const textNaturalW = (node: SceneNode): number =>
    measure(node.text ?? "", node.style.fontSize, node.style.fontWeight, fontFor(node), undefined, textExtra(node)).w + 2;

  /** Внешние отступы узла (в модели их не было — вертикальный ритм терялся). */
  const marginOf = (node: SceneNode) => node.layout.margin ?? ZERO_SIDES;

  /** Ширина картинки по пропорциям, если известна высота. */
  const imageRatio = (node: SceneNode): number => node.aspectRatio ?? DEFAULT_IMAGE_RATIO;

  /* ---------- интринсик-ШИРИНА (для hug и строк) ---------- */
  const wCache = new Map<string, number>();
  const intrinsicW = (node: SceneNode): number => {
    const cached = wCache.get(node.id);
    if (cached !== undefined) return cached;
    let w: number;
    switch (node.type) {
      case "text": {
        const tp = padBox(node.layout.padding);
        w = textNaturalW(node) + tp.l + tp.r;
        break;
      }
      case "button":
        w = measure(node.text ?? "", node.style.fontSize, node.style.fontWeight, fontFor(node), undefined, textExtra(node)).w + BUTTON_PAD_X * 2;
        break;
      case "image":
        w = typeof node.layout.height === "number" ? node.layout.height * imageRatio(node) : 240;
        break;
      case "input":
        w = 240;
        break;
      case "instance": {
        const comp = doc.components[node.componentRef ?? ""];
        const master = comp ? doc.nodes[comp.rootId] : undefined;
        w = master ? intrinsicW(master) : 120;
        break;
      }
      case "autonav":
      case "autofooter": {
        const labels = doc.rootFrames.map((f) => doc.nodes[f]?.name ?? "").join("      ");
        w = measure(labels || "Навигация", 15, 500, theme.fonts.body).w + 48;
        break;
      }
      case "breadcrumbs":
        w = measure("Главная / Страница", 13, 400, theme.fonts.body).w + 8;
        break;
      case "cmslist":
        w = 320;
        break;
      case "icon":
        w = typeof node.layout.width === "number" ? node.layout.width : 40;
        break;
      case "divider":
      case "spacer":
      case "video":
      case "embed":
        w = 320;
        break;
      case "list": {
        const items = node.items ?? [];
        const widest = items.reduce(
          (acc, item) =>
            Math.max(acc, measure(item, node.style.fontSize, node.style.fontWeight, fontFor(node), undefined, textExtra(node)).w),
          0,
        );
        w = Math.round(widest + node.style.fontSize * 1.4);
        break;
      }
      case "quote":
        w = textNaturalW(node);
        break;
      default: {
        const { direction, gap } = node.layout;
        const pad = padBox(node.layout.padding);
        const flow = node.children.map((id) => doc.nodes[id]!).filter((c) => c.layout.position === "flow");
        let main = 0;
        let cross = 0;
        flow.forEach((c, i) => {
          const cw = resolvedW(c, null);
          main += cw + (i > 0 ? gap : 0);
          cross = Math.max(cross, cw);
        });
        // у сетки собственная ширина — сумма дорожек, но интринсик считаем как
        // самый широкий ребёнок: сетка почти всегда fill, это лишь запасной путь
        w = (direction === "row" ? main : cross) + pad.l + pad.r;
      }
    }
    if (typeof node.layout.width === "number") w = node.layout.width;
    if (node.layout.maxWidth !== undefined) w = Math.min(w, node.layout.maxWidth);
    wCache.set(node.id, w);
    return w;
  };

  /** Ширина ребёнка при известной внутренней ширине родителя (или null). */
  const resolvedW = (node: SceneNode, innerW: number | null): number => {
    const mode = node.layout.width;
    let w: number;
    if (typeof mode === "number") w = mode;
    else if (mode === "fill") w = innerW ?? intrinsicW(node);
    else {
      const nat = intrinsicW(node);
      w = innerW !== null ? Math.min(nat, innerW) : nat; // hug, но не шире родителя
    }
    // max-width — потолок, независимо от режима
    if (node.layout.maxWidth !== undefined) w = Math.min(w, node.layout.maxWidth);
    return w;
  };

  const fixedH = (node: SceneNode): number | null =>
    typeof node.layout.height === "number" ? node.layout.height : null;

  /* ---------- специальные высоты листьев ---------- */
  const leafH = (node: SceneNode, w: number): number => {
    switch (node.type) {
      case "text":
        return fixedH(node) ?? wrapHeight(node, Math.max(24, w));
      case "button":
        return (
          fixedH(node) ??
          measure(node.text ?? "", node.style.fontSize, node.style.fontWeight, fontFor(node), Math.max(24, w - BUTTON_PAD_X * 2), textExtra(node)).h +
            BUTTON_PAD_Y * 2
        );
      // высота фото — от РЕАЛЬНЫХ пропорций, а не от константы: иначе
      // широкое фото выходило приплюснутым, а вертикальное — растянутым
      case "image":
        return fixedH(node) ?? Math.round(Math.max(40, w / imageRatio(node)));
      case "input":
        return fixedH(node) ?? 40;
      case "breadcrumbs":
        return fixedH(node) ?? 22;
      case "autonav":
        return fixedH(node) ?? 52;
      case "autofooter":
        return fixedH(node) ?? 84;
      case "cmslist": {
        const table = doc.dbTables[node.tableRef ?? ""];
        const rowH = 22 + (table ? table.fields.length * 20 : 40) + 22;
        return fixedH(node) ?? 3 * rowH + 24;
      }
      /* ---- элементы каталога ---- */
      case "divider":
        return fixedH(node) ?? Math.max(1, node.style.borderWidth ?? 1);
      case "spacer":
        return fixedH(node) ?? 48;
      case "list": {
        // высота списка = сумма перенесённых пунктов плюс зазоры между ними
        const items = node.items ?? [];
        if (items.length === 0) return fixedH(node) ?? 24;
        const bullet = Math.round(node.style.fontSize * 1.4);
        const inner = Math.max(24, w - bullet);
        const sum = items.reduce(
          (acc, item) =>
            acc +
            measure(item, node.style.fontSize, node.style.fontWeight, fontFor(node), inner, textExtra(node)).h,
          0,
        );
        return fixedH(node) ?? Math.round(sum + (items.length - 1) * 6);
      }
      case "quote": {
        const body = wrapHeight(node, Math.max(24, w));
        const author = node.cite
          ? measure(node.cite, Math.round(node.style.fontSize * 0.7), 400, fontFor(node), Math.max(24, w), textExtra(node)).h + 8
          : 0;
        return fixedH(node) ?? body + author;
      }
      case "icon":
        return fixedH(node) ?? (typeof node.layout.width === "number" ? node.layout.width : 40);
      // видео и встраивание держат пропорцию: 16/9 по умолчанию
      case "video":
      case "embed":
        return fixedH(node) ?? Math.round(Math.max(80, w / (node.frameRatio ?? 16 / 9)));
      default:
        return fixedH(node) ?? 40;
    }
  };

  /** Ширины дорожек сетки при известной внутренней ширине. */
  const trackWidths = (tracks: GridTrack[], innerW: number, colGap: number): number[] => {
    const gaps = colGap * Math.max(0, tracks.length - 1);
    const fixed = tracks.reduce((a, t) => a + (t.px ?? 0), 0);
    const frTotal = tracks.reduce((a, t) => a + (t.fr ?? 0), 0);
    const free = Math.max(0, innerW - gaps - fixed);
    return tracks.map((t) => (t.px !== undefined ? t.px : frTotal > 0 ? (free * (t.fr ?? 0)) / frTotal : free / tracks.length));
  };

  /* ---------- размещение сверху вниз ---------- */
  /**
   * @param forcedH принудительная высота (растяжение в ряду сетки или
   *        absolute с заданными top и bottom одновременно).
   */
  const place = (node: SceneNode, x: number, y: number, w: number, forcedH?: number): number => {
    if (node.type === "instance") {
      const comp = doc.components[node.componentRef ?? ""];
      const master = comp ? doc.nodes[comp.rootId] : undefined;
      let h = 48;
      if (master) {
        const mr = rects.get(master.id);
        h = mr ? mr.h : 48;
      }
      h = forcedH ?? fixedH(node) ?? h;
      rects.set(node.id, { x, y, w, h });
      return h;
    }
    if (!isContainerLike(node)) {
      // у листьев тоже бывают отступы (`.included span{padding:18px 40px 0 0}`),
      // и текст обязан переноситься по ВНУТРЕННЕЙ ширине, а не по внешней
      const lp = padBox(node.layout.padding);
      const innerW = Math.max(4, w - lp.l - lp.r);
      let h = forcedH ?? leafH(node, innerW) + lp.t + lp.b;
      if (node.layout.maxHeight !== undefined) h = Math.min(h, node.layout.maxHeight);
      rects.set(node.id, { x, y, w, h });
      return h;
    }

    const { direction, gap, align, justify } = node.layout;
    const pad = padBox(node.layout.padding);
    const innerX = x + pad.l;
    const innerY = y + pad.t;
    const innerW = Math.max(0, w - pad.l - pad.r);
    const children = node.children.map((id) => doc.nodes[id]!);
    const flow = children.filter((c) => c.layout.position === "flow");
    const absolute = children.filter((c) => c.layout.position === "absolute");

    let contentH: number;

    /* АВТО-СЕТКА: дорожки не заданы заранее — считаем их от доступной
       ширины. Это то, что в CSS делает repeat(auto-fit, minmax(Xpx, 1fr)),
       и именно это снимает половину переопределений под мобильный. */
    const auto = node.layout.autoGrid;
    const autoTracks =
      auto && flow.length > 0
        ? autoGridTracks(auto.minColumnWidth, innerW, node.layout.gap, flow.length, auto.mode)
        : null;

    if (autoTracks) {
      contentH = placeGrid(node, flow, innerX, innerY, innerW, autoTracks);
    } else if (node.layout.preset === "masonry" && flow.length > 0) {
      contentH = placeMasonry(node, flow, innerX, innerY, innerW);
    } else if (node.layout.gridTracks && node.layout.gridTracks.length > 0 && flow.length > 0) {
      contentH = placeGrid(node, flow, innerX, innerY, innerW);
    } else if (direction === "column") {
      let cy = innerY;
      flow.forEach((c, i) => {
        const m = marginOf(c);
        /* Ширина ребёнка не больше доступной — элемент не вылезает за рамку.
           ИСКЛЮЧЕНИЕ — коробка с прокруткой: у неё содержимое ЗА краем по
           определению, и обрезает его сама коробка. Свёрнутая панель
           аккордеона supabase.com ровно такая: 76px при содержимом 560px и
           `overflow: hidden`. Зажимая содержимое в 76px, решатель заставлял
           абзац переноситься 33 раза вместо 4 — узел вырастал с 121px до
           999, и таких панелей на лендинге четыре. */
        const avail = Math.max(4, innerW - m.l - m.r);
        const wide = resolvedW(c, avail);
        const cw = node.layout.scrollX ? wide : Math.min(wide, avail);
        let cx = innerX + m.l;
        // margin-inline:auto — колонка страницы по центру
        if (c.layout.centered) cx = innerX + (innerW - cw) / 2;
        else if (align === "center") cx = innerX + (innerW - cw) / 2;
        else if (align === "end") cx = innerX + innerW - cw - m.r;
        cy += m.t;
        const ch = place(c, cx, cy, cw);
        cy += ch + m.b + (i < flow.length - 1 ? gap : 0);
      });
      contentH = cy - innerY;
      // justify по вертикали в колонке применяем только при фиксированной высоте
      const fh = forcedH ?? fixedH(node);
      if (fh !== null && flow.length > 0 && justify !== "start") {
        const free = fh - pad.t - pad.b - contentH;
        if (free > 0) {
          const shift = justify === "center" ? free / 2 : justify === "end" ? free : 0;
          const extra = justify === "between" && flow.length > 1 ? free / (flow.length - 1) : 0;
          let acc = shift;
          flow.forEach((c, i) => {
            offsetSubtree(c, 0, acc);
            if (extra) acc += extra * (i < flow.length - 1 ? 1 : 0);
          });
        }
      }
    } else if (node.layout.wrap && flow.length > 1) {
      /* РЯД С ПЕРЕНОСОМ (flex-wrap). Раньше ряд не переносился вовсе:
         строка ужималась масштабированием, и элементы становились узкими
         полосками вместо перехода на новую строку. */
      contentH = placeWrappedRow(node, flow, innerX, innerY, innerW);
    } else {
      /* row: ширины → высоты → выравнивание.
         Ключевая гарантия: строка НИКОГДА не шире родителя. Фикс-ширины
         ограничены innerW, а если сумма всё равно переполняет — равномерно
         ужимаем все колонки. */
      /* ВНЕШНИЙ ОТСТУП В РЯДУ ЛЕЖИТ СНАРУЖИ КОРОБКИ, А НЕ ВНУТРИ НЕЁ.
         Раньше `widths[i]` считалась вместе с отступами: элемент получал
         ширину `width − margin`, а курсор двигался на ту же величину плюс
         margin — то есть отступ съедал сам элемент и на месте соседа не
         сказывался вовсе. Значок 16×16 с `margin-right: 8` занимал в строке
         16px вместо 24, и каждый следующий сосед сдвигался влево на
         накопленную сумму: на github.com имя репозитория уезжало на 8px,
         слэш за ним на 12, метка «Public» на 25. В колонке ошибки не было —
         там отступы считаются отдельно от ширины, — поэтому и заметить её
         можно было только на строке.
         Теперь отступы вычитаются из доступной ширины ОДИН раз, как в CSS,
         и в ширину коробки не входят. */
      const gaps = gap * Math.max(0, flow.length - 1);
      const mars = flow.map((c) => marginOf(c));
      const marSum = mars.reduce((a, m) => a + m.l + m.r, 0);
      const isFill = flow.map((c) => c.layout.width === "fill");
      const fixed = flow.map((c, i) => (isFill[i] ? 0 : Math.min(intrinsicW(c), innerW)));
      const fixedSum = fixed.reduce((a, b) => a + b, 0);
      const fillCount = isFill.filter(Boolean).length;
      const fillEach =
        fillCount > 0 ? Math.max(MIN_FILL, (innerW - fixedSum - gaps - marSum) / fillCount) : 0;
      let widths = flow.map((c, i) =>
        isFill[i] ? Math.min(fillEach, c.layout.maxWidth ?? Infinity) : fixed[i],
      );
      let contentW = widths.reduce((a, b) => a + b, 0) + gaps + marSum;
      /* Прокручиваемая лента переполнение НЕ сжимает: лишнее уходит под
         горизонтальную прокрутку, как в оригинале. */
      if (!node.layout.scrollX && contentW > innerW && contentW - gaps - marSum > 0) {
        const scale = Math.max(0.05, (innerW - gaps - marSum) / (contentW - gaps - marSum));
        widths = widths.map((cw) => Math.max(4, cw * scale));
        contentW = widths.reduce((a, b) => a + b, 0) + gaps + marSum;
      }

      let cursor = innerX;
      let extraGap = 0;
      if (justify === "center") cursor += Math.max(0, (innerW - contentW) / 2);
      else if (justify === "end") cursor += Math.max(0, innerW - contentW);
      else if ((justify === "between" || justify === "around" || justify === "evenly") && flow.length > 1) {
        // around/evenly отличаются от between только краевыми зазорами;
        // в модели холста разница визуально несущественна
        const free = Math.max(0, innerW - contentW);
        if (justify === "between") extraGap = free / (flow.length - 1);
        else if (justify === "evenly") {
          const unit = free / (flow.length + 1);
          cursor += unit;
          extraGap = unit;
        } else {
          const unit = free / (flow.length * 2);
          cursor += unit;
          extraGap = unit * 2;
        }
      }

      const hs: number[] = [];
      flow.forEach((c, i) => {
        const m = mars[i];
        cursor += m.l;
        hs.push(place(c, cursor, innerY + m.t, Math.max(4, widths[i])) + m.t + m.b);
        cursor += Math.max(4, widths[i]) + m.r + gap + extraGap;
      });
      contentH = hs.length > 0 ? Math.max(...hs) : 0;
      // поперечное выравнивание
      flow.forEach((c, i) => {
        const free = contentH - hs[i];
        if (free > 0 && align !== "start" && align !== "stretch") {
          offsetSubtree(c, 0, align === "center" || align === "baseline" ? free / 2 : free);
        }
      });
    }

    /* Фиксированная высота — это МИНИМУМ, а не потолок: страница и секции
       никогда не обрезают содержимое. */
    const declared = forcedH ?? fixedH(node);
    let h = declared !== null && declared !== undefined
      ? Math.max(declared, contentH + pad.t + pad.b)
      : contentH + pad.t + pad.b;
    /* А вот ПОТОЛОК высоты — настоящий потолок: это прокручиваемая коробка,
       и лишнее содержимое в ней уходит под прокрутку, а не раздвигает её. */
    if (node.layout.maxHeight !== undefined) h = Math.min(h, node.layout.maxHeight);
    rects.set(node.id, { x, y, w, h });

    /* absolute-дети: поверх родителя. Когда заданы обе стороны по оси
       (`inset: 0`), узел РАСТЯГИВАЕТСЯ между ними — так на сайтах делают
       полноэкранные фото-подложки и градиентные шторки. */
    for (const c of absolute) {
      const left = c.layout.x;
      const right = c.layout.right;
      const top = c.layout.y;
      const bottom = c.layout.bottom;

      let cw: number;
      if (right !== null && right !== undefined && typeof c.layout.width !== "number") {
        cw = Math.max(4, w - left - right);
      } else {
        cw = Math.min(c.layout.width === "fill" ? w : resolvedW(c, w), w);
      }
      let ch: number | undefined;
      if (bottom !== null && bottom !== undefined && typeof c.layout.height !== "number") {
        ch = Math.max(4, h - top - bottom);
      }
      const ax = x + left;
      const ay = y + top;
      place(c, ax, ay, cw, ch);
    }
    return h;
  };

  /**
   * Раскладка сеткой. Два прохода: первым меряем высоты ряда, вторым
   * растягиваем элементы ряда до его высоты (grid по умолчанию stretch —
   * именно так карточки коллекций выравниваются в линию).
   */
  const placeGrid = (
    node: SceneNode,
    flow: SceneNode[],
    innerX: number,
    innerY: number,
    innerW: number,
    tracksOverride?: GridTrack[],
  ): number => {
    const tracks = tracksOverride ?? node.layout.gridTracks!;
    const colGap = node.layout.gap;
    const rowGap = node.layout.rowGap ?? node.layout.gap;
    const widths = trackWidths(tracks, innerW, colGap);
    const offsets: number[] = [];
    let acc = 0;
    for (let i = 0; i < widths.length; i++) {
      offsets.push(acc);
      acc += widths[i] + colGap;
    }

    /** Раскидываем детей по ячейкам с учётом span. */
    type Cell = { node: SceneNode; col: number; span: number; row: number; rows: number; w: number };
    const cells: Cell[] = [];
    let col = 0;
    let row = 0;
    let first = true;
    for (const child of flow) {
      const rawSpan = child.layout.gridSpan;
      const span = Math.min(tracks.length, rawSpan === "full" ? tracks.length : Math.max(1, rawSpan ?? 1));
      const rows = Math.max(1, Math.round(child.layout.gridRowSpan ?? 1));
      /* ЯВНОЕ МЕСТО. Раскладка «подряд» верна только для сетки без указанных
         мест; в настоящей вёрстке место задают именованные линии,
         `grid-area` и `order`, и тогда порядок детей ничего не говорит ни о
         колонке, ни о ряде. */
      const wantCol = child.layout.gridColumn;
      const wantRow = child.layout.gridRow;
      if (wantRow !== undefined && wantRow >= 1) {
        row = Math.round(wantRow) - 1;
        col =
          wantCol !== undefined && wantCol >= 1
            ? Math.max(0, Math.min(Math.round(wantCol) - 1, tracks.length - span))
            : 0;
      } else if (wantCol !== undefined && wantCol >= 1 && wantCol <= tracks.length) {
        const start = Math.max(0, Math.min(wantCol - 1, tracks.length - span));
        if (!first && start < col) row += 1;
        col = start;
      } else if (col + span > tracks.length) {
        col = 0;
        row += 1;
      }
      first = false;
      let cw = 0;
      for (let i = col; i < col + span; i++) cw += widths[i];
      cw += colGap * (span - 1);
      cells.push({ node: child, col, span, row, rows, w: Math.max(4, cw) });
      col += span;
      if (col >= tracks.length) {
        col = 0;
        row += 1;
      }
    }

    /* проход 1: высоты рядов.
       Элемент, растянутый на несколько рядов, НЕ задаёт высоту ни одному из
       них в одиночку — иначе сайдбар во всю страницу раздувал бы тот ряд, где
       начинается. Сначала ряды меряются по обычным элементам, затем растянутым
       добивается недостающее в последний из занятых рядов — так же поступает
       алгоритм распределения высоты в спецификации CSS Grid. */
    const rowH = new Map<number, number>();
    const spanned: Array<{ cell: Cell; h: number }> = [];
    for (const c of cells) {
      const m = marginOf(c.node);
      const h = place(c.node, innerX + offsets[c.col] + m.l, innerY + m.t, Math.max(4, c.w - m.l - m.r)) + m.t + m.b;
      for (let r = c.row; r < c.row + c.rows; r++) if (!rowH.has(r)) rowH.set(r, 0);
      if (c.rows <= 1) rowH.set(c.row, Math.max(rowH.get(c.row) ?? 0, h));
      else spanned.push({ cell: c, h });
    }
    for (const { cell, h } of spanned) {
      let sum = 0;
      for (let r = cell.row; r < cell.row + cell.rows; r++) sum += rowH.get(r) ?? 0;
      sum += rowGap * (cell.rows - 1);
      const last = cell.row + cell.rows - 1;
      if (h > sum) rowH.set(last, (rowH.get(last) ?? 0) + (h - sum));
    }

    // проход 2: реальные позиции + растяжение по высоте ряда
    const rowY = new Map<number, number>();
    let cy = innerY;
    const rowsSorted = [...rowH.keys()].sort((a, b) => a - b);
    for (const r of rowsSorted) {
      rowY.set(r, cy);
      cy += (rowH.get(r) ?? 0) + rowGap;
    }
    /** Высота ячейки: сумма занятых рядов вместе с зазорами между ними. */
    const cellH = (c: Cell): number => {
      let sum = 0;
      for (let r = c.row; r < c.row + c.rows; r++) sum += rowH.get(r) ?? 0;
      return sum + rowGap * (c.rows - 1);
    };
    for (const c of cells) {
      const m = marginOf(c.node);
      const rh = cellH(c);
      /* Растяжка по ряду (`align-items: stretch`) НЕ применяется к элементу с
         заданной высотой — так сказано в спецификации, и так ведёт себя
         браузер. Без этой оговорки разделительная линейка в 2px и колонка в
         655px растягивались на всю высоту ряда сетки Guardian (1217px и
         1336px), утаскивая за собой высоту всей страницы. */
      const stretch =
        node.layout.align === "start" && fixedH(c.node) === null
          ? Math.max(4, rh - m.t - m.b)
          : undefined;
      place(c.node, innerX + offsets[c.col] + m.l, (rowY.get(c.row) ?? innerY) + m.t, Math.max(4, c.w - m.l - m.r), stretch);
      if (node.layout.align === "center" || node.layout.align === "end") {
        const own = rects.get(c.node.id)?.h ?? 0;
        const free = rh - own;
        if (free > 0) offsetSubtree(c.node, 0, node.layout.align === "center" ? free / 2 : free);
      }
    }
    return rowsSorted.length === 0 ? 0 : cy - rowGap - innerY;
  };

  /**
   * Число колонок адаптивной сетки при известной ширине.
   *
   * Повторяет поведение `repeat(auto-fit, minmax(min, 1fr))`: сколько дорожек
   * шириной не меньше min влезает в доступную ширину с учётом зазоров.
   * auto-fit дополнительно не оставляет пустых дорожек — поэтому колонок
   * не больше, чем детей.
   */
  const autoGridTracks = (
    min: number,
    innerW: number,
    gap: number,
    childCount: number,
    mode: "auto-fit" | "auto-fill",
  ): GridTrack[] => {
    const usable = Math.max(0, innerW + gap);
    const fit = Math.max(1, Math.floor(usable / Math.max(40, min + gap)));
    const count = mode === "auto-fit" ? Math.min(fit, Math.max(1, childCount)) : fit;
    return Array.from({ length: count }, () => ({ fr: 1 }));
  };

  /**
   * КЛАДКА: элементы разной высоты без дыр.
   *
   * Экспорт кладки — это `columns: N` (см. codegen), а CSS-колонки НЕ
   * раскидывают элементы по самой короткой колонке: они заполняют колонки
   * ПО ПОРЯДКУ, подбирая наименьшую высоту, при которой всё ещё влезает
   * в N колонок (балансировка из спецификации CSS Multi-column).
   *
   * Раньше здесь была раскладка «следующий — в самую короткую», из-за
   * которой холст показывал не тот порядок, который потом отдавал экспорт,
   * а импорт живого сайта промахивался на целую колонку: на vitejs.dev
   * карточки отзывов вставали 1-2-3-1-2-3 вместо 1-1-1-2-2-2.
   */
  const placeMasonry = (node: SceneNode, flow: SceneNode[], innerX: number, innerY: number, innerW: number): number => {
    const cols = Math.max(1, Math.min(6, node.layout.columns ?? 3));
    const gap = node.layout.gap;
    const rowGap = node.layout.rowGap ?? gap;
    const colW = Math.max(40, (innerW - gap * (cols - 1)) / cols);

    // первый проход — настоящие высоты при ширине колонки
    const hs = flow.map((c) => place(c, innerX, innerY, colW));

    /** Разложить по порядку в колонки высотой не выше limit; null — не влезло. */
    const fill = (limit: number): number[][] | null => {
      const out: number[][] = [];
      let cur: number[] = [];
      let acc = 0;
      for (let i = 0; i < flow.length; i++) {
        const need = cur.length === 0 ? hs[i] : acc + rowGap + hs[i];
        if (cur.length > 0 && need > limit) {
          out.push(cur);
          cur = [i];
          acc = hs[i];
        } else {
          cur.push(i);
          acc = need;
        }
      }
      if (cur.length > 0) out.push(cur);
      return out.length <= cols ? out : null;
    };

    const total = hs.reduce((a, b) => a + b, 0) + rowGap * Math.max(0, flow.length - 1);
    let best = fill(total) ?? [flow.map((_, i) => i)];
    let lo = Math.max(0, ...hs);
    let hi = Math.round(total);
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const got = fill(mid);
      if (got) {
        best = got;
        hi = mid - 1;
      } else lo = mid + 1;
    }

    let tallest = 0;
    best.forEach((column, ci) => {
      const x = innerX + ci * (colW + gap);
      let y = innerY;
      for (const i of column) {
        const h = place(flow[i], x, y, colW);
        y += h + rowGap;
      }
      tallest = Math.max(tallest, y - innerY - (column.length > 0 ? rowGap : 0));
    });
    return tallest;
  };

  /** Ряд с переносом: набираем строки, пока влезают, дальше — новая строка. */
  const placeWrappedRow = (node: SceneNode, flow: SceneNode[], innerX: number, innerY: number, innerW: number): number => {
    const gap = node.layout.gap;
    const rowGap = node.layout.rowGap ?? gap;
    /* Внешние отступы в переносимой строке считаются так же, как в обычной:
       снаружи коробки. Без этого перенос происходил не там, где в браузере,
       а соседи по строке съезжали влево на сумму пропущенных отступов. */
    type Item = { node: SceneNode; w: number; outer: number; m: Sides };
    type Line = { items: Item[]; w: number };
    const lines: Line[] = [];
    let line: Line = { items: [], w: 0 };

    for (const child of flow) {
      const m = marginOf(child);
      const cw = Math.min(resolvedW(child, Math.max(4, innerW - m.l - m.r)), innerW);
      const outer = cw + m.l + m.r;
      const need = line.items.length === 0 ? outer : line.w + gap + outer;
      /* ДОПУСК НА ОКРУГЛЕНИЕ. Ширины в снимке дробные (732.656px), в модели
         целые, и текст меряется приближённо: строка, ровно заполнявшая
         родителя, переполняла его на пиксель и рвалась пополам. У колонок
         smashingmagazine.com (733 + 105 + 419 против 1256) это удваивало
         высоту секции. Настоящий перенос переполняет заметно больше. */
      if (line.items.length > 0 && need > innerW + Math.max(2, innerW * 0.004)) {
        lines.push(line);
        line = { items: [{ node: child, w: cw, outer, m }], w: outer };
      } else {
        line.items.push({ node: child, w: cw, outer, m });
        line.w = need;
      }
    }
    if (line.items.length > 0) lines.push(line);

    let cy = innerY;
    for (const l of lines) {
      let cx = innerX;
      const justify = node.layout.justify;
      const free = Math.max(0, innerW - l.w);
      let extra = 0;
      /* around и evenly раньше проваливались в «пакуем слева»: строка с
         `justify-content: space-around` вставала вплотную к левому краю,
         и весь подвал bun.sh уезжал на 818px. Раскладка та же, что у ряда
         без переноса, только считается для каждой строки отдельно. */
      if (justify === "center") cx += free / 2;
      else if (justify === "end") cx += free;
      else if (l.items.length > 1 && justify === "between") extra = free / (l.items.length - 1);
      else if (l.items.length > 0 && justify === "evenly") {
        const unit = free / (l.items.length + 1);
        cx += unit;
        extra = unit;
      } else if (l.items.length > 0 && justify === "around") {
        const unit = free / (l.items.length * 2);
        cx += unit;
        extra = unit * 2;
      }
      let maxH = 0;
      for (const item of l.items) {
        const h = place(item.node, cx + item.m.l, cy + item.m.t, item.w) + item.m.t + item.m.b;
        maxH = Math.max(maxH, h);
        cx += item.outer + gap + extra;
      }
      cy += maxH + rowGap;
    }
    return Math.max(0, cy - rowGap - innerY);
  };

  const offsetSubtree = (node: SceneNode, dx: number, dy: number): void => {
    const r = rects.get(node.id);
    if (r) rects.set(node.id, { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });
    for (const cid of node.children) {
      const child = doc.nodes[cid];
      if (child) offsetSubtree(child, dx, dy);
    }
  };

  /* ---------- корневые фреймы ----------
     Страница НИКОГДА не обрезает содержимое: если контент выше заданной
     высоты фрейма, рамка вырастает (fixed height = минимум, не максимум). */
  for (const frameId of doc.rootFrames) {
    const frame = doc.nodes[frameId]!;
    // заданная ширина вьюпорта важнее собственной ширины страницы: именно так
    // получается предпросмотр «страница на 640» без правки документа
    const w = forcedW ?? (typeof frame.layout.width === "number" ? frame.layout.width : Math.max(320, intrinsicW(frame)));
    wCache.clear();
    place(frame, frame.layout.x, frame.layout.y, w);
  }

  return rects;
}

/** Оставлено для совместимости импортов. */
export type { SizeMode };

/**
 * СНИМОК ЖИВОЙ СТРАНИЦЫ → scene graph.
 *
 * Второй путь импорта, рядом с разбором HTML (`importer.ts`). Разница
 * принципиальная: здесь НЕТ вычисления CSS. Браузер уже посчитал каскад,
 * специфичность, `clamp()`, `vw`, проценты, медиазапросы и веб-шрифты —
 * в снимке лежат готовые пиксели, разрешённые цвета и точные прямоугольники.
 *
 * Поэтому этот модуль занят единственной содержательной задачей:
 * **превратить измеренную геометрию обратно в auto-layout.** Абсолютные
 * координаты дали бы точную, но мёртвую копию — её нельзя редактировать.
 * Поэтому режим раскладки берём из вычисленного `display`, а измеренные
 * прямоугольники используем там, где вычисленный стиль врёт или молчит:
 *
 *  - `margin-inline: auto` в вычисленном стиле уже развёрнут в пиксели,
 *    поэтому центрирование определяется по геометрии: блок стоит по центру
 *    содержимого родителя и уже́ его;
 *  - `grid-template-columns` приходит использованными пикселями, равные
 *    дорожки сворачиваются обратно в доли (иначе сетка застынет на той
 *    ширине, при которой снимали);
 *  - absolute-смещения считаются как разница прямоугольников — точно.
 *
 * Модуль чистый: ни DOM, ни Pixi, ни React.
 */
import type { GridTrack, LayoutType, SceneDocument, SceneNode, Sides } from "./types";
import { createNode, packPadding } from "./scene";
import { withDeterministicIds } from "./ids";
import { matchBySignature, matchByUrl, type WidgetMatch } from "./css/widgets";
import { snapColor, snapPx, snapTracks, type PageSnapshot, type SnapNode } from "./snapshot";

export interface SnapshotImportOptions {
  snapshot: PageSnapshot;
  pageName?: string;
  /** База для относительных ссылок на картинки. */
  baseUrl?: string;
}

export interface SnapshotImportOutcome {
  frameId: string;
  nodesAdded: number;
  warnings: string[];
  widgets: string[];
  fontFamilies: string[];
  /** Сколько узлов снимка отброшено как служебные обёртки. */
  collapsed: number;
}

/** Строчные теги: внутри абзаца они не должны рвать текст на блоки. */
const INLINE = new Set([
  "span", "strong", "em", "b", "i", "u", "small", "mark", "code", "time", "sup", "sub",
  "abbr", "cite", "q", "s", "del", "ins", "var", "kbd", "samp", "bdi", "bdo", "a", "label",
]);

const FIELD_TAGS = new Set(["input", "textarea", "select"]);

/**
 * Импорт снимка с ДЕТЕРМИНИРОВАННЫМИ id (см. `withDeterministicIds`).
 *
 * Для снимка это важнее, чем для разбора HTML: снимок — это зафиксированный
 * файл, и повторный прогон обязан давать тот же документ, иначе стенд не
 * отличит регрессию решателя от смены случайных id.
 */
export function importSnapshotToDoc(
  doc: SceneDocument,
  opts: SnapshotImportOptions,
): SnapshotImportOutcome {
  const seed = [
    opts.snapshot.url,
    opts.snapshot.viewportWidth,
    opts.snapshot.nodes.length,
    Object.keys(doc.nodes).length,
  ].join("|");
  return withDeterministicIds(seed, () => importSnapshotToDocInner(doc, opts));
}

function importSnapshotToDocInner(
  doc: SceneDocument,
  opts: SnapshotImportOptions,
): SnapshotImportOutcome {
  const snap = opts.snapshot;
  const warnings: string[] = [];
  const widgets: string[] = [];
  const fonts = new Set<string>();
  let collapsed = 0;
  let added = 0;

  /** Дети каждого узла снимка. */
  const kids = new Map<number, number[]>();
  snap.nodes.forEach((n, idx) => {
    const arr = kids.get(n.p);
    if (arr) arr.push(idx);
    else kids.set(n.p, [idx]);
  });

  const pageW = Math.max(320, Math.round(snap.viewportWidth || 1440));

  /* ---------- рамка страницы ---------- */
  const frame = createNode("frame", opts.pageName || snap.title.slice(0, 40) || "Импорт");
  let maxRight = 160;
  let topY = 120;
  for (const id of doc.rootFrames) {
    const f = doc.nodes[id]!;
    const w = typeof f.layout.width === "number" ? f.layout.width : 1200;
    maxRight = Math.max(maxRight, f.layout.x + w + 120);
    topY = Math.min(topY, f.layout.y);
  }
  frame.layout.x = doc.rootFrames.length === 0 ? 160 : maxRight;
  frame.layout.y = topY;
  frame.layout.width = pageW;
  frame.layout.height = "hug";
  frame.layout.padding = 0;
  const bg = snapColor(snap.background);
  frame.style.fill = bg && bg.alpha > 0 ? bg.hex : "#ffffff";
  frame.parent = null;
  doc.nodes[frame.id] = frame;
  doc.rootFrames.push(frame.id);
  added += 1;

  /* ---------- вспомогательное ---------- */

  const sides = (n: SnapNode, prefix: "padding" | "margin"): Sides => ({
    t: Math.round(snapPx(n.s[`${prefix}-top`])),
    r: Math.round(snapPx(n.s[`${prefix}-right`])),
    b: Math.round(snapPx(n.s[`${prefix}-bottom`])),
    l: Math.round(snapPx(n.s[`${prefix}-left`])),
  });

  const resolveSrc = (raw: string | undefined): string | undefined => {
    if (!raw) return undefined;
    const s = raw.trim();
    if (!s || s.startsWith("data:")) return s || undefined;
    if (/^https?:\/\//i.test(s)) return s;
    const base = opts.baseUrl ?? snap.url;
    try {
      return new URL(s, base).href;
    } catch {
      return s;
    }
  };

  /** Виджет по ссылке или по классам — тот же каталог, что у HTML-импорта. */
  const widgetOf = (n: SnapNode): WidgetMatch | null => {
    if (n.t === "iframe" || n.t === "embed" || n.t === "object") {
      return matchByUrl(n.a?.src ?? n.a?.data);
    }
    if (n.t === "video") return { kind: "video", label: "Видео", provider: "file", ratio: n.ar ?? 16 / 9 };
    if (n.t === "canvas") return { kind: "embed", label: "Canvas-графика", ratio: 16 / 9, note: "рисование на canvas не переносится" };
    return matchBySignature(`${n.c ?? ""} ${n.i ?? ""} ${n.a?._data ?? ""}`);
  };

  /**
   * Тип раскладки из вычисленного `display`. Здесь не нужны догадки:
   * браузер сообщает точный режим, включая то, что было задано
   * медиазапросом или container query.
   */
  const layoutOf = (n: SnapNode): { preset: LayoutType; tracks: GridTrack[] | null } => {
    const disp = (n.s["display"] ?? "").trim();
    if (disp.includes("grid")) {
      const tracks = snapTracks(n.s["grid-template-columns"]);
      return { preset: tracks && tracks.length > 1 ? "columns" : "stack", tracks };
    }
    if (disp.includes("flex")) {
      const col = (n.s["flex-direction"] ?? "").startsWith("column");
      return { preset: col ? "stack" : "row", tracks: null };
    }
    return { preset: "stack", tracks: null };
  };

  /**
   * Центрирование по ГЕОМЕТРИИ, а не по стилю.
   *
   * `getComputedStyle` возвращает уже разрешённые margin в пикселях, поэтому
   * `margin-inline: auto` в снимке неотличим от жёстких отступов. Зато по
   * прямоугольникам видно однозначно: блок уже родителя и стоит по центру
   * его содержимого — значит он центрирован колонкой.
   */
  const looksCentered = (n: SnapNode, parent: SnapNode | null): boolean => {
    if (!parent) return false;
    const pad = sides(parent, "padding");
    const innerX = parent.r[0] + pad.l;
    const innerW = parent.r[2] - pad.l - pad.r;
    if (innerW <= 0 || n.r[2] >= innerW - 2) return false;
    const leftGap = n.r[0] - innerX;
    const rightGap = innerX + innerW - (n.r[0] + n.r[2]);
    return leftGap > 1 && Math.abs(leftGap - rightGap) <= 2;
  };

  /** Только строчные дети без своей типографики → это один абзац. */
  const isTextRun = (idx: number): boolean => {
    const children = kids.get(idx) ?? [];
    const n = snap.nodes[idx];
    const disp = (n.s["display"] ?? "").trim();
    if (disp.includes("flex") || disp.includes("grid")) return false;
    if (children.length === 0) return true;
    return children.every((c) => {
      const k = snap.nodes[c];
      if (!INLINE.has(k.t)) return false;
      // свой кегль/шрифт/цвет — текст не однороден, дробим на узлы
      return (
        k.s["font-size"] === n.s["font-size"] &&
        k.s["font-weight"] === n.s["font-weight"] &&
        k.s["color"] === n.s["color"] &&
        k.s["font-family"] === n.s["font-family"] &&
        (k.s["background-color"] ?? "") === (n.s["background-color"] ?? "")
      );
    });
  };

  /** Весь текст поддерева — для однородного абзаца. */
  const subtreeText = (idx: number): string => {
    const n = snap.nodes[idx];
    let out = n.x ?? "";
    for (const c of kids.get(idx) ?? []) {
      const t = subtreeText(c);
      if (t) out = out ? `${out} ${t}` : t;
    }
    return out.replace(/\s*\n\s*/g, "\n").trim();
  };

  const applyTypography = (node: SceneNode, n: SnapNode): void => {
    const family = (n.s["font-family"] ?? "").trim();
    if (family) {
      node.style.fontFamily = family;
      fonts.add(family);
    }
    const fs = Math.round(snapPx(n.s["font-size"]));
    if (fs > 0) node.style.fontSize = fs;

    const fwRaw = (n.s["font-weight"] ?? "").trim();
    const fw = fwRaw === "normal" ? 400 : fwRaw === "bold" ? 700 : parseInt(fwRaw, 10);
    if (Number.isFinite(fw)) {
      node.style.fontWeight = Math.min(700, Math.max(400, Math.round(fw / 100) * 100)) as 400 | 500 | 600 | 700;
    }

    const col = snapColor(n.s["color"]);
    if (col) node.style.textColor = col.hex;
    if (col && col.alpha < 1) node.style.opacity = col.alpha;

    if ((n.s["font-style"] ?? "").includes("italic")) node.style.italic = true;

    const ta = (n.s["text-align"] ?? "").trim();
    if (ta === "center" || ta === "right") node.style.textAlign = ta;

    const ls = snapPx(n.s["letter-spacing"]);
    if (ls && Math.abs(ls) <= 40) node.style.letterSpacing = Math.round(ls * 100) / 100;

    if (/uppercase/i.test(n.s["text-transform"] ?? "")) node.style.uppercase = true;

    // line-height из снимка — пиксели; переводим в множитель от кегля
    const lh = snapPx(n.s["line-height"]);
    if (lh > 0 && node.style.fontSize > 0) {
      node.style.lineHeight = Math.round((lh / node.style.fontSize) * 1000) / 1000;
    }

    const td = n.s["text-decoration-line"] ?? "";
    if (/line-through/.test(td)) node.style.strike = true;
    if (/none/.test(td)) node.style.underline = false;
    else if (/underline/.test(td)) node.style.underline = true;
  };

  /**
   * Позиционирование. ВАЖНО: применяется ко всем типам узлов, а не только к
   * контейнерам. Фото-подложка hero — это `<img position:absolute; inset:0`,
   * и пока абсолют ставился лишь контейнерам, картинка оставалась в потоке
   * и забирала половину ряда: контент съезжал ровно на 953px из 1905.
   */
  const applyPosition = (node: SceneNode, n: SnapNode, parent: SnapNode | null): void => {
    const pos = (n.s["position"] ?? "static").trim();
    if (pos === "fixed" || pos === "sticky") {
      node.sticky = true;
      const solid = snapColor(n.s["background-color"]);
      if (solid && solid.alpha > 0) node.scrollFill = solid.hex;
      return;
    }
    if (pos !== "absolute" || !parent) return;

    node.layout.position = "absolute";
    node.layout.x = Math.round(n.r[0] - parent.r[0]);
    node.layout.y = Math.round(n.r[1] - parent.r[1]);
    // накрывает родителя по оси → растяжка между сторонами (это `inset: 0`)
    if (n.r[2] >= parent.r[2] - 2) {
      node.layout.right = Math.round(parent.r[0] + parent.r[2] - (n.r[0] + n.r[2]));
    }
    if (n.r[3] >= parent.r[3] - 2) {
      node.layout.bottom = Math.round(parent.r[1] + parent.r[3] - (n.r[1] + n.r[3]));
    }
    node.layout.height = Math.max(1, Math.round(n.r[3]));
    if (n.r[2] < parent.r[2] - 2) node.layout.width = Math.max(1, Math.round(n.r[2]));
  };

  /**
   * `grid-column: 1 / -1` → элемент на всю строку сетки.
   * В снимке это отдельные `grid-column-start/end`; без них надзаголовок
   * секции занимал одну ячейку, и ВСЯ сетка сдвигалась на колонку —
   * отсюда расхождения ровно в ширину дорожки (1020px на вьюпорте 1920).
   */
  const applyGridSpan = (node: SceneNode, n: SnapNode): void => {
    const start = (n.s["grid-column-start"] ?? "auto").trim();
    const end = (n.s["grid-column-end"] ?? "auto").trim();
    if (start === "auto" && end === "auto") return;
    if (end === "-1" && (start === "1" || start === "auto")) {
      node.layout.gridSpan = "full";
      return;
    }
    const spanEnd = /^span (\d+)$/.exec(end);
    if (spanEnd) {
      node.layout.gridSpan = Math.max(1, parseInt(spanEnd[1], 10));
      return;
    }
    const a = parseInt(start, 10);
    const b = parseInt(end, 10);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) node.layout.gridSpan = b - a;
  };

  const applyBox = (node: SceneNode, n: SnapNode): void => {
    const bg = snapColor(n.s["background-color"]);
    if (bg && bg.alpha > 0) {
      node.style.fill = bg.hex;
      if (bg.alpha < 1) node.style.fillAlpha = bg.alpha;
    } else if (bg && bg.alpha === 0) {
      node.style.fill = "transparent";
    }

    const bgImage = n.s["background-image"] ?? "";
    if (bgImage && bgImage !== "none") {
      const url = /url\(["']?([^"')]+)["']?\)/i.exec(bgImage)?.[1];
      if (url) {
        node.style.backgroundImage = resolveSrc(url);
        const size = (n.s["background-size"] ?? "cover").trim();
        node.style.backgroundSize = size.includes("contain") ? "contain" : size.includes("cover") ? "cover" : "auto";
        const pos = n.s["background-position"];
        if (pos) node.style.backgroundPosition = pos.trim();
      }
      if (/gradient\(/i.test(bgImage)) node.style.backgroundGradient = bgImage.trim();
    }

    const radius = snapPx(n.s["border-radius"]);
    if (radius > 0) node.style.radius = Math.round(Math.min(999, radius));

    const bw = {
      t: snapPx(n.s["border-top-width"]),
      r: snapPx(n.s["border-right-width"]),
      b: snapPx(n.s["border-bottom-width"]),
      l: snapPx(n.s["border-left-width"]),
    };
    const maxW = Math.max(bw.t, bw.r, bw.b, bw.l);
    if (maxW > 0 && (n.s["border-top-style"] ?? "solid") !== "none") {
      node.style.borderWidth = Math.min(8, Math.round(maxW));
      const bc = snapColor(n.s["border-top-color"]);
      if (bc && bc.alpha > 0.05) node.style.borderColor = bc.hex;
      const only = [bw.t > 0, bw.r > 0, bw.b > 0, bw.l > 0].filter(Boolean).length === 1;
      if (only) {
        if (bw.t > 0) node.style.borderTop = true;
        else if (bw.b > 0) node.style.borderBottom = true;
        else if (bw.l > 0) node.style.borderLeft = true;
      }
    }

    const op = parseFloat(n.s["opacity"] ?? "1");
    if (Number.isFinite(op) && op < 1 && op >= 0) node.style.opacity = op;
  };

  /* ---------- обход ---------- */

  const walk = (idx: number, parentSceneId: string, parentSnap: SnapNode | null): void => {
    if (added > 2000) return;
    const n = snap.nodes[idx];
    const children = kids.get(idx) ?? [];

    /* --- сторонний виджет --- */
    const widget = widgetOf(n);
    if (widget) {
      const isVideo = widget.kind === "video" || widget.kind === "player";
      const node = createNode(isVideo ? "video" : "embed", widget.label);
      const src = resolveSrc(n.a?.src ?? n.a?.data);
      if (src) node.src = src;
      if (widget.provider) node.videoProvider = widget.provider;
      // пропорция из измеренного прямоугольника — точнее любого угадывания
      node.frameRatio = n.r[3] > 0 ? Math.round((n.r[2] / n.r[3]) * 1000) / 1000 : (widget.ratio ?? 16 / 9);
      node.layout.width = "fill";
      node.layout.height = Math.max(40, n.r[3]);
      applyBox(node, n);
      applyPosition(node, n, parentSnap);
    applyGridSpan(node, n);
      attach(node, parentSceneId, n);
      widgets.push(widget.note ? `${widget.label} — ${widget.note}` : widget.label);
      return;
    }

    /* --- inline svg --- */
    if ((n.t === "svg" || n.svg) && n.svg) {
      const node = createNode("image", "Иконка");
      node.src = `data:image/svg+xml;utf8,${encodeURIComponent(n.svg)}`;
      node.aspectRatio = n.r[3] > 0 ? n.r[2] / n.r[3] : 1;
      node.layout.width = Math.max(1, n.r[2]);
      node.layout.height = Math.max(1, n.r[3]);
      applyPosition(node, n, parentSnap);
    applyGridSpan(node, n);
      attach(node, parentSceneId, n);
      return;
    }

    /* --- картинка --- */
    if (n.t === "img" || n.t === "picture") {
      const node = createNode("image", (n.a?.alt || n.c || "Картинка").slice(0, 40));
      node.src = resolveSrc(n.a?.src ?? pickSrcset(n.a?.srcset));
      if (n.ar) node.aspectRatio = n.ar;
      const fit = (n.s["object-fit"] ?? "").trim();
      if (fit === "cover" || fit === "contain" || fit === "fill") node.style.objectFit = fit;
      node.layout.width = "fill";
      node.layout.height = Math.max(1, n.r[3]);
      applyBox(node, n);
      applyPosition(node, n, parentSnap);
    applyGridSpan(node, n);
      attach(node, parentSceneId, n);
      return;
    }

    /* --- поля формы --- */
    if (FIELD_TAGS.has(n.t)) {
      const type = (n.a?.type ?? "").toLowerCase();
      if (type === "hidden") return;
      const node = createNode("input", `Поле ${n.a?.name ?? ""}`.trim());
      if (type === "checkbox" || type === "radio") {
        node.text = "";
        node.layout.width = Math.max(12, n.r[2]);
        node.layout.height = Math.max(12, n.r[3]);
        node.style.radius = type === "radio" ? 999 : 3;
      } else {
        node.text = n.a?.placeholder ?? n.a?.value ?? n.x ?? "";
        node.layout.width = "fill";
        node.layout.height = Math.max(24, n.r[3]);
      }
      applyTypography(node, n);
      applyBox(node, n);
      applyPosition(node, n, parentSnap);
    applyGridSpan(node, n);
      attach(node, parentSceneId, n);
      return;
    }

    /* --- кнопка --- */
    const bgc = snapColor(n.s["background-color"]);
    const looksButton =
      n.t === "button" ||
      (n.t === "a" &&
        ((bgc !== null && bgc.alpha > 0) ||
          snapPx(n.s["border-top-width"]) > 0 ||
          /btn|button|cta/i.test(n.c ?? "")));
    if (looksButton) {
      const label = subtreeText(idx).replace(/\n/g, " ");
      const node = createNode("button", label.slice(0, 24) || "Кнопка");
      node.text = label || "Кнопка";
      node.style.fill = bgc && bgc.alpha > 0 ? bgc.hex : "transparent";
      if (bgc && bgc.alpha > 0 && bgc.alpha < 1) node.style.fillAlpha = bgc.alpha;
      applyTypography(node, n);
      applyBox(node, n);
      node.layout.height = Math.max(24, n.r[3]);
      if (n.a?.href) node.href = n.a.href;
      applyPosition(node, n, parentSnap);
    applyGridSpan(node, n);
      attach(node, parentSceneId, n);
      return;
    }

    /* --- однородный текст --- */
    const text = isTextRun(idx) ? subtreeText(idx) : "";
    if (text) {
      const node = createNode("text", n.t.toUpperCase());
      node.text = text;
      applyTypography(node, n);
      applyBox(node, n);
      const pad = sides(n, "padding");
      if (pad.t || pad.r || pad.b || pad.l) node.layout.padding = packPadding(pad);
      const mar = sides(n, "margin");
      if (mar.t || mar.b || mar.l || mar.r) node.layout.margin = mar;
      // ширину берём измеренную как потолок: перенос строк совпадёт с оригиналом
      node.layout.width = "fill";
      if (parentSnap && n.r[2] < parentSnap.r[2] - 2) node.layout.maxWidth = Math.round(n.r[2]);
      if (looksCentered(n, parentSnap)) {
        node.layout.centered = true;
        delete node.layout.margin;
      }
      if (n.a?.href) node.href = n.a.href;
      if (n.i) node.anchorId = n.i;
      applyPosition(node, n, parentSnap);
    applyGridSpan(node, n);
      attach(node, parentSceneId, n);
      return;
    }

    /* --- контейнер --- */
    // служебная обёртка без своей геометрии и оформления не нужна в дереве
    if (children.length === 1 && isPassthrough(n)) {
      collapsed += 1;
      walk(children[0], parentSceneId, parentSnap);
      return;
    }

    const node = createNode("container", (n.c || n.t).slice(0, 40));
    const { preset, tracks } = layoutOf(n);
    node.layout.preset = preset;
    node.layout.direction = preset === "row" ? "row" : "column";
    if (tracks && tracks.length > 1) {
      node.layout.gridTracks = tracks;
      node.layout.preset = "columns";
      node.layout.columns = tracks.length;
      node.layout.direction = "row";
    }
    if ((n.s["flex-wrap"] ?? "").includes("wrap")) node.layout.wrap = true;

    const pad = sides(n, "padding");
    node.layout.padding = packPadding(pad);
    const mar = sides(n, "margin");
    if (mar.t || mar.b || mar.l || mar.r) node.layout.margin = mar;

    node.layout.gap = Math.round(snapPx(n.s["column-gap"]) || 0);
    const rowGap = Math.round(snapPx(n.s["row-gap"]) || 0);
    if (rowGap && rowGap !== node.layout.gap) node.layout.rowGap = rowGap;
    if (!node.layout.gap && rowGap) node.layout.gap = rowGap;

    const justify = (n.s["justify-content"] ?? "").trim();
    node.layout.justify =
      justify.includes("between") ? "between"
      : justify.includes("around") ? "around"
      : justify.includes("evenly") ? "evenly"
      : justify === "center" ? "center"
      : justify.includes("end") ? "end"
      : "start";
    const align = (n.s["align-items"] ?? "").trim();
    node.layout.align =
      align === "center" || align === "baseline" ? "center"
      : align.includes("end") ? "end"
      : align === "stretch" ? "start"
      : "start";

    // ширина: измеренная относительно родителя
    const parentInner = parentSnap ? parentSnap.r[2] - sides(parentSnap, "padding").l - sides(parentSnap, "padding").r : pageW;
    node.layout.width = n.r[2] >= parentInner - 2 ? "fill" : "fill";
    if (n.r[2] < parentInner - 2) node.layout.maxWidth = Math.round(n.r[2]);
    if (looksCentered(n, parentSnap)) {
      node.layout.centered = true;
      delete node.layout.margin;
    }

    // высота: держим как минимум, если она задана не содержимым
    const minH = snapPx(n.s["min-height"]);
    if (minH > 0) node.layout.height = Math.round(minH);

    applyPosition(node, n, parentSnap);
    applyGridSpan(node, n);

    applyTypography(node, n);
    applyBox(node, n);
    if (n.i) node.anchorId = n.i;
    applyRole(node, n);
    attach(node, parentSceneId, n);

    for (const c of children) walk(c, node.id, n);

    // пустышка без оформления не нужна
    const carries =
      node.style.fill !== "transparent" ||
      !!node.style.backgroundImage ||
      !!node.style.backgroundGradient ||
      !!node.style.borderWidth ||
      typeof node.layout.height === "number";
    if (node.children.length === 0 && !carries) {
      doc.nodes[parentSceneId]!.children = doc.nodes[parentSceneId]!.children.filter((c) => c !== node.id);
      delete doc.nodes[node.id];
      added -= 1;
      collapsed += 1;
    }
  };

  function attach(node: SceneNode, parentId: string, _n: SnapNode): void {
    node.parent = parentId;
    doc.nodes[node.id] = node;
    doc.nodes[parentId]!.children.push(node.id);
    added += 1;
  }

  function applyRole(node: SceneNode, n: SnapNode): void {
    switch (n.t) {
      case "header":
        node.role = "header";
        node.name = "Шапка";
        break;
      case "footer":
        node.role = "footer";
        node.name = "Подвал";
        break;
      case "nav":
        node.role = "nav";
        break;
      case "section":
      case "article":
      case "main":
        node.role = "section";
        break;
    }
  }

  /**
   * Обёртка «ни о чём»: один ребёнок, нет фона, рамки, отступов и своей
   * раскладки. Реальные сайты плодят такие div-ы десятками — в редакторе
   * они только мешают попадать по нужному элементу.
   */
  function isPassthrough(n: SnapNode): boolean {
    const pad = sides(n, "padding");
    const mar = sides(n, "margin");
    if (pad.t || pad.r || pad.b || pad.l || mar.t || mar.b || mar.l || mar.r) return false;
    const bg = snapColor(n.s["background-color"]);
    if (bg && bg.alpha > 0) return false;
    if ((n.s["background-image"] ?? "none") !== "none") return false;
    if (snapPx(n.s["border-top-width"]) || snapPx(n.s["border-left-width"])) return false;
    if ((n.s["position"] ?? "static") !== "static") return false;
    if (snapPx(n.s["min-height"]) > 0) return false;
    if (n.i) return false; // якорь нужен для ссылок
    return n.t === "div" || n.t === "span";
  }

  function pickSrcset(srcset: string | undefined): string | undefined {
    if (!srcset) return undefined;
    let best = "";
    let bestW = -1;
    for (const cand of srcset.split(",")) {
      const [u, d] = cand.trim().split(/\s+/);
      const w = /^(\d+)w$/.test(d ?? "") ? parseInt(d, 10) : /^([\d.]+)x$/.test(d ?? "") ? parseFloat(d) * 1000 : 0;
      if (u && w >= bestW) {
        best = u;
        bestW = w;
      }
    }
    return best || undefined;
  }

  /* ---------- запуск ---------- */
  for (const rootIdx of kids.get(-1) ?? []) walk(rootIdx, frame.id, null);

  if (snap.nodes.length === 0) warnings.push("Снимок пуст: страница не отдала ни одного видимого элемента");
  if (snap.skipped > snap.nodes.length) {
    warnings.push(`Скрытых элементов больше видимых (${snap.skipped}): возможно, часть интерфейса не раскрылась`);
  }
  if (added > 2000) warnings.push("Страница усечена до 2000 узлов");

  return {
    frameId: frame.id,
    nodesAdded: added,
    warnings,
    widgets: [...new Set(widgets)],
    fontFamilies: [...fonts],
    collapsed,
  };
}

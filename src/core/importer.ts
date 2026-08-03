/**
 * ИМПОРТ HTML-САЙТА → scene graph Plexus (v3).
 *
 * v3 — переписан после разбора на реальном сайте (COSPEX). Прошлая версия
 * ковыряла CSS регекспами прямо здесь, и на настоящей вёрстке это давало
 * четыре видимых симптома: игнорировался размер страницы, съезжал текст,
 * терялись стили и фотографии. Корневых причин было пять:
 *
 *  1. КАСКАД РАБОТАЛ НАОБОРОТ. Декларации копились по принципу «первое
 *     побеждает» — любой оверрайд ниже по стилю молча терялся. Теперь
 *     каскад настоящий: специфичность + порядок, побеждает последнее
 *     (см. css/cascade.ts), а селекторы матчатся родным `element.matches()`,
 *     поэтому `:not()`, `:nth-child`, `>` и `+` работают как в браузере.
 *  2. НЕ БЫЛО ШИРИНЫ СТРАНИЦЫ. `max-width`/`margin:auto` не читались вовсе,
 *     фрейм всегда был 1200px. Теперь ширина берётся из вьюпорта импорта,
 *     а колонка контента — из max-width (layout.maxWidth + centered).
 *  3. НЕ БЫЛО ШРИФТА В МОДЕЛИ. Всё мерилось шрифтом темы по эвристике
 *     «кегль ≥ 24». Теперь `font-family` переносится в узел, и решатель
 *     меряет тем же шрифтом, каким рисует рендерер.
 *  4. ФОТО ПРИХОДЯТ ФОНАМИ. `background-image` и `inset:0`-подложки не
 *     импортировались, а inline `<svg>` выбрасывался. Теперь всё это узлы.
 *  5. ГЕОМЕТРИЯ ЛОМАЛАСЬ ДО РАСКЛАДКИ. padding схлопывался в одно число,
 *     лонгхенды (`padding-top`) не читались, grid превращался в одну строку,
 *     а абзац с `<strong>` внутри рассыпался на отдельные блоки.
 */
import type { SceneDocument, SceneNode, Sides } from "./types";
import { createNode, packPadding } from "./scene";
import {
  computeDeclarations, parseStylesheet, RuleIndex, type Stylesheet,
} from "./css/cascade";
import {
  normalizeFontFamily, parseBorder, parseFontShorthand, parseGridSpan, parseGridTracks,
  resolveGap, resolveInset, resolveMargin, resolvePadding,
} from "./css/shorthand";
import {
  averageGradientColor, defaultCtx, evalLength, extractUrl, hasGradient, parseColor,
  resolveVars, splitWords, type LengthCtx,
} from "./css/values";
import { withDeterministicIds } from "./ids";
import { analyzeSource, type SourceReport } from "./css/source";
import { matchBySignature, matchByUrl, type WidgetMatch } from "./css/widgets";

export interface ImportOptions {
  html: string;
  css: string;
  pageName: string;
  sourceDir?: string;
  /** База для импорта по ссылке: относительные картинки → абсолютные URL. */
  baseUrl?: string;
  /**
   * Ширина вьюпорта, под которую разбирается сайт. Это же — ширина фрейма.
   * Раньше была зашита (1200), а vw считались по множителю 12.
   */
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface ImportOutcome {
  frameId: string;
  nodesAdded: number;
  warnings: string[];
  imagesToCopy: Array<{ nodeId: string; absPath: string; rel: string }>;
  /** Шрифты, которые надо подгрузить, чтобы измерение совпало с оригиналом. */
  fontLinks: string[];
  fontFamilies: string[];
  /** Что за источник разбирали: статика, гидратация или пустой каркас SPA. */
  source: SourceReport;
  /** Чем заменены сторонние виджеты: «Видео YouTube», «Карта» и т.п. */
  widgets: string[];
}

/** Теги, которые не дают узлов. SVG больше НЕ здесь — он становится картинкой. */
const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "BASE",
]);
const HEAD_SIZES: Record<string, number> = { H1: 44, H2: 34, H3: 22, H4: 18, H5: 16, H6: 14 };
/** Строчные теги: внутри абзаца они НЕ должны рвать текст на блоки. */
const INLINE_TAGS = new Set([
  "SPAN", "STRONG", "EM", "B", "I", "U", "SMALL", "MARK", "CODE", "TIME", "SUP", "SUB",
  "ABBR", "CITE", "Q", "S", "DEL", "INS", "VAR", "KBD", "SAMP", "BDI", "BDO", "WBR", "BR", "A",
]);
/** Свойства, наследуемые от родителя (как в CSS). */
const INHERITED = [
  "color", "font-family", "font-size", "font-weight", "font-style", "letter-spacing",
  "line-height", "text-transform", "text-align", "text-indent", "white-space",
] as const;

const MAX_NODES = 900;

type Decls = Record<string, string>;

/** Контекст обхода: то, что наследуется вниз по дереву. */
interface WalkCtx {
  /** Унаследованные декларации (цвет, шрифт, кегль…). */
  inherited: Decls;
  /** Ширина контейнера в px — база для процентов. */
  width: number;
  /** Высота контейнера в px, если известна — база для процентных высот. */
  height: number | null;
  /** Кегль родителя — база для em. */
  font: number;
  /** Направление раскладки родителя (влияет на дефолт ширины ребёнка). */
  parentDir: "row" | "column";
  /** Родитель — сетка: ребёнок не должен сам решать про fill/hug. */
  parentIsGrid: boolean;
}

/**
 * Импорт с ДЕТЕРМИНИРОВАННЫМИ id узлов.
 *
 * Разбор одного и того же исходника при той же ширине обязан давать один и
 * тот же документ — иначе вывод кодогена меняется от прогона к прогону и его
 * нельзя ни сравнить побайтово, ни держать в git. В затравку входит число
 * уже существующих узлов: два импорта одного сайта в один документ должны
 * получить РАЗНЫЕ id, иначе документ разрушится.
 */
export function importHtmlToDoc(doc: SceneDocument, opts: ImportOptions): ImportOutcome {
  const seed = [
    opts.baseUrl ?? opts.sourceDir ?? opts.pageName,
    opts.viewportWidth ?? 0,
    opts.html.length,
    Object.keys(doc.nodes).length,
  ].join("|");
  return withDeterministicIds(seed, () => importHtmlToDocInner(doc, opts));
}

function importHtmlToDocInner(doc: SceneDocument, opts: ImportOptions): ImportOutcome {
  const warnings: string[] = [];
  const imagesToCopy: ImportOutcome["imagesToCopy"] = [];
  const fontFamilies = new Set<string>();
  const widgetsFound: string[] = [];
  let added = 0;

  const vw = Math.max(320, Math.round(opts.viewportWidth ?? 1440));
  const vh = Math.max(400, Math.round(opts.viewportHeight ?? Math.round(vw * 0.625)));

  /* ---------- HTML ---------- */
  const parsed = new DOMParser().parseFromString(opts.html, "text/html");

  /* ---------- CSS: внешний + <style> страницы ---------- */
  let cssAll = opts.css;
  parsed.querySelectorAll("style").forEach((s) => {
    cssAll += `\n${s.textContent ?? ""}`;
  });

  const sheet: Stylesheet = parseStylesheet(cssAll, { width: vw, height: vh });
  const index = new RuleIndex(sheet.rules);
  const vars = sheet.vars;

  /** Корневой кегль (html{font-size}) — база для rem. */
  const rootFont = (() => {
    const htmlEl = parsed.documentElement;
    const d = htmlEl ? computeDeclarations(htmlEl, index) : {};
    const raw = d["font-size"];
    if (!raw) return 16;
    return evalLength(resolveVars(raw, vars), defaultCtx(vw, vh)) ?? 16;
  })();

  /** Контекст для ГОРИЗОНТАЛЬНЫХ величин: проценты считаются от ширины. */
  const ctxFor = (width: number, font: number): LengthCtx => ({
    vw,
    vh,
    rootFont,
    parentFont: font,
    percentBase: width,
  });

  /**
   * Контекст для ВЕРТИКАЛЬНЫХ величин: проценты считаются от высоты родителя.
   * Без этого `height:100%` у фото-подложки разрешался в ширину родителя —
   * картинка получалась 1440px высотой внутри секции 900px и вылезала на 540px.
   */
  const vCtxFor = (height: number | null, font: number): LengthCtx => ({
    vw,
    vh,
    rootFont,
    parentFont: font,
    percentBase: height,
  });

  /** Декларации элемента с раскрытыми var() и наследованием. */
  const declsFor = (el: Element, ctx: WalkCtx): Decls => {
    const own = computeDeclarations(el, index);
    const out: Decls = {};
    for (const prop of INHERITED) {
      const v = ctx.inherited[prop];
      if (v !== undefined) out[prop] = v;
    }
    for (const [k, v] of Object.entries(own)) {
      if (k.endsWith("!")) continue;
      out[k] = resolveVars(v, vars);
    }
    // шорткат font: раскрываем ДО чтения отдельных свойств
    if (own["font"]) {
      const f = parseFontShorthand(resolveVars(own["font"], vars));
      if (f.family && !own["font-family"]) out["font-family"] = f.family;
      if (f.size && !own["font-size"]) out["font-size"] = f.size;
      if (f.weight && !own["font-weight"]) out["font-weight"] = f.weight;
      if (f.style && !own["font-style"]) out["font-style"] = f.style;
      if (f.lineHeight && !own["line-height"]) out["line-height"] = f.lineHeight;
    }
    return out;
  };

  /** Что передаём детям. */
  const inheritFrom = (d: Decls): Decls => {
    const out: Decls = {};
    for (const prop of INHERITED) if (d[prop] !== undefined) out[prop] = d[prop];
    return out;
  };

  /* ---------- сборка ---------- */
  const attach = (node: SceneNode, parentId: string): SceneNode => {
    node.parent = parentId;
    doc.nodes[node.id] = node;
    doc.nodes[parentId]!.children.push(node.id);
    added += 1;
    return node;
  };

  /* ---------- «затвердевший» фон шапки ---------- */
  let scrolledFill: string | null = null;
  let scrolledAlpha = 1;
  for (const rule of sheet.rules) {
    if (!/scroll|sticky|solid|\bopen\b/i.test(rule.selector)) continue;
    const bg = rule.decls["background"] ?? rule.decls["background-color"];
    const col = parseColor(resolveVars(bg ?? "", vars));
    if (col && col.alpha > 0) {
      scrolledFill = col.hex;
      scrolledAlpha = col.alpha;
      break;
    }
  }

  /* ---------- reveal-анимации ---------- */
  const revealClasses = new Set<string>();
  for (const rule of sheet.rules) {
    const body = rule.decls;
    if (!/^0$|^0\./.test((body["opacity"] ?? "").trim())) continue;
    if (!body["transition"] && !body["transform"]) continue;
    const m = /^\.([\w-]+)$/.exec(rule.selector.trim());
    if (m) revealClasses.add(m[1]);
  }

  /* ---------- применение стилей к узлу ---------- */

  const applyTypography = (node: SceneNode, d: Decls, ctx: LengthCtx, inheritedColor: string | null): void => {
    const family = normalizeFontFamily(d["font-family"]);
    if (family) {
      node.style.fontFamily = family;
      fontFamilies.add(family);
    }

    const fs = d["font-size"] ? evalLength(d["font-size"], ctx) : null;
    if (fs !== null && fs > 0) node.style.fontSize = Math.round(fs);

    const fwRaw = (d["font-weight"] ?? "").trim();
    if (fwRaw) {
      const named = { normal: 400, bold: 700, bolder: 700, lighter: 400 }[fwRaw as "bold"];
      const fw = named ?? parseInt(fwRaw, 10);
      if (Number.isFinite(fw)) {
        node.style.fontWeight = Math.min(700, Math.max(400, Math.round(fw / 100) * 100)) as 400 | 500 | 600 | 700;
      }
    }

    const col = parseColor(d["color"]);
    if (col) node.style.textColor = col.hex;
    else if (inheritedColor) node.style.textColor = inheritedColor;

    if ((d["font-style"] ?? "").includes("italic") || (d["font-style"] ?? "").includes("oblique")) {
      node.style.italic = true;
    }

    const ta = (d["text-align"] ?? "").trim();
    if (ta === "center" || ta === "right") node.style.textAlign = ta;

    /* em у letter-spacing и line-height считается от СОБСТВЕННОГО кегля
       элемента, а не от родительского. Раньше `.17em` при кегле 24
       давало 2.72px вместо 4.08 — буквы стояли теснее оригинала, и строка
       выходила короче, что и накапливалось в «съезжающий» текст. */
    const selfCtx: LengthCtx = { ...ctx, parentFont: node.style.fontSize || ctx.parentFont };

    const ls = d["letter-spacing"];
    if (ls && !/normal/i.test(ls)) {
      const v = evalLength(ls, selfCtx);
      if (v !== null && Math.abs(v) <= 40) node.style.letterSpacing = Math.round(v * 100) / 100;
    }

    if (/uppercase/i.test(d["text-transform"] ?? "")) node.style.uppercase = true;

    const lh = (d["line-height"] ?? "").trim();
    if (lh && !/normal/i.test(lh)) {
      const unitless = /^[\d.]+$/.test(lh) ? parseFloat(lh) : null;
      if (unitless !== null) node.style.lineHeight = unitless;
      else {
        const px = evalLength(lh, selfCtx);
        if (px !== null && node.style.fontSize > 0) node.style.lineHeight = px / node.style.fontSize;
      }
    }

    const op = d["opacity"];
    if (op) {
      const v = parseFloat(op);
      if (Number.isFinite(v) && v >= 0 && v < 1) node.style.opacity = v;
    }

    const td = d["text-decoration"] ?? d["text-decoration-line"] ?? "";
    if (/line-through/.test(td)) node.style.strike = true;
    // ссылки сайта чаще всего БЕЗ подчёркивания; кодоген подчёркивает их
    // по умолчанию, поэтому явное `none` нужно донести до модели
    if (/\bnone\b/.test(td)) node.style.underline = false;
    else if (/underline/.test(td)) node.style.underline = true;
  };

  const applyBox = (node: SceneNode, d: Decls, ctx: LengthCtx): void => {
    // фон: цвет + картинка + градиент (раньше терялись все три случая)
    const bgRaw = d["background"] ?? "";
    const bgColorRaw = d["background-color"] ?? (hasGradient(bgRaw) || extractUrl(bgRaw) ? "" : bgRaw);
    const col = parseColor(bgColorRaw);
    if (col && col.alpha > 0) {
      node.style.fill = col.hex;
      if (col.alpha < 1) node.style.fillAlpha = col.alpha;
    } else if (col && col.alpha === 0) {
      // `background: transparent` — осознанный выбор автора сайта, а не
      // отсутствие значения: дефолтную заливку узла надо снять
      node.style.fill = "transparent";
    }

    const bgImage = d["background-image"] ?? bgRaw;
    const url = extractUrl(bgImage);
    if (url) {
      node.style.backgroundImage = resolveAssetPath(url, node.id);
      const size = (d["background-size"] ?? "cover").trim();
      node.style.backgroundSize = size === "contain" ? "contain" : size === "auto" ? "auto" : "cover";
      const pos = d["background-position"];
      if (pos) node.style.backgroundPosition = pos.trim();
    }
    if (hasGradient(bgImage)) {
      node.style.backgroundGradient = bgImage.trim();
      // на холсте градиент показываем усреднённым цветом — блок не будет дырой
      const avg = averageGradientColor(bgImage);
      if (avg && node.style.fill === "transparent") {
        node.style.fill = avg.hex;
        if (avg.alpha < 1) node.style.fillAlpha = avg.alpha;
      }
    }

    const radius = d["border-radius"];
    if (radius) {
      const r = evalLength(splitWords(radius)[0] ?? "", ctx);
      if (r !== null) node.style.radius = Math.round(/50%|9999/.test(radius) ? 999 : r);
    }

    /* Рамка: сначала общая, затем односторонние. `border: 0` — это ЯВНЫЙ
       отказ от рамки (поля формы COSPEX), и он должен снимать дефолт узла. */
    const borderRaw = d["border"];
    const border = parseBorder(borderRaw, ctx);
    if (borderRaw && !border) {
      node.style.borderWidth = undefined;
      node.style.borderTop = undefined;
      node.style.borderBottom = undefined;
      node.style.borderLeft = undefined;
    }
    const sides: Array<[string, "borderTop" | "borderBottom" | "borderLeft"]> = [
      ["border-top", "borderTop"],
      ["border-bottom", "borderBottom"],
      ["border-left", "borderLeft"],
    ];
    let sideHit: ReturnType<typeof parseBorder> = null;
    let sideKey: "borderTop" | "borderBottom" | "borderLeft" | null = null;
    for (const [prop, key] of sides) {
      const parsed = parseBorder(d[prop], ctx);
      if (parsed) {
        sideHit = parsed;
        sideKey = key;
        break;
      }
    }
    const src = border ?? sideHit;
    if (src) {
      node.style.borderWidth = Math.min(8, Math.max(1, Math.round(src.width)));
      const bc = parseColor(src.color ?? d["color"]);
      if (bc && bc.alpha > 0.05) node.style.borderColor = bc.hex;
      if (!border && sideKey) node.style[sideKey] = true;
    }
  };

  /**
   * Внешние отступы. `margin-inline: auto` — это центрирование, остальное —
   * реальные зазоры. Без них у импортированной страницы пропадал весь
   * вертикальный ритм (`.eyebrow{margin:0 0 28px}`) и боковой сдвиг
   * (`.hero-content{margin-left:8vw}` — текст прижимался к краю экрана).
   */
  const applyMargin = (node: SceneNode, d: Decls, ctx: LengthCtx): void => {
    const m = resolveMargin(d, ctx);
    if (m.l === "auto" && m.r === "auto") {
      node.layout.centered = true;
      if (m.t || m.b) node.layout.margin = { t: Math.round(m.t), r: 0, b: Math.round(m.b), l: 0 };
      return;
    }
    const l = typeof m.l === "number" ? m.l : 0;
    const r = typeof m.r === "number" ? m.r : 0;
    // отрицательные margin реального сайта уважаем, но не даём утащить блок
    // дальше половины вьюпорта — иначе одна опечатка в CSS ломает страницу
    const clampM = (v: number) => Math.max(-vw / 2, Math.min(vw, Math.round(v)));
    if (m.t || r || m.b || l) {
      node.layout.margin = { t: clampM(m.t), r: clampM(r), b: clampM(m.b), l: clampM(l) };
    }
  };

  /** Позиционирование: sticky-шапка, absolute-подложки, inset-растяжки. */
  const applyPosition = (node: SceneNode, d: Decls, ctx: LengthCtx, parentHeightHint: number | null): void => {
    const pos = (d["position"] ?? "").trim();
    if (pos === "fixed" || pos === "sticky") {
      node.sticky = true;
      const solid = scrolledFill ?? parseColor(d["background"] ?? d["background-color"])?.hex ?? null;
      if (solid) node.scrollFill = solid;
      if (scrolledFill && scrolledAlpha < 1) node.style.fillAlpha = node.style.fillAlpha ?? scrolledAlpha;
      return;
    }
    if (pos !== "absolute") return;

    const inset = resolveInset(d, ctx);
    if (inset.top === null && inset.left === null && inset.right === null && inset.bottom === null) return;

    node.layout.position = "absolute";
    node.layout.x = Math.round(inset.left ?? 0);
    node.layout.y = Math.round(inset.top ?? 0);
    // обе стороны по оси → растяжка (это и есть `inset: 0` у фото-подложек)
    if (inset.left !== null && inset.right !== null) node.layout.right = Math.round(inset.right);
    if (inset.top !== null && inset.bottom !== null) node.layout.bottom = Math.round(inset.bottom);

    /* Привязка только к правому/нижнему краю (штамп «Edition 05 of 10»
       сидит на `right:4vw; bottom:4vw`). Ширина элемента уже известна —
       переводим в левую координату, иначе элемент прилипал к левому краю. */
    const parentW = ctx.percentBase;
    if (inset.left === null && inset.right !== null && parentW !== null) {
      const ownW = typeof node.layout.width === "number" ? node.layout.width : null;
      if (ownW !== null) node.layout.x = Math.max(0, Math.round(parentW - ownW - inset.right));
      else node.layout.right = Math.round(inset.right);
    }
    if (inset.top === null && inset.bottom !== null) {
      const ownH = typeof node.layout.height === "number" ? node.layout.height : null;
      if (ownH !== null && parentHeightHint !== null) {
        node.layout.y = Math.max(0, Math.round(parentHeightHint - ownH - inset.bottom));
      }
    }
  };

  const applyRole = (node: SceneNode, el: Element): void => {
    switch (el.tagName) {
      case "FOOTER":
        node.role = "footer";
        node.name = "Подвал";
        break;
      case "HEADER":
        node.role = "header";
        node.name = "Шапка";
        break;
      case "NAV":
        node.role = "nav";
        break;
      case "SECTION":
      case "ARTICLE":
      case "MAIN":
        node.role = "section";
        break;
    }
  };

  const applyAnchor = (node: SceneNode, el: Element): void => {
    const id = el.getAttribute("id");
    if (id) node.anchorId = id;
  };

  const applyReveal = (node: SceneNode, el: Element, d: Decls): void => {
    if (!Array.from(el.classList).some((c) => revealClasses.has(c))) return;
    const transform = d["transform"] ?? "";
    const kind = /scale/.test(transform)
      ? "zoom"
      : /translateY\(\s*-/.test(transform)
        ? "down"
        : /translateY/.test(transform)
          ? "up"
          : "fade";
    const secs = /([\d.]+)s/.exec(d["transition"] ?? "");
    const duration = secs ? Math.round(parseFloat(secs[1]) * 1000) : 700;
    node.reveal = { kind, duration: Math.min(2000, Math.max(120, duration)), delay: 0 };
    // класс задаёт opacity:0 — на холсте элемент обязан быть видимым
    node.style.opacity = undefined;
  };

  const applyCommon = (
    node: SceneNode, el: Element, d: Decls, ctx: LengthCtx, parentHeight: number | null = null,
  ): void => {
    applyPosition(node, d, ctx, parentHeight);
    applyAnchor(node, el);
    applyRole(node, el);
    applyReveal(node, el, d);
    // `grid-column: 1 / -1` бывает не только у контейнеров: подпись-эйбрау,
    // кнопка на всю ширину формы, строка копирайта в подвале — всё это
    // текст/кнопки внутри сетки, и span им нужен так же
    const span = parseGridSpan(d);
    if (span !== null) node.layout.gridSpan = span;
  };

  /* ---------- пути к картинкам ---------- */
  function resolveAssetPath(src: string, nodeId: string): string {
    const clean = src.trim().replace(/^["']|["']$/g, "");
    if (!clean || clean.startsWith("data:")) return clean;
    if (/^https?:\/\//i.test(clean)) return clean;
    if (opts.baseUrl) {
      try {
        return new URL(clean, opts.baseUrl).href;
      } catch {
        return clean;
      }
    }
    if (opts.sourceDir) {
      // Windows-разделители и ../ нормализуем — раньше путь склеивался наивно
      const dir = opts.sourceDir.replace(/[\\/]+$/, "").replace(/\\/g, "/");
      const rel = clean.replace(/\\/g, "/").replace(/^\.\//, "");
      const parts = `${dir}/${rel}`.split("/");
      const stack: string[] = [];
      for (const p of parts) {
        if (p === "..") stack.pop();
        else if (p !== "." && p !== "") stack.push(p);
      }
      const abs = (dir.startsWith("/") ? "/" : "") + stack.join("/");
      imagesToCopy.push({ nodeId, absPath: abs, rel: clean });
      return abs;
    }
    return clean;
  }

  /** Лучший источник из srcset/picture — берём самый крупный кандидат. */
  const bestSrc = (el: Element): string => {
    const direct = el.getAttribute("src");
    if (direct) return direct;
    const srcset = el.getAttribute("srcset") ?? el.parentElement?.querySelector("source")?.getAttribute("srcset") ?? "";
    if (!srcset) return "";
    let best = "";
    let bestW = -1;
    for (const cand of srcset.split(",")) {
      const [u, dRaw] = cand.trim().split(/\s+/);
      const w = /^(\d+)w$/.exec(dRaw ?? "") ? parseInt(dRaw, 10) : /^([\d.]+)x$/.exec(dRaw ?? "") ? parseFloat(dRaw) * 1000 : 0;
      if (u && w >= bestW) {
        best = u;
        bestW = w;
      }
    }
    return best;
  };

  /* ---------- признаки элементов ---------- */

  const shouldSkip = (el: Element, d: Decls): boolean => {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.getAttribute("aria-hidden") === "true" && el.children.length === 0 && !(el.textContent ?? "").trim()) return true;
    if (el.classList.contains("sr-only") || el.classList.contains("skip-link")) return true;
    // display:none — скрытые на десктопе элементы (мобильный гамбургер и т.п.)
    if ((d["display"] ?? "").trim() === "none") return true;
    if ((d["visibility"] ?? "").trim() === "hidden") return true;
    // элемент, уведённый за экран (частый приём для скрытых подписей)
    const left = d["left"];
    if ((d["position"] ?? "") === "fixed" && left && (evalLength(left, defaultCtx(vw, vh)) ?? 0) < -500) return true;
    return false;
  };

  /** Только строчные дети без собственной типографики → это один абзац. */
  const isSingleTextRun = (el: Element, d: Decls): boolean => {
    const disp = d["display"] ?? "";
    if (disp.includes("flex") || disp.includes("grid")) return false;
    const kids = Array.from(el.children);
    if (kids.length === 0) return true;
    if (!kids.every((k) => INLINE_TAGS.has(k.tagName))) return false;
    // если у строчного ребёнка есть свой шрифт/кегль/цвет — текст не однороден
    return kids.every((k) => {
      if (k.tagName === "BR") return true;
      const kd = computeDeclarations(k, index);
      return !(
        kd["font-family"] || kd["font-size"] || kd["font-weight"] || kd["color"] ||
        kd["text-transform"] || kd["letter-spacing"] || kd["background"] || kd["background-color"] ||
        kd["border"] || kd["padding"] || kd["display"]
      );
    });
  };

  /** Текст элемента с сохранением переносов `<br>`. */
  const textWithBreaks = (el: Element): string => {
    let out = "";
    el.childNodes.forEach((n) => {
      if (n.nodeType === 3) out += n.textContent ?? "";
      else if (n.nodeType === 1) {
        const child = n as Element;
        if (child.tagName === "BR") out += "\n";
        else out += textWithBreaks(child);
      }
    });
    return out.replace(/[ \t\r\f\v]+/g, " ").replace(/ *\n */g, "\n").trim();
  };

  /* ---------- обход ---------- */

  const walk = (el: Element, parentId: string, ctx: WalkCtx): void => {
    if (added > MAX_NODES) return;
    const d = declsFor(el, ctx);
    if (shouldSkip(el, d)) return;

    const lengthCtx = ctxFor(ctx.width, ctx.font);
    const vertCtx = vCtxFor(ctx.height, ctx.font);
    const inheritedColor = parseColor(ctx.inherited["color"])?.hex ?? null;
    const tag = el.tagName;

    /* --- сторонний виджет: плеер, карта, слайдер, комментарии ---
       Чужой инструмент не копируем: ставим на его место честный аналог
       из модели, чтобы раскладка не разъехалась и было видно, что тут было. */
    const widget: WidgetMatch | null =
      tag === "IFRAME" || tag === "EMBED" || tag === "OBJECT"
        ? matchByUrl(el.getAttribute("src") ?? el.getAttribute("data"))
        : tag === "VIDEO"
          ? { kind: "video", label: "Видео", provider: "file", ratio: 16 / 9 }
          : tag === "CANVAS"
            ? { kind: "embed", label: "Canvas-графика", ratio: 16 / 9, note: "рисование на canvas не переносится" }
            : matchBySignature(
                `${el.className} ${el.id} ${Array.from(el.attributes).map((a) => a.name).join(" ")}`,
              );

    if (widget) {
      const isVideo = widget.kind === "video" || widget.kind === "player";
      const node = createNode(isVideo ? "video" : "embed", widget.label);
      const src = el.getAttribute("src") ?? el.getAttribute("data") ?? el.querySelector("source")?.getAttribute("src") ?? "";
      if (src) node.src = resolveAssetPath(src, node.id);
      if (widget.provider) node.videoProvider = widget.provider;
      node.frameRatio = widget.ratio ?? 16 / 9;

      // размер берём из вёрстки, если задан: виджеты часто имеют свой блок
      const cssW = d["width"] ? evalLength(d["width"], lengthCtx) : null;
      const cssH = d["height"] ? evalLength(d["height"], vertCtx) : null;
      const attrW = parseFloat(el.getAttribute("width") ?? "");
      const attrH = parseFloat(el.getAttribute("height") ?? "");
      node.layout.width = cssW !== null && !/100%/.test(d["width"] ?? "") ? Math.round(cssW)
        : Number.isFinite(attrW) && !/100%/.test(d["width"] ?? "") ? Math.round(attrW) : "fill";
      if (cssH !== null) node.layout.height = Math.round(cssH);
      else if (Number.isFinite(attrH)) node.layout.height = Math.round(attrH);
      else node.layout.height = "hug";
      if (Number.isFinite(attrW) && Number.isFinite(attrH) && attrH > 0) node.frameRatio = attrW / attrH;

      applyBox(node, d, lengthCtx);
      applyCommon(node, el, d, lengthCtx, ctx.height);
      attach(node, parentId);
      widgetsFound.push(widget.note ? `${widget.label} — ${widget.note}` : widget.label);
      return;
    }

    /* --- картинка --- */
    if (tag === "IMG" || tag === "PICTURE") {
      const target = tag === "PICTURE" ? (el.querySelector("img") ?? el) : el;
      const src = bestSrc(target);
      const node = createNode("image", (src.split("/").pop() || "Картинка").slice(0, 40));
      node.src = src ? resolveAssetPath(src, node.id) : undefined;

      const wAttr = parseFloat(target.getAttribute("width") ?? "");
      const hAttr = parseFloat(target.getAttribute("height") ?? "");
      if (Number.isFinite(wAttr) && Number.isFinite(hAttr) && hAttr > 0) node.aspectRatio = wAttr / hAttr;

      const cssW = d["width"] ? evalLength(d["width"], lengthCtx) : null;
      // высота — по ВЕРТИКАЛЬНОЙ базе: `height:100%` это высота родителя
      const cssH = d["height"] ? evalLength(d["height"], vertCtx) : null;
      node.layout.width = /100%|auto/.test(d["width"] ?? "") || cssW === null ? "fill" : Math.round(cssW);
      if (cssH !== null && cssH > 0) node.layout.height = Math.round(cssH);
      else if (Number.isFinite(hAttr) && !Number.isFinite(wAttr)) node.layout.height = Math.round(hAttr);
      else node.layout.height = "hug";

      const fit = (d["object-fit"] ?? "").trim();
      if (fit === "cover" || fit === "contain" || fit === "fill") node.style.objectFit = fit;
      const radius = d["border-radius"];
      if (radius) node.style.radius = Math.round(evalLength(splitWords(radius)[0] ?? "", lengthCtx) ?? 0);

      applyCommon(node, target, d, lengthCtx, ctx.height);
      attach(node, parentId);
      return;
    }

    /* --- inline svg → картинка через data-URI (раньше просто выбрасывался) --- */
    if (tag === "SVG" || tag === "svg") {
      const markup = (el as unknown as { outerHTML?: string }).outerHTML ?? "";
      if (markup) {
        const node = createNode("image", "Иконка");
        node.src = `data:image/svg+xml;utf8,${encodeURIComponent(markup)}`;
        const wAttr = parseFloat(el.getAttribute("width") ?? "");
        const hAttr = parseFloat(el.getAttribute("height") ?? "");
        const vb = (el.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
        const ratio =
          Number.isFinite(wAttr) && Number.isFinite(hAttr) && hAttr > 0
            ? wAttr / hAttr
            : vb.length === 4 && vb[3] > 0
              ? vb[2] / vb[3]
              : 1;
        node.aspectRatio = ratio;
        const size = Number.isFinite(hAttr) ? hAttr : 24;
        node.layout.height = Math.round(size);
        node.layout.width = Math.round(size * ratio);
        applyCommon(node, el, d, lengthCtx, ctx.height);
        attach(node, parentId);
      }
      return;
    }

    /* --- поля формы --- */
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      const type = (el.getAttribute("type") ?? "").toLowerCase();
      if (type === "hidden") return;
      const node = createNode("input", `Поле ${el.getAttribute("name") ?? ""}`.trim());
      if (type === "checkbox" || type === "radio") {
        node.text = "";
        node.layout.width = 18;
        node.layout.height = 18;
        node.style.radius = type === "radio" ? 999 : 3;
      } else {
        node.text =
          el.getAttribute("placeholder") ??
          (tag === "SELECT" ? (el.querySelector("option")?.textContent ?? "Выбор") : "") ??
          "";
        node.layout.width = "fill";
        const cssH = d["height"] ? evalLength(d["height"], vertCtx) : null;
        node.layout.height = cssH ?? (tag === "TEXTAREA" ? 90 : 44);
      }
      applyTypography(node, d, lengthCtx, inheritedColor);
      applyBox(node, d, lengthCtx);
      applyCommon(node, el, d, lengthCtx, ctx.height);
      attach(node, parentId);
      return;
    }

    /* --- кнопка --- */
    const bgCol = parseColor(d["background-color"] ?? d["background"]);
    const looksButton =
      tag === "BUTTON" ||
      (tag === "A" &&
        (Array.from(el.classList).some((c) => /button|btn|cta/i.test(c)) ||
          (bgCol !== null && bgCol.alpha > 0) ||
          !!parseBorder(d["border"], lengthCtx)));
    if (looksButton) {
      const label = textWithBreaks(el).replace(/\n/g, " ");
      const node = createNode("button", label.slice(0, 24) || "Кнопка");
      node.text = label || "Кнопка";
      node.style.fill = bgCol && bgCol.alpha > 0 ? bgCol.hex : "transparent";
      if (bgCol && bgCol.alpha < 1 && bgCol.alpha > 0) node.style.fillAlpha = bgCol.alpha;
      node.style.textColor = parseColor(d["color"])?.hex ?? inheritedColor ?? "#ffffff";
      node.style.fontSize = Math.round(evalLength(d["font-size"] ?? "", lengthCtx) ?? 14);
      applyTypography(node, d, lengthCtx, inheritedColor);
      applyBox(node, d, lengthCtx);
      const minH = d["min-height"] ? evalLength(d["min-height"], lengthCtx) : null;
      if (minH) node.layout.height = Math.round(minH);
      const href = el.getAttribute("href");
      if (href) node.href = href;
      applyCommon(node, el, d, lengthCtx, ctx.height);
      attach(node, parentId);
      return;
    }

    /* --- текст ---
       ВАЖНО: в текстовую ветку заходим только если текст реально есть.
       Раньше пустой `<div class="hero-shade">` (градиентная шторка hero)
       считался «однородным текстовым прогоном», не находил текста и
       возвращался — узел не создавался вовсе, фон терялся. */
    const singleRun = isSingleTextRun(el, d);
    const runText = singleRun ? textWithBreaks(el) : "";
    if (singleRun && runText) {
      const text = runText;
      const node = createNode("text", tag);
      node.text = text;
      node.style.fontSize = HEAD_SIZES[tag] ?? (tag === "SMALL" || tag === "LABEL" ? 12 : 16);
      node.style.fontWeight = (tag === "H1" || tag === "H2" || tag === "STRONG" || tag === "B"
        ? 700
        : tag === "H3" || tag === "H4"
          ? 600
          : 400) as 400 | 500 | 600 | 700;
      node.style.textColor = "#121713";
      if (tag === "EM" || tag === "I") node.style.italic = true;
      applyTypography(node, d, lengthCtx, inheritedColor);
      applyBox(node, d, lengthCtx);

      const pad = resolvePadding(d, lengthCtx);
      if (pad.t || pad.r || pad.b || pad.l) node.layout.padding = packPadding(pad);

      const maxW = d["max-width"] ? evalLength(d["max-width"], lengthCtx) : null;
      if (maxW !== null && maxW > 0) node.layout.maxWidth = Math.round(maxW);
      const explicitW = d["width"] ? evalLength(d["width"], lengthCtx) : null;
      if (explicitW !== null && !/100%/.test(d["width"] ?? "")) node.layout.width = Math.round(explicitW);
      else if (ctx.parentIsGrid || ctx.parentDir === "column") node.layout.width = "fill";

      applyMargin(node, d, lengthCtx);

      const href = el.getAttribute("href");
      if (href) node.href = href;
      applyCommon(node, el, d, lengthCtx, ctx.height);
      attach(node, parentId);
      return;
    }

    /* --- контейнер --- */
    const disp = (d["display"] ?? "").trim();
    const isGrid = disp.includes("grid");
    const isFlex = disp.includes("flex");
    const node = createNode("container", (el.classList[0] || tag.toLowerCase()).slice(0, 40));

    const pad = resolvePadding(d, lengthCtx);
    node.layout.padding = packPadding(pad);

    const gaps = resolveGap(d, lengthCtx);
    node.layout.gap = isFlex || isGrid ? gaps.col : 0;
    if (isGrid && gaps.row !== gaps.col) node.layout.rowGap = gaps.row;

    // ширина: явная > 100%/fill > hug в строке
    const maxW = d["max-width"] ? evalLength(d["max-width"], lengthCtx) : null;
    if (maxW !== null && maxW > 0) node.layout.maxWidth = Math.round(maxW);
    const wRaw = d["width"] ?? "";
    const explicitW = wRaw && !/100%|auto/.test(wRaw) ? evalLength(wRaw, lengthCtx) : null;
    const wantsFill = /100%/.test(wRaw) || /(^|\s)1(\s|$)/.test(d["flex"] ?? "") || /^1\s/.test(d["flex"] ?? "");
    if (explicitW !== null) node.layout.width = Math.round(explicitW);
    else if (ctx.parentIsGrid) node.layout.width = "fill";
    else node.layout.width = ctx.parentDir === "row" && !wantsFill ? "hug" : "fill";

    applyMargin(node, d, lengthCtx);

    // высота: height/min-height как МИНИМУМ (решатель растит под контент)
    const hRaw = d["height"] ?? "";
    const minHRaw = d["min-height"] ?? "";
    let heightPx: number | null = null;
    if (hRaw && !/auto/.test(hRaw)) heightPx = evalLength(hRaw, vertCtx);
    if (heightPx === null && minHRaw) heightPx = evalLength(minHRaw, vertCtx);
    if (heightPx !== null && heightPx > 0) node.layout.height = Math.round(heightPx);

    // направление и сетка
    const tracks = isGrid ? parseGridTracks(d["grid-template-columns"], { ...lengthCtx, percentBase: ctx.width }) : null;
    if (tracks && tracks.length > 1) {
      node.layout.gridTracks = tracks;
      node.layout.direction = "row";
    } else {
      node.layout.direction =
        isFlex && !(d["flex-direction"] ?? "").includes("column")
          ? "row"
          : isGrid && !tracks
            ? "column"
            : isFlex
              ? "column"
              : singleRunChildren(el)
                ? "row" // строчный поток: `<p>текст <i>·</i> текст</p>`
                : "column";
      // в строчном потоке куски разделены пробелами исходника; в модели
      // пробел между узлами передать нечем, поэтому эмулируем его зазором
      if (node.layout.direction === "row" && !isFlex && !isGrid && singleRunChildren(el)) {
        node.layout.gap = Math.max(3, Math.round((node.style.fontSize || 16) * 0.28));
      }
    }

    const justifyRaw = (d["justify-content"] ?? "").trim();
    node.layout.justify =
      justifyRaw === "space-between" || justifyRaw === "space-around" || justifyRaw === "space-evenly"
        ? "between"
        : justifyRaw === "center"
          ? "center"
          : justifyRaw === "flex-end" || justifyRaw === "end" || justifyRaw === "right"
            ? "end"
            : "start";

    const alignRaw = (d["align-items"] ?? d["place-items"] ?? "").trim();
    node.layout.align =
      alignRaw === "center" || alignRaw === "baseline"
        ? "center"
        : alignRaw === "flex-end" || alignRaw === "end"
          ? "end"
          : "start";

    applyTypography(node, d, lengthCtx, inheritedColor);
    applyBox(node, d, lengthCtx);
    applyCommon(node, el, d, lengthCtx, ctx.height);
    attach(node, parentId);

    /* дети */
    const innerW = Math.max(
      40,
      Math.min(
        node.layout.maxWidth ?? Infinity,
        typeof node.layout.width === "number" ? node.layout.width : ctx.width,
      ) - pad.l - pad.r,
    );
    const innerH = typeof node.layout.height === "number" ? node.layout.height - pad.t - pad.b : null;
    const childCtx: WalkCtx = {
      inherited: { ...ctx.inherited, ...inheritFrom(d) },
      width: node.layout.gridTracks ? Math.round(innerW / node.layout.gridTracks.length) : innerW,
      height: innerH,
      font: node.style.fontSize || ctx.font,
      parentDir: node.layout.direction,
      parentIsGrid: !!node.layout.gridTracks,
    };
    /* ОДИН проход по childNodes — элементы и текстовые куски в исходном
       порядке. Раньше сначала обходились дети, а собственный текст элемента
       дописывался после них: `<p>Текст <i>·</i> ещё текст</p>` превращался
       в «Текст / ещё текст / ·» — порядок ломался. */
    for (const raw of Array.from(el.childNodes)) {
      if (raw.nodeType === 1) {
        walk(raw as Element, node.id, childCtx);
        continue;
      }
      if (raw.nodeType !== 3) continue;
      const chunk = (raw.textContent ?? "").replace(/\s+/g, " ");
      const text = chunk.trim();
      if (!text) continue;
      const tn = createNode("text", "Текст");
      tn.text = text;
      tn.style.fontSize = 16;
      applyTypography(tn, d, lengthCtx, inheritedColor);
      tn.layout.width = node.layout.direction === "row" ? "hug" : "fill";
      attach(tn, node.id);
    }

    /* пустышку удаляем — но только если она действительно ничего не несёт.
       Раньше проверялся лишь fill, и градиентные шторки (`.hero-shade`)
       пропадали вместе с фото-подложками. */
    const carriesVisual =
      node.style.fill !== "transparent" ||
      !!node.style.backgroundImage ||
      !!node.style.backgroundGradient ||
      !!node.style.borderWidth ||
      typeof node.layout.height === "number";
    if (node.children.length === 0 && !carriesVisual) {
      doc.nodes[parentId]!.children = doc.nodes[parentId]!.children.filter((c) => c !== node.id);
      delete doc.nodes[node.id];
      added -= 1;
    }
  };

  /**
   * Строчный ли поток внутри элемента.
   *
   * Два условия, без которых модель врёт:
   *  - `<br>` разрывает строку, значит поток уже НЕ горизонтальный
   *    (`<h2>One ball.<br><em>Two to three years.</em></h2>` — две строки,
   *    а не две колонки);
   *  - ребёнок с `display:block` тоже встаёт на свою строку
   *    (`.atelier-facts strong{display:block}`).
   */
  function singleRunChildren(el: Element): boolean {
    const kids = Array.from(el.children);
    if (kids.length === 0) return false;
    if (!kids.every((k) => INLINE_TAGS.has(k.tagName))) return false;
    if (kids.some((k) => k.tagName === "BR")) return false;
    return !kids.some((k) => {
      const disp = (computeDeclarations(k, index)["display"] ?? "").trim();
      return disp === "block" || disp.includes("flex") || disp.includes("grid");
    });
  }

  /* ---------- страница ---------- */
  const body = parsed.body;
  const bodyDecls = body ? declsFor(body, {
    inherited: {}, width: vw, height: null, font: rootFont, parentDir: "column", parentIsGrid: false,
  }) : {};
  const bodyBg = parseColor(bodyDecls["background-color"] ?? bodyDecls["background"]);
  const bodyColor = parseColor(bodyDecls["color"]);
  const bodyFont = normalizeFontFamily(bodyDecls["font-family"]);
  const bodyFontSize = evalLength(bodyDecls["font-size"] ?? "", defaultCtx(vw, vh)) ?? 16;

  const frame = createNode("frame", opts.pageName);
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
  // ШИРИНА СТРАНИЦЫ — это вьюпорт импорта, а не зашитая константа 1200
  frame.layout.width = vw;
  frame.layout.height = "hug";
  frame.layout.padding = 0;
  frame.style.fill = bodyBg && bodyBg.alpha > 0 ? bodyBg.hex : "#ffffff";
  if (bodyFont) {
    frame.style.fontFamily = bodyFont;
    fontFamilies.add(bodyFont);
  }
  frame.parent = null;
  doc.nodes[frame.id] = frame;
  doc.rootFrames.push(frame.id);
  added += 1;

  const rootCtx: WalkCtx = {
    inherited: inheritFrom(bodyDecls),
    width: vw,
    height: null,
    font: Math.round(bodyFontSize),
    parentDir: "column",
    parentIsGrid: false,
  };
  if (bodyColor) rootCtx.inherited["color"] = bodyColor.hex;

  if (body) for (const child of Array.from(body.children)) walk(child, frame.id, rootCtx);

  /* ---------- предупреждения и шрифты ---------- */
  if (added >= MAX_NODES) warnings.push(`страница усечена до ${MAX_NODES} узлов`);
  if (sheet.rules.length === 0) warnings.push("CSS не найден — проверь, что styles.css лежит рядом с html");
  if (sheet.skippedMedia > 0) warnings.push(`медиазапросов не под вьюпорт ${vw}px: ${sheet.skippedMedia}`);

  const fontLinks: string[] = [...sheet.imports];
  for (const face of sheet.fontFaces) {
    const url = extractUrl(face.src);
    if (url) fontLinks.push(url);
  }

  /* Диагностика источника: без неё импорт SPA выглядит как баг приложения,
     хотя перенесено всё, что прислал сервер. */
  const source = analyzeSource(opts.html);
  if (source.kind !== "static") {
    warnings.push(source.advice);
    for (const m of source.markers.slice(0, 3)) warnings.push(m);
    for (const st of source.embeddedState) {
      warnings.push(`встроенные данные ${st.name}: ${st.kilobytes} КБ — контент есть, но в виде JSON, а не разметки`);
    }
  }

  return {
    frameId: frame.id,
    nodesAdded: added,
    warnings,
    imagesToCopy,
    fontLinks,
    fontFamilies: [...fontFamilies],
    source,
    widgets: [...new Set(widgetsFound)],
  };
}

/** Стороны отступов — реэкспорт для потребителей импорта. */
export type { Sides };

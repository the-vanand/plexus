/**
 * CSS: РАСКРЫТИЕ ШОРТКАТОВ И СОСТАВНЫХ ЗНАЧЕНИЙ.
 *
 * На реальном сайте COSPEX вертикальный ритм задан ЛОНГХЕНДАМИ
 * (`padding-top:120px`), а горизонтальные поля — `padding-left:8vw`.
 * Прошлая версия читала только шорткат `padding`, поэтому отступы выходили
 * нулевыми, а `pxPad` вдобавок брал максимум из сторон с потолком 100px.
 * Здесь стороны считаются честно и по отдельности.
 */
import type { GridTrack, Sides } from "../types";
import { evalLength, splitWords, type LengthCtx } from "./values";

export type { GridTrack, Sides };

export const zeroSides = (): Sides => ({ t: 0, r: 0, b: 0, l: 0 });
export const uniformSides = (n: number): Sides => ({ t: n, r: n, b: n, l: n });
export const isUniform = (s: Sides): boolean => s.t === s.r && s.r === s.b && s.b === s.l;

/** Раскрывает `10px`, `10px 20px`, `10px 20px 30px`, `10px 20px 30px 40px`. */
function expandBox(value: string, ctx: LengthCtx): Partial<Sides> {
  const parts = splitWords(value);
  const n = parts.map((p) => evalLength(p, ctx));
  const at = (i: number) => n[i] ?? 0;
  switch (parts.length) {
    case 1:
      return { t: at(0), r: at(0), b: at(0), l: at(0) };
    case 2:
      return { t: at(0), r: at(1), b: at(0), l: at(1) };
    case 3:
      return { t: at(0), r: at(1), b: at(2), l: at(1) };
    default:
      return { t: at(0), r: at(1), b: at(2), l: at(3) };
  }
}

/**
 * Собирает padding из шортката и лонгхендов.
 * Лонгхенд всегда сильнее шортката — он идёт в каскаде позже
 * (`computeDeclarations` уже разрешил порядок, здесь просто накладываем).
 */
export function resolvePadding(d: Record<string, string>, ctx: LengthCtx): Sides {
  const out = zeroSides();
  if (d["padding"]) Object.assign(out, expandBox(d["padding"], ctx));
  const one = (prop: string, key: keyof Sides) => {
    const v = d[`padding-${prop}`];
    if (v === undefined) return;
    const px = evalLength(v, ctx);
    if (px !== null) out[key] = px;
  };
  one("top", "t");
  one("right", "r");
  one("bottom", "b");
  one("left", "l");
  // логические свойства
  const block = d["padding-block"];
  if (block) {
    const p = expandBox(block, ctx);
    out.t = p.t ?? out.t;
    out.b = p.b ?? p.t ?? out.b;
  }
  const inline = d["padding-inline"];
  if (inline) {
    const parts = splitWords(inline);
    const a = evalLength(parts[0] ?? "0", ctx) ?? 0;
    const b = parts[1] !== undefined ? (evalLength(parts[1], ctx) ?? a) : a;
    out.l = a;
    out.r = b;
  }
  if (d["padding-block-start"]) out.t = evalLength(d["padding-block-start"], ctx) ?? out.t;
  if (d["padding-block-end"]) out.b = evalLength(d["padding-block-end"], ctx) ?? out.b;
  if (d["padding-inline-start"]) out.l = evalLength(d["padding-inline-start"], ctx) ?? out.l;
  if (d["padding-inline-end"]) out.r = evalLength(d["padding-inline-end"], ctx) ?? out.r;
  return roundSides(out);
}

/** Маргины. `auto` возвращается как null — это признак центрирования. */
export interface Margins {
  t: number;
  b: number;
  l: number | "auto";
  r: number | "auto";
}

export function resolveMargin(d: Record<string, string>, ctx: LengthCtx): Margins {
  const out: Margins = { t: 0, b: 0, l: 0, r: 0 };
  const put = (raw: string | undefined, keys: Array<keyof Margins>) => {
    if (raw === undefined) return;
    const parts = splitWords(raw);
    const vals = parts.map((p) => (p === "auto" ? ("auto" as const) : (evalLength(p, ctx) ?? 0)));
    const pick = (i: number) => vals[Math.min(i, vals.length - 1)];
    if (keys.length === 4) {
      const [t, r, b, l] =
        vals.length === 1 ? [pick(0), pick(0), pick(0), pick(0)]
        : vals.length === 2 ? [pick(0), pick(1), pick(0), pick(1)]
        : vals.length === 3 ? [pick(0), pick(1), pick(2), pick(1)]
        : [pick(0), pick(1), pick(2), pick(3)];
      out.t = typeof t === "number" ? t : 0;
      out.r = r;
      out.b = typeof b === "number" ? b : 0;
      out.l = l;
    } else {
      keys.forEach((k, i) => {
        const v = pick(i);
        if (k === "l" || k === "r") out[k] = v;
        else out[k] = typeof v === "number" ? v : 0;
      });
    }
  };
  put(d["margin"], ["t", "r", "b", "l"]);
  if (d["margin-inline"]) put(d["margin-inline"], ["l", "r"]);
  if (d["margin-block"]) put(d["margin-block"], ["t", "b"]);
  if (d["margin-top"]) out.t = evalLength(d["margin-top"], ctx) ?? 0;
  if (d["margin-bottom"]) out.b = evalLength(d["margin-bottom"], ctx) ?? 0;
  if (d["margin-left"]) out.l = d["margin-left"].trim() === "auto" ? "auto" : (evalLength(d["margin-left"], ctx) ?? 0);
  if (d["margin-right"]) out.r = d["margin-right"].trim() === "auto" ? "auto" : (evalLength(d["margin-right"], ctx) ?? 0);
  return out;
}

/** `inset: 0` / `inset: 20px 40px` → стороны; отсутствующая сторона = null. */
export interface Inset {
  top: number | null;
  right: number | null;
  bottom: number | null;
  left: number | null;
}

export function resolveInset(d: Record<string, string>, ctx: LengthCtx): Inset {
  const out: Inset = { top: null, right: null, bottom: null, left: null };
  if (d["inset"]) {
    const box = expandBox(d["inset"], ctx);
    out.top = box.t ?? null;
    out.right = box.r ?? null;
    out.bottom = box.b ?? null;
    out.left = box.l ?? null;
  }
  const one = (prop: "top" | "right" | "bottom" | "left") => {
    const v = d[prop];
    if (v === undefined || v.trim() === "auto") return;
    const px = evalLength(v, ctx);
    if (px !== null) out[prop] = px;
  };
  one("top");
  one("right");
  one("bottom");
  one("left");
  return out;
}

/** Толщина и цвет рамки из шортката `1px solid rgba(...)`. */
export interface BorderSpec {
  width: number;
  color: string | null;
  style: string;
}

export function parseBorder(value: string | undefined, ctx: LengthCtx): BorderSpec | null {
  if (!value) return null;
  const v = value.trim();
  if (!v || /^(none|0)$/i.test(v) || /\bnone\b/i.test(v)) return null;
  const words = splitWords(v);
  let width = 1;
  let style = "solid";
  let color: string | null = null;
  for (const w of words) {
    if (/^(solid|dashed|dotted|double|groove|ridge|inset|outset)$/i.test(w)) {
      style = w.toLowerCase();
      continue;
    }
    const len = evalLength(w, ctx);
    if (len !== null && /^[\d.]/.test(w)) {
      width = len;
      continue;
    }
    if (/^(thin|medium|thick)$/i.test(w)) {
      width = { thin: 1, medium: 3, thick: 5 }[w.toLowerCase() as "thin"] ?? 1;
      continue;
    }
    color = w;
  }
  if (width === 0) return null;
  return { width, color, style };
}

/**
 * Шорткат `font: italic 700 15px/1.4 Georgia, serif`.
 * Раньше вытаскивались только стиль/вес/кегль — СЕМЕЙСТВО терялось,
 * а именно им сайт задаёт шрифт полей формы и подвала (`font:38px var(--serif)`).
 */
export interface FontShorthand {
  style?: string;
  weight?: string;
  size?: string;
  lineHeight?: string;
  family?: string;
}

export function parseFontShorthand(value: string): FontShorthand {
  const out: FontShorthand = {};
  const v = value.trim();
  if (!v || /^(inherit|initial|unset|caption|icon|menu|status-bar)$/i.test(v)) return out;

  // размер[/межстрочный] — точка разделения шортката
  const m = /(^|\s)((?:\d+\.?\d*|\.\d+)(?:px|pt|em|rem|%)|x{0,2}(?:small|large)|medium)(\s*\/\s*([^\s]+))?\s+(.+)$/i.exec(v);
  if (!m) {
    // без размера — это не шорткат font, а что-то вроде `font: inherit`
    return out;
  }
  const before = v.slice(0, m.index).trim();
  out.size = m[2];
  if (m[4]) out.lineHeight = m[4];
  out.family = m[5].trim();

  for (const w of splitWords(before)) {
    if (/^(italic|oblique)$/i.test(w)) out.style = "italic";
    else if (/^(bold|bolder|lighter|[1-9]00)$/i.test(w)) out.weight = w;
    else if (/^(small-caps)$/i.test(w)) continue;
  }
  return out;
}

/** Первое реальное семейство из списка `Georgia,'Times New Roman',serif`. */
export function normalizeFontFamily(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (!v || /^(inherit|initial|unset)$/i.test(v)) return undefined;
  // список сохраняем целиком: Pixi и браузер сами возьмут первый доступный,
  // а фоллбэки — часть замысла автора сайта
  return v.replace(/\s*,\s*/g, ", ");
}

/* ------------------------------------------------------------------ */
/* Grid                                                                */
/* ------------------------------------------------------------------ */

/**
 * `grid-template-columns` → дорожки.
 * Поддержано: `repeat(3,1fr)`, `1.5fr 1fr`, `48px 1fr`,
 * `repeat(auto-fit,minmax(280px,1fr))`, проценты.
 */
export function parseGridTracks(value: string | undefined, ctx: LengthCtx): GridTrack[] | null {
  if (!value) return null;
  const v = value.trim();
  if (!v || /^(none|auto)$/i.test(v)) return null;

  const tracks: GridTrack[] = [];
  const pushToken = (token: string): void => {
    const t = token.trim();
    if (!t) return;

    const rep = /^repeat\(\s*([^,]+)\s*,\s*(.+)\)$/i.exec(t);
    if (rep) {
      const countRaw = rep[1].trim();
      const inner = rep[2].trim();
      if (/^(auto-fit|auto-fill)$/i.test(countRaw)) {
        // сколько колонок влезет по минимальной ширине из minmax
        const mm = /minmax\(\s*([^,]+),/i.exec(inner);
        const min = mm ? (evalLength(mm[1].trim(), ctx) ?? 240) : 240;
        const base = ctx.percentBase ?? ctx.vw;
        const fit = Math.max(1, Math.floor(base / Math.max(60, min)));
        for (let i = 0; i < fit; i++) pushToken(inner);
        return;
      }
      const count = Math.min(24, Math.max(1, parseInt(countRaw, 10) || 1));
      for (let i = 0; i < count; i++) pushToken(inner);
      return;
    }

    const mm = /^minmax\(\s*([^,]+),\s*(.+)\)$/i.exec(t);
    if (mm) {
      pushToken(mm[2].trim());
      return;
    }
    if (/^(min|max)-content$|^auto$|^fit-content/i.test(t)) {
      tracks.push({ fr: 1 });
      return;
    }
    const fr = /^([\d.]+)fr$/i.exec(t);
    if (fr) {
      tracks.push({ fr: parseFloat(fr[1]) });
      return;
    }
    const px = evalLength(t, ctx);
    if (px !== null) tracks.push({ px });
    else tracks.push({ fr: 1 });
  };

  for (const token of splitWords(v.replace(/\[[^\]]*\]/g, " "))) pushToken(token);
  return tracks.length > 0 ? tracks : null;
}

/** `grid-column: 1 / -1` → сколько колонок занимает элемент ("full" — все). */
export function parseGridSpan(d: Record<string, string>): number | "full" | null {
  const raw = d["grid-column"] ?? d["grid-column-start"];
  if (!raw) return null;
  const v = raw.trim();
  if (/1\s*\/\s*-1/.test(v) || /^span\s+all$/i.test(v)) return "full";
  const span = /span\s+(\d+)/i.exec(v);
  if (span) return Math.max(1, parseInt(span[1], 10));
  const range = /^(\d+)\s*\/\s*(\d+)$/.exec(v);
  if (range) return Math.max(1, parseInt(range[2], 10) - parseInt(range[1], 10));
  return null;
}

/** `gap: 25px 22px` → { row, col }. */
export function resolveGap(d: Record<string, string>, ctx: LengthCtx): { row: number; col: number } {
  const raw = d["gap"] ?? d["grid-gap"];
  let row = 0;
  let col = 0;
  if (raw) {
    const parts = splitWords(raw);
    row = evalLength(parts[0] ?? "0", ctx) ?? 0;
    col = parts[1] !== undefined ? (evalLength(parts[1], ctx) ?? row) : row;
  }
  const rg = d["row-gap"] ?? d["grid-row-gap"];
  const cg = d["column-gap"] ?? d["grid-column-gap"];
  if (rg) row = evalLength(rg, ctx) ?? row;
  if (cg) col = evalLength(cg, ctx) ?? col;
  return { row: Math.round(row), col: Math.round(col) };
}

const roundSides = (s: Sides): Sides => ({
  t: Math.round(s.t),
  r: Math.round(s.r),
  b: Math.round(s.b),
  l: Math.round(s.l),
});

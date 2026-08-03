/**
 * CSS: РАЗБОР И ВЫЧИСЛЕНИЕ ЗНАЧЕНИЙ.
 *
 * Почему отдельный модуль: раньше значения выковыривались регекспами прямо
 * в импортёре, и на реальном сайте это ломалось на каждом шагу —
 * `clamp(55px,7vw,108px)` давал 55, `100svh` давал 100 пикселей,
 * `url(data:image/svg+xml;base64,…)` рвал разбор деклараций по `;`.
 *
 * Здесь честный разбор: скобки и кавычки уважаются, единицы считаются от
 * настоящего вьюпорта, поддержаны var/calc/clamp/min/max.
 *
 * Модуль чистый: ни DOM, ни Pixi, ни React.
 */

export interface LengthCtx {
  /** Ширина вьюпорта в px — база для vw/vmin/vmax и процентов верхнего уровня. */
  vw: number;
  /** Высота вьюпорта в px — база для vh/svh/lvh/dvh. */
  vh: number;
  /** font-size корня (html) — база для rem. */
  rootFont: number;
  /** font-size текущего элемента/родителя — база для em. */
  parentFont: number;
  /** База для процентов (обычно ширина контейнера). null — проценты неразрешимы. */
  percentBase: number | null;
}

export const defaultCtx = (vw = 1440, vh = 900): LengthCtx => ({
  vw,
  vh,
  rootFont: 16,
  parentFont: 16,
  percentBase: null,
});

/* ------------------------------------------------------------------ */
/* Разбиение с учётом скобок и кавычек                                 */
/* ------------------------------------------------------------------ */

/**
 * Делит строку по разделителю ВЕРХНЕГО уровня: то, что внутри (), '' и "",
 * не режется. Без этого `font-family:'A', "B"` и `rgba(0,0,0,.5)`
 * разваливаются.
 */
export function splitTop(input: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      cur += ch;
      if (ch === quote && input[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Разбивает на слова по пробелам верхнего уровня (`0 8vw` → ["0","8vw"]). */
export function splitWords(input: string): string[] {
  return splitTop(input.trim().replace(/\s+/g, " "), " ")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Разбор тела правила в набор деклараций.
 * Режет по `;` верхнего уровня — поэтому `url(data:…;base64,…)` цел.
 * Последнее объявление свойства побеждает (как в CSS).
 */
export function parseDeclarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const chunk of splitTop(body, ";")) {
    const s = chunk.trim();
    if (!s) continue;
    const colon = indexOfTop(s, ":");
    if (colon <= 0) continue;
    const prop = s.slice(0, colon).trim().toLowerCase();
    let value = s.slice(colon + 1).trim();
    if (!prop || !value) continue;
    // !important не меняет наш порядок разрешения — просто снимаем маркер
    const bang = /\s*!\s*important\s*$/i;
    const important = bang.test(value);
    value = value.replace(bang, "").trim();
    out[prop] = value;
    if (important) out[`${prop}!`] = "1";
  }
  return out;
}

/** Индекс первого символа на верхнем уровне вложенности. */
function indexOfTop(input: string, ch: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote && input[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* var()                                                               */
/* ------------------------------------------------------------------ */

/**
 * Раскрывает var(--name, fallback) рекурсивно.
 * Циклы обрываются глубиной — переменная, ссылающаяся на себя, отдаст "".
 */
export function resolveVars(value: string, vars: Map<string, string>, depth = 0): string {
  if (depth > 8 || !value.includes("var(")) return value;
  let out = "";
  let i = 0;
  while (i < value.length) {
    const at = value.indexOf("var(", i);
    if (at === -1) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, at);
    // находим парную скобку
    let depthP = 0;
    let j = at + 3;
    for (; j < value.length; j++) {
      if (value[j] === "(") depthP++;
      else if (value[j] === ")") {
        depthP--;
        if (depthP === 0) break;
      }
    }
    const inner = value.slice(at + 4, j);
    const parts = splitTop(inner, ",");
    const name = parts[0].trim().replace(/^--/, "");
    const fallback = parts.slice(1).join(",").trim();
    const got = vars.get(name);
    out += resolveVars(got !== undefined ? got : fallback, vars, depth + 1);
    i = j + 1;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Длины                                                               */
/* ------------------------------------------------------------------ */

const UNIT_RE = /^(-?(?:\d+\.?\d*|\.\d+))(px|pt|pc|in|cm|mm|q|em|rem|ex|ch|vw|vh|svh|lvh|dvh|svw|lvw|dvw|vmin|vmax|%)?$/i;

/** Одна длина без функций. null — не длина (auto, inherit, слово). */
function rawLength(token: string, ctx: LengthCtx): number | null {
  const t = token.trim();
  if (t === "0") return 0;
  const m = UNIT_RE.exec(t);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] ?? "px").toLowerCase();
  switch (unit) {
    case "px":
      return n;
    case "pt":
      return (n * 96) / 72;
    case "pc":
      return (n * 96) / 6;
    case "in":
      return n * 96;
    case "cm":
      return (n * 96) / 2.54;
    case "mm":
      return (n * 96) / 25.4;
    case "q":
      return (n * 96) / 101.6;
    case "em":
      return n * ctx.parentFont;
    case "rem":
      return n * ctx.rootFont;
    case "ex":
      return n * ctx.parentFont * 0.5;
    case "ch":
      return n * ctx.parentFont * 0.5;
    case "vw":
    case "svw":
    case "lvw":
    case "dvw":
      return (n * ctx.vw) / 100;
    // svh/lvh/dvh — «маленький/большой/динамический» вьюпорт мобильных браузеров.
    // На десктопе все три равны vh. Раньше `100svh` читался как 100px — из-за
    // этого hero сайта COSPEX схлопывался в полоску высотой 100 пикселей.
    case "vh":
    case "svh":
    case "lvh":
    case "dvh":
      return (n * ctx.vh) / 100;
    case "vmin":
      return (n * Math.min(ctx.vw, ctx.vh)) / 100;
    case "vmax":
      return (n * Math.max(ctx.vw, ctx.vh)) / 100;
    case "%":
      return ctx.percentBase === null ? null : (n * ctx.percentBase) / 100;
    default:
      return null;
  }
}

/**
 * Вычисляет длину: поддержаны calc(), clamp(), min(), max() и вложенность.
 * Возвращает null, если значение не длина (auto, none, слово).
 */
export function evalLength(value: string, ctx: LengthCtx): number | null {
  const v = value.trim();
  if (!v) return null;

  const fn = /^(calc|clamp|min|max)\(/i.exec(v);
  if (fn) {
    const inner = v.slice(fn[0].length, v.lastIndexOf(")"));
    const name = fn[1].toLowerCase();
    if (name === "calc") return evalCalc(inner, ctx);
    const args = splitTop(inner, ",").map((a) => evalLength(a.trim(), ctx));
    if (args.some((a) => a === null)) return null;
    const nums = args as number[];
    if (name === "min") return Math.min(...nums);
    if (name === "max") return Math.max(...nums);
    // clamp(min, preferred, max) — ровно то, чем сайты задают адаптивный кегль
    if (nums.length === 3) return Math.min(Math.max(nums[1], nums[0]), nums[2]);
    return nums[0] ?? null;
  }

  return rawLength(v, ctx);
}

/** Минимальный вычислитель арифметики calc() c приоритетом операций. */
function evalCalc(expr: string, ctx: LengthCtx): number | null {
  const tokens: Array<number | string> = [];
  let i = 0;
  const s = expr.trim();
  while (i < s.length) {
    const ch = s[i];
    if (ch === " ") {
      i++;
      continue;
    }
    if (ch === "(") {
      let depth = 0;
      let j = i;
      for (; j < s.length; j++) {
        if (s[j] === "(") depth++;
        else if (s[j] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      const val = evalCalc(s.slice(i + 1, j), ctx);
      if (val === null) return null;
      tokens.push(val);
      i = j + 1;
      continue;
    }
    if ("+-*/".includes(ch)) {
      // минус может быть знаком числа: `calc(-2px + 1em)`
      const prev = tokens[tokens.length - 1];
      if ((ch === "-" || ch === "+") && (tokens.length === 0 || typeof prev === "string")) {
        // знак — прилипает к следующему токену
        const rest = s.slice(i);
        const m = /^[+-]\s*[\d.]+[a-z%]*/i.exec(rest);
        if (m) {
          const val = evalLengthOrNested(m[0].replace(/\s+/g, ""), ctx);
          if (val === null) return null;
          tokens.push(val);
          i += m[0].length;
          continue;
        }
      }
      tokens.push(ch);
      i++;
      continue;
    }
    const m = /^[^\s+*/)]+/.exec(s.slice(i));
    if (!m) return null;
    const val = evalLengthOrNested(m[0], ctx);
    if (val === null) return null;
    tokens.push(val);
    i += m[0].length;
  }

  // * и / вперёд
  for (let k = 1; k < tokens.length - 1; ) {
    const op = tokens[k];
    if (op === "*" || op === "/") {
      const a = tokens[k - 1] as number;
      const b = tokens[k + 1] as number;
      if (typeof a !== "number" || typeof b !== "number") return null;
      tokens.splice(k - 1, 3, op === "*" ? a * b : b === 0 ? 0 : a / b);
      k = Math.max(1, k - 2);
    } else k += 2;
  }
  let acc = tokens[0];
  if (typeof acc !== "number") return null;
  for (let k = 1; k < tokens.length - 1; k += 2) {
    const op = tokens[k];
    const b = tokens[k + 1];
    if (typeof b !== "number") return null;
    acc = op === "+" ? acc + b : op === "-" ? acc - b : acc;
  }
  return typeof acc === "number" ? acc : null;
}

function evalLengthOrNested(token: string, ctx: LengthCtx): number | null {
  if (/^(calc|clamp|min|max)\(/i.test(token)) return evalLength(token, ctx);
  const bare = /^-?[\d.]+$/.test(token) ? parseFloat(token) : null;
  if (bare !== null) return bare; // безразмерный множитель внутри calc
  return rawLength(token, ctx);
}

/* ------------------------------------------------------------------ */
/* Цвета                                                               */
/* ------------------------------------------------------------------ */

export interface Rgba {
  hex: string;
  alpha: number;
}

const NAMED: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff",
  gray: "#808080", grey: "#808080", silver: "#c0c0c0", maroon: "#800000", olive: "#808000",
  lime: "#00ff00", aqua: "#00ffff", cyan: "#00ffff", teal: "#008080", navy: "#000080",
  fuchsia: "#ff00ff", magenta: "#ff00ff", purple: "#800080", yellow: "#ffff00", orange: "#ffa500",
  beige: "#f5f5dc", ivory: "#fffff0", tan: "#d2b48c", brown: "#a52a2a", gold: "#ffd700",
};

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
const hex2 = (n: number) => clamp255(n).toString(16).padStart(2, "0");

/**
 * Разбирает цвет в hex + альфу. Альфа сохраняется отдельно: на холсте она
 * нужна для полупрозрачных шапок (`rgba(7,26,21,.96)`), а раньше отбрасывалась.
 */
export function parseColor(value: string | undefined): Rgba | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (!v || v === "transparent") return v === "transparent" ? { hex: "#000000", alpha: 0 } : null;
  if (v === "currentcolor" || v === "inherit" || v === "initial" || v === "unset") return null;

  if (NAMED[v]) return { hex: NAMED[v], alpha: 1 };

  const hex = /^#([0-9a-f]{3,8})$/i.exec(v);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = h.split("");
      return { hex: `#${r}${r}${g}${g}${b}${b}`, alpha: a ? parseInt(a + a, 16) / 255 : 1 };
    }
    if (h.length === 6) return { hex: `#${h}`, alpha: 1 };
    if (h.length === 8) return { hex: `#${h.slice(0, 6)}`, alpha: parseInt(h.slice(6, 8), 16) / 255 };
  }

  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/i.exec(v);
  if (fn) {
    const parts = splitTop(fn[2].replace(/\//g, ","), ",").map((p) => p.trim()).filter(Boolean);
    const num = (s: string, base: number) => (s.endsWith("%") ? (parseFloat(s) / 100) * base : parseFloat(s));
    const alpha = parts[3] !== undefined ? Math.max(0, Math.min(1, num(parts[3], 1))) : 1;
    if (/^rgb/i.test(fn[1])) {
      return { hex: `#${hex2(num(parts[0], 255))}${hex2(num(parts[1], 255))}${hex2(num(parts[2], 255))}`, alpha };
    }
    const h = ((parseFloat(parts[0]) % 360) + 360) % 360;
    const s = num(parts[1], 1) > 1 ? num(parts[1], 1) / 100 : num(parts[1], 1);
    const l = num(parts[2], 1) > 1 ? num(parts[2], 1) / 100 : num(parts[2], 1);
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const seg = Math.floor(h / 60) % 6;
    const [r, g, b] = [
      [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
    ][seg];
    return { hex: `#${hex2((r + m) * 255)}${hex2((g + m) * 255)}${hex2((b + m) * 255)}`, alpha };
  }
  return null;
}

/**
 * Приблизительный «средний» цвет градиента — чтобы на холсте блок не был
 * дырой. Точный градиент уносится в кодоген как есть.
 */
export function averageGradientColor(value: string): Rgba | null {
  const stops = [...value.matchAll(/(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))/gi)]
    .map((m) => parseColor(m[1]))
    .filter((c): c is Rgba => c !== null);
  if (stops.length === 0) return null;
  let r = 0, g = 0, b = 0, a = 0;
  for (const s of stops) {
    r += parseInt(s.hex.slice(1, 3), 16);
    g += parseInt(s.hex.slice(3, 5), 16);
    b += parseInt(s.hex.slice(5, 7), 16);
    a += s.alpha;
  }
  const n = stops.length;
  return { hex: `#${hex2(r / n)}${hex2(g / n)}${hex2(b / n)}`, alpha: a / n };
}

/** Вытаскивает url(...) из значения background/background-image. */
export function extractUrl(value: string | undefined): string | null {
  if (!value) return null;
  const m = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/i.exec(value);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? "").trim() || null;
}

/** Есть ли в значении градиент. */
export const hasGradient = (value: string | undefined): boolean =>
  !!value && /(linear|radial|conic)-gradient\(/i.test(value);

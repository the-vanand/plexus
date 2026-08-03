/**
 * CSS: ПРАВИЛА, СПЕЦИФИЧНОСТЬ, КАСКАД.
 *
 * Ключевое решение: селекторы сопоставляем РОДНЫМ `element.matches()`
 * движка браузера. Самописный матчер всегда врёт на `:not()`, `:nth-child`,
 * `>`/`+`/`~` и атрибутных селекторах — а у реальных сайтов на них висит
 * половина типографики. Наш код отвечает только за три вещи, которые
 * `matches()` не даёт: специфичность, порядок правил и вычисление значений.
 *
 * Ошибка прошлой версии, которую здесь чиним: декларации накапливались
 * по принципу «первое побеждает» (`if (!(k in d))`). В CSS всё наоборот —
 * побеждает последнее правило при равной специфичности. Поэтому любой
 * оверрайд ниже по файлу молча терялся.
 */
import { parseDeclarations, splitTop } from "./values";

export interface CssRule {
  selector: string;
  decls: Record<string, string>;
  /** Специфичность (a,b,c) — id / класс+атрибут+псевдокласс / тег. */
  spec: readonly [number, number, number];
  /** Порядок в исходнике — разрешает ничьи по специфичности. */
  order: number;
  /** Ключ для быстрой выборки кандидатов: последний класс или тег. */
  key: string | null;
}

export interface Stylesheet {
  rules: CssRule[];
  /** Переменные :root (и любые --*, объявленные глобально). */
  vars: Map<string, string>;
  /** @font-face: семейство → src. Нужно, чтобы шрифт реально подгрузился. */
  fontFaces: Array<{ family: string; src: string; weight?: string; style?: string }>;
  /** @import url(...) — обычно Google Fonts. */
  imports: string[];
  /** Медиазапросы, которые НЕ подошли под вьюпорт (для отчёта). */
  skippedMedia: number;
}

export interface MediaCtx {
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ */
/* Специфичность                                                       */
/* ------------------------------------------------------------------ */

/** Псевдоклассы, которые не влияют на статичный импорт (динамические состояния). */
const DYNAMIC_PSEUDO = /:(hover|focus|focus-within|focus-visible|active|visited|target|checked|disabled|enabled|placeholder-shown|autofill)\b/i;
/** Псевдоэлементы: декоративные, отдельного узла не создаём. */
const PSEUDO_ELEMENT = /::?(before|after|first-line|first-letter|selection|placeholder|marker|backdrop)\b/i;

export function specificity(selector: string): readonly [number, number, number] {
  let s = selector;
  // :not(...)/:is(...)/:where(...) — считаем по самому весомому аргументу.
  // Упрощение допустимое: полный алгоритм тут ничего не меняет на практике.
  let inner = 0;
  s = s.replace(/:(not|is|matches)\(([^()]*)\)/gi, (_m, _fn, arg: string) => {
    const parts = splitTop(arg, ",").map((p) => specificity(p.trim()));
    for (const p of parts) inner = Math.max(inner, p[1]);
    return " ";
  });
  s = s.replace(/:where\([^()]*\)/gi, " ");

  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes =
    (s.match(/\.[\w-]+/g) ?? []).length +
    (s.match(/\[[^\]]*\]/g) ?? []).length +
    (s.match(/:(?!:)[\w-]+(\([^)]*\))?/g) ?? []).filter((p) => !PSEUDO_ELEMENT.test(p)).length +
    inner;
  const tags =
    (s.match(/(^|[\s>+~])([a-zA-Z][\w-]*)/g) ?? []).length + (s.match(/::[\w-]+/g) ?? []).length;
  return [ids, classes, tags] as const;
}

const cmpSpec = (a: CssRule, b: CssRule): number =>
  a.spec[0] - b.spec[0] || a.spec[1] - b.spec[1] || a.spec[2] - b.spec[2] || a.order - b.order;

/**
 * Ключ выборки: класс (или тег) САМОГО ПРАВОГО составного селектора —
 * то есть того элемента, к которому правило в итоге применяется.
 *
 * Тонкость, на которой ломалась прошлая версия: комбинаторы часто пишут
 * без пробелов (`.enquire-intro>p:not(.eyebrow)`), а классы внутри `:not()`
 * к субъекту правила отношения не имеют. Наивный разбор клал такое правило
 * в корзину «.eyebrow», и до нужного `<p>` оно не доходило никогда —
 * поэтому у трёх абзацев молча пропадал `max-width`.
 */
function selectorKey(selector: string): string | null {
  // содержимое функциональных псевдоклассов субъект не определяет
  const stripped = selector.replace(/:(not|is|where|matches|has)\([^()]*\)/gi, "");
  const last = stripped.split(/[\s>+~]+/).filter(Boolean).pop() ?? stripped;
  const cls = [...last.matchAll(/\.([\w-]+)/g)].pop();
  if (cls) return `.${cls[1]}`;
  const tag = /^([a-zA-Z][\w-]*)/.exec(last.trim());
  return tag ? tag[1].toLowerCase() : null;
}

/* ------------------------------------------------------------------ */
/* Медиазапросы                                                        */
/* ------------------------------------------------------------------ */

/**
 * Подходит ли медиазапрос под вьюпорт импорта.
 *
 * Раньше `@media` выбрасывались целиком «берём десктоп-базу». Это грубо:
 * правила из `@media (min-width:1200px)` — тоже десктоп, и они терялись.
 * Теперь запрос честно проверяется по ширине/высоте.
 */
export function matchesMedia(condition: string, ctx: MediaCtx): boolean {
  const cond = condition.toLowerCase().trim();
  if (!cond || cond === "all" || cond === "screen" || cond === "only screen") return true;
  if (/\bprint\b/.test(cond) && !/\bscreen\b/.test(cond)) return false;
  // prefers-reduced-motion / prefers-color-scheme и прочее — берём базовый случай
  if (/prefers-reduced-motion\s*:\s*reduce/.test(cond)) return false;
  if (/prefers-color-scheme\s*:\s*dark/.test(cond)) return false;
  if (/\bhover\s*:\s*none\b/.test(cond)) return false;

  return splitTop(cond, ",").some((clause) => {
    if (/\bnot\b/.test(clause)) return false;
    let ok = true;
    for (const m of clause.matchAll(/\(\s*(min|max)-(width|height)\s*:\s*([\d.]+)(px|em|rem)?\s*\)/g)) {
      const px = parseFloat(m[3]) * (m[4] === "em" || m[4] === "rem" ? 16 : 1);
      const actual = m[2] === "width" ? ctx.width : ctx.height;
      ok = ok && (m[1] === "min" ? actual >= px : actual <= px);
    }
    // современный синтаксис диапазонов: (400px <= width <= 900px)
    for (const m of clause.matchAll(/\(\s*([\d.]+)px\s*<=?\s*(width|height)\s*<=?\s*([\d.]+)px\s*\)/g)) {
      const actual = m[2] === "width" ? ctx.width : ctx.height;
      ok = ok && actual >= parseFloat(m[1]) && actual <= parseFloat(m[3]);
    }
    return ok;
  });
}

/* ------------------------------------------------------------------ */
/* Разбор таблицы стилей                                               */
/* ------------------------------------------------------------------ */

/** Находит индекс парной `}` для блока, начинающегося на `{` в позиции open. */
function matchBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return css.length;
}

export function parseStylesheet(cssRaw: string, media: MediaCtx): Stylesheet {
  const sheet: Stylesheet = { rules: [], vars: new Map(), fontFaces: [], imports: [], skippedMedia: 0 };
  const css = stripComments(cssRaw);
  let order = 0;

  const walkBlock = (text: string, active: boolean): void => {
    let i = 0;
    while (i < text.length) {
      // пропускаем пробелы
      while (i < text.length && /\s/.test(text[i])) i++;
      if (i >= text.length) break;

      if (text[i] === "@") {
        const semi = indexOfTop(text, ";", i);
        const brace = indexOfTop(text, "{", i);
        const atName = /^@([\w-]+)/.exec(text.slice(i))?.[1]?.toLowerCase() ?? "";

        if (brace === -1 || (semi !== -1 && semi < brace)) {
          // @import url(...);  @charset "utf-8";
          const stmt = text.slice(i, semi === -1 ? text.length : semi);
          if (atName === "import") {
            const url = /url\(\s*["']?([^"')]+)["']?\s*\)|["']([^"']+)["']/.exec(stmt);
            if (url) sheet.imports.push((url[1] ?? url[2]).trim());
          }
          i = semi === -1 ? text.length : semi + 1;
          continue;
        }

        const end = matchBrace(text, brace);
        const prelude = text.slice(i + 1 + atName.length, brace).trim();
        const body = text.slice(brace + 1, end);

        if (atName === "media") {
          const on = matchesMedia(prelude, media);
          if (!on) sheet.skippedMedia += 1;
          walkBlock(body, active && on);
        } else if (atName === "supports" || atName === "layer" || atName === "scope") {
          walkBlock(body, active);
        } else if (atName === "font-face") {
          const d = parseDeclarations(body);
          const fam = (d["font-family"] ?? "").replace(/["']/g, "").trim();
          if (fam && d["src"]) {
            sheet.fontFaces.push({ family: fam, src: d["src"], weight: d["font-weight"], style: d["font-style"] });
          }
        }
        // @keyframes/@page/@property — на статичный импорт не влияют
        i = end + 1;
        continue;
      }

      const brace = indexOfTop(text, "{", i);
      if (brace === -1) break;
      const end = matchBrace(text, brace);
      const selectorList = text.slice(i, brace).trim();
      const decls = parseDeclarations(text.slice(brace + 1, end));
      i = end + 1;
      if (!active || Object.keys(decls).length === 0 || !selectorList) continue;

      for (const [k, v] of Object.entries(decls)) {
        if (k.startsWith("--")) sheet.vars.set(k.slice(2), v);
      }

      for (const rawSel of splitTop(selectorList, ",")) {
        const selector = rawSel.trim().replace(/\s+/g, " ");
        if (!selector) continue;
        // динамические состояния и псевдоэлементы в статичный макет не переносим
        if (DYNAMIC_PSEUDO.test(selector) || PSEUDO_ELEMENT.test(selector)) continue;
        sheet.rules.push({
          selector,
          decls,
          spec: specificity(selector),
          order: order++,
          key: selectorKey(selector),
        });
      }
    }
  };

  walkBlock(css, true);
  return sheet;
}

function stripComments(css: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < css.length) {
    const ch = css[i];
    if (quote) {
      out += ch;
      if (ch === quote && css[i - 1] !== "\\") quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function indexOfTop(input: string, ch: string, from = 0): number {
  let quote: string | null = null;
  let depth = 0;
  for (let i = from; i < input.length; i++) {
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
/* Каскад для элемента                                                 */
/* ------------------------------------------------------------------ */

/** Индекс правил по ключу — чтобы не звать matches() для всей таблицы. */
export class RuleIndex {
  private byClass = new Map<string, CssRule[]>();
  private byTag = new Map<string, CssRule[]>();
  private universal: CssRule[] = [];

  constructor(rules: CssRule[]) {
    for (const r of rules) {
      if (r.key === null) this.universal.push(r);
      else if (r.key.startsWith(".")) push(this.byClass, r.key.slice(1), r);
      else push(this.byTag, r.key, r);
    }
  }

  candidates(el: Element): CssRule[] {
    const out: CssRule[] = [...this.universal];
    const tag = this.byTag.get(el.tagName.toLowerCase());
    if (tag) out.push(...tag);
    for (const c of Array.from(el.classList)) {
      const hit = this.byClass.get(c);
      if (hit) out.push(...hit);
    }
    return out;
  }
}

/**
 * `element.matches()` с деградацией вместо падения.
 *
 * Селекторный список внутри `:not()` (`p:not(.eyebrow,.fine)` — CSS Selectors 4)
 * поддержан не везде. Разворачиваем в цепочку `:not(.eyebrow):not(.fine)`,
 * которая эквивалентна и понятна любому движку. Раньше такое правило
 * выбрасывалось целиком — а на нём висела типографика основного текста.
 */
function matchesSafely(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    /* пробуем упростить */
  }
  const simplified = selector.replace(/:not\(([^()]*,[^()]*)\)/gi, (_m, args: string) =>
    splitTop(args, ",")
      .map((a) => `:not(${a.trim()})`)
      .join(""),
  );
  if (simplified !== selector) {
    try {
      return el.matches(simplified);
    } catch {
      /* всё ещё не понят — сдаёмся */
    }
  }
  return false;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

/**
 * Итоговые декларации элемента: правила, отсортированные по
 * (важность, специфичность, порядок), затем inline-стиль.
 * Побеждает ПОСЛЕДНЕЕ — как в настоящем CSS.
 */
export function computeDeclarations(el: Element, index: RuleIndex): Record<string, string> {
  const hits: CssRule[] = [];
  for (const rule of index.candidates(el)) {
    if (matchesSafely(el, rule.selector)) hits.push(rule);
  }
  hits.sort(cmpSpec);

  const out: Record<string, string> = {};
  const important: Record<string, string> = {};
  for (const rule of hits) {
    for (const [k, v] of Object.entries(rule.decls)) {
      if (k.endsWith("!")) continue;
      if (rule.decls[`${k}!`]) important[k] = v;
      else out[k] = v;
    }
  }

  const inline = el.getAttribute("style");
  if (inline) Object.assign(out, parseDeclarations(inline));
  Object.assign(out, important); // !important поверх всего
  return out;
}

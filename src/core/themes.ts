/**
 * СИСТЕМА СТИЛЕЙ (дизайн-токены).
 *
 * Стиль сайта — живая система токенов: цвета, шрифты, радиусы, тени.
 * Узлы ссылаются на токены значениями вида "$bg" / "$text" / "$accent" —
 * смена пресета или акцентного цвета мгновенно перекрашивает весь проект
 * и на холсте, и в генерируемом CSS (:root-переменные).
 *
 * Подбор палитры — ДЕТЕРМИНИРОВАННЫЙ АЛГОРИТМ (решение Блока 5, не ИИ):
 * HSL-производные от акцента + характер пресета + авто-контраст (WCAG).
 */

import type { ContainerType, SpaceToken, SpaceValue } from "./types";

export type PresetId = "minimal" | "retro" | "brutalist" | "corporate" | "playful";

/** Что хранится в документе. */
export interface ThemeSpec {
  preset: PresetId;
  /** Акцентный цвет — единственный «ползунок» пользователя. */
  accent: string;
}

export interface ThemeColors {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  line: string;
  accent: string;
  accentInk: string;
}

export interface ResolvedTheme {
  preset: PresetId;
  colors: ThemeColors;
  fonts: { heading: string; body: string };
  /** Семейства для ссылки Google Fonts (со weights). */
  googleFamilies: string[];
  radius: { sm: number; md: number; lg: number };
  shadow: string;
  /** Шкала отступов: единый ритм страницы вместо «на глаз». */
  space: Record<SpaceToken, number>;
  /** Ширины контейнеров: насколько широко расходится содержимое. */
  containers: Record<Exclude<ContainerType, "custom">, number | null>;
}

/**
 * ШКАЛА ОТСТУПОВ.
 *
 * Смысл шкалы — не в удобстве, а в том, что при свободных пикселях на
 * странице неизбежно появляются 78, 80 и 82px, и сайт выглядит неаккуратно
 * при формально «настроенных» значениях. Токен же меняется в теме один раз.
 */
export const SPACE_SCALE: Record<SpaceToken, number> = {
  none: 0,
  xs: 8,
  sm: 16,
  md: 24,
  lg: 48,
  xl: 80,
  "2xl": 120,
  "3xl": 160,
};

/** Ширины контейнеров: full не ограничен, text — примерно 70 символов в строке. */
export const CONTAINER_WIDTHS: Record<Exclude<ContainerType, "custom">, number | null> = {
  full: null,
  wide: 1400,
  default: 1200,
  narrow: 960,
  text: 720,
};

/** Человекочитаемые подписи шкалы для панели свойств. */
export const SPACE_LABELS: Record<SpaceToken, string> = {
  none: "нет",
  xs: "XS",
  sm: "S",
  md: "M",
  lg: "L",
  xl: "XL",
  "2xl": "2XL",
  "3xl": "3XL",
};

/** Токен отступа или пиксели → пиксели. Единственная точка разрешения. */
export function resolveSpace(value: SpaceValue | undefined, theme?: ResolvedTheme): number {
  if (value === undefined) return 0;
  if (typeof value === "number") return value;
  return (theme?.space ?? SPACE_SCALE)[value] ?? 0;
}

export const DEFAULT_THEME: ThemeSpec = { preset: "minimal", accent: "#aa816a" };

/* ------------------------------------------------------------------ */
/* Цветовая математика                                                 */
/* ------------------------------------------------------------------ */

interface Hsl {
  h: number;
  s: number;
  l: number;
}

export function hexToHsl(hex: string): Hsl {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

export function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = Math.min(1, Math.max(0, s));
  l = Math.min(1, Math.max(0, l));
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const to255 = (v: number): string => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${to255(f(0))}${to255(f(8))}${to255(f(4))}`;
}

/** Относительная яркость (WCAG). */
function luminance(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  const chan = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan((n >> 16) & 255) + 0.7152 * chan((n >> 8) & 255) + 0.0722 * chan(n & 255);
}

/** Контраст WCAG между двумя цветами (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Цвет текста поверх фона: белый или почти-чёрный — что контрастнее. */
export function inkFor(bg: string): string {
  return contrastRatio(bg, "#ffffff") >= contrastRatio(bg, "#15181c") ? "#ffffff" : "#15181c";
}

/* ------------------------------------------------------------------ */
/* Пресеты: характер каждого стиля                                     */
/* ------------------------------------------------------------------ */

interface PresetDef {
  label: string;
  fonts: { heading: string; body: string };
  googleFamilies: string[];
  radius: { sm: number; md: number; lg: number };
  shadow: string;
  derive: (accent: Hsl, accentHex: string) => ThemeColors;
}

export const PRESETS: Record<PresetId, PresetDef> = {
  minimal: {
    label: "Минимализм",
    fonts: { heading: "'Inter', sans-serif", body: "'Inter', sans-serif" },
    googleFamilies: ["Inter:wght@400;500;600;700"],
    radius: { sm: 6, md: 10, lg: 14 },
    shadow: "none",
    derive: (a, accentHex) => ({
      bg: "#ffffff",
      surface: hslToHex(a.h, 0.08, 0.965),
      text: hslToHex(a.h, 0.1, 0.11),
      muted: hslToHex(a.h, 0.07, 0.44),
      line: hslToHex(a.h, 0.08, 0.9),
      accent: accentHex,
      accentInk: inkFor(accentHex),
    }),
  },
  retro: {
    label: "Ретро",
    fonts: { heading: "'Playfair Display', serif", body: "'Lora', serif" },
    googleFamilies: ["Playfair+Display:wght@600;700", "Lora:wght@400;500"],
    radius: { sm: 3, md: 6, lg: 10 },
    shadow: "0 2px 0 rgba(60, 40, 20, 0.2)",
    derive: (_a, accentHex) => ({
      bg: hslToHex(40, 0.45, 0.94),
      surface: hslToHex(38, 0.4, 0.88),
      text: hslToHex(24, 0.3, 0.16),
      muted: hslToHex(28, 0.2, 0.4),
      line: hslToHex(36, 0.3, 0.78),
      accent: accentHex,
      accentInk: inkFor(accentHex),
    }),
  },
  brutalist: {
    label: "Бруталист",
    fonts: { heading: "'Space Grotesk', sans-serif", body: "'Space Mono', monospace" },
    googleFamilies: ["Space+Grotesk:wght@500;700", "Space+Mono:wght@400;700"],
    radius: { sm: 0, md: 0, lg: 0 },
    shadow: "5px 5px 0 #000000",
    derive: (_a, accentHex) => ({
      bg: "#ffffff",
      surface: "#f2f2f2",
      text: "#000000",
      muted: "#3a3a3a",
      line: "#000000",
      accent: accentHex,
      accentInk: inkFor(accentHex),
    }),
  },
  corporate: {
    label: "Корпоративный",
    fonts: { heading: "'Manrope', sans-serif", body: "'Inter', sans-serif" },
    googleFamilies: ["Manrope:wght@600;700;800", "Inter:wght@400;500;600"],
    radius: { sm: 8, md: 12, lg: 16 },
    shadow: "0 4px 18px rgba(30, 45, 70, 0.08)",
    derive: (a, accentHex) => ({
      bg: hslToHex(215, 0.3, 0.975),
      surface: "#ffffff",
      text: hslToHex(216, 0.3, 0.14),
      muted: hslToHex(214, 0.15, 0.42),
      line: hslToHex(a.h, 0.14, 0.88),
      accent: accentHex,
      accentInk: inkFor(accentHex),
    }),
  },
  playful: {
    label: "Игривый",
    fonts: { heading: "'Baloo 2', sans-serif", body: "'Nunito', sans-serif" },
    googleFamilies: ["Baloo+2:wght@600;700", "Nunito:wght@400;600;700"],
    radius: { sm: 14, md: 20, lg: 28 },
    shadow: "0 8px 22px rgba(60, 30, 90, 0.12)",
    derive: (a, accentHex) => ({
      bg: hslToHex(a.h, 0.7, 0.975),
      surface: hslToHex(a.h + 36, 0.62, 0.93),
      text: hslToHex(a.h, 0.42, 0.17),
      muted: hslToHex(a.h, 0.2, 0.45),
      line: hslToHex(a.h, 0.4, 0.86),
      accent: accentHex,
      accentInk: inkFor(accentHex),
    }),
  },
};

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

/* ------------------------------------------------------------------ */
/* Разрешение темы и токенов                                           */
/* ------------------------------------------------------------------ */

let cacheKey = "";
let cacheVal: ResolvedTheme | null = null;

export function resolveTheme(spec: ThemeSpec | undefined): ResolvedTheme {
  const s = spec ?? DEFAULT_THEME;
  const key = `${s.preset}|${s.accent}`;
  if (cacheVal && cacheKey === key) return cacheVal;
  const def = PRESETS[s.preset] ?? PRESETS.minimal;
  const resolved: ResolvedTheme = {
    preset: s.preset,
    colors: def.derive(hexToHsl(s.accent), s.accent),
    fonts: def.fonts,
    googleFamilies: def.googleFamilies,
    radius: def.radius,
    shadow: def.shadow,
    space: SPACE_SCALE,
    containers: CONTAINER_WIDTHS,
  };
  cacheKey = key;
  cacheVal = resolved;
  return resolved;
}

/** Токены, доступные как значения цвета в стилях узлов. */
export const COLOR_TOKENS: Record<string, { label: string; key: keyof ThemeColors }> = {
  $bg: { label: "Фон", key: "bg" },
  $surface: { label: "Поверхность", key: "surface" },
  $text: { label: "Текст", key: "text" },
  $muted: { label: "Приглушённый", key: "muted" },
  $accent: { label: "Акцент", key: "accent" },
  $accentInk: { label: "На акценте", key: "accentInk" },
};

/** "$accent" → hex по теме; обычный hex проходит насквозь. */
export function resolveColor(value: string, theme: ResolvedTheme): string {
  const token = COLOR_TOKENS[value];
  return token ? theme.colors[token.key] : value;
}

/** Токен → имя CSS-переменной (для генерации кода). */
export function tokenCssVar(value: string): string | null {
  const token = COLOR_TOKENS[value];
  if (!token) return null;
  const kebab = token.key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return `var(--c-${kebab})`;
}

/** URL Google Fonts для набора семейств. */
export function googleFontsUrl(families: string[]): string {
  const parts = families.map((f) => `family=${f}`).join("&");
  return `https://fonts.googleapis.com/css2?${parts}&display=swap`;
}

/** Подгрузка шрифтов темы в сам редактор (для холста). */
export function ensureThemeFonts(theme: ResolvedTheme): void {
  const id = "plx-theme-fonts";
  const href = googleFontsUrl(theme.googleFamilies);
  let link = document.getElementById(id) as HTMLLinkElement | null;
  if (link?.href === href) return;
  if (!link) {
    link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  link.href = href;
}

/**
 * Подключает шрифты импортированной страницы (Google Fonts @import,
 * @font-face). Ссылки темы IDE не трогаем — они живут отдельным тегом,
 * чтобы стиль сайта не протекал в интерфейс программы.
 */
export function ensureImportedFonts(hrefs: string[]): void {
  const id = "plx-imported-fonts";
  const existing = document.getElementById(id);
  const wanted = [...new Set(hrefs.filter((h) => /^https?:|^\/\//.test(h)))];
  if (wanted.length === 0) return;
  const style = (existing as HTMLStyleElement | null) ?? document.createElement("style");
  style.id = id;
  const imports = wanted.map((h) => `@import url("${h.replace(/"/g, "")}");`).join("\n");
  if (style.textContent === imports) return;
  style.textContent = imports;
  if (!existing) document.head.appendChild(style);
}

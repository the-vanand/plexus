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

export type PresetId =
  | "minimal"
  | "retro"
  | "brutalist"
  | "corporate"
  | "playful"
  | "dark"
  | "glass"
  | "neumorphic"
  | "flat"
  | "editorial";

/** Что хранится в документе. */
export interface ThemeSpec {
  preset: PresetId;
  /** Акцентный цвет — единственный «ползунок» пользователя. */
  accent: string;
  /**
   * Палитра из 4-5 цветов (подобранная, например, на color.romanuke.com).
   * Когда задана, цвета темы выводятся из неё детерминированным маппингом
   * (см. paletteToColors) поверх выбранного пресета: шрифты, радиусы и
   * тени остаются пресетными, а цвет приходит из палитры.
   */
  palette?: string[];
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
  dark: {
    /* Тёмный режим в духе современных инструментов: фон не чёрный, а
       тёмно-серый (L 9%), текст off-white, акцент чуть приглушён —
       насыщенный цвет на тёмном «горит». */
    label: "Тёмный",
    fonts: { heading: "'Inter', sans-serif", body: "'Inter', sans-serif" },
    googleFamilies: ["Inter:wght@400;500;600;700"],
    radius: { sm: 8, md: 12, lg: 16 },
    shadow: "0 0 0 1px rgba(255,255,255,0.07), 0 4px 16px rgba(0,0,0,0.4)",
    derive: (a) => {
      /* Приглушать имеет смысл только НАСЫЩЕННЫЙ акцент: слабый (s<0.4)
         терял последний цвет и сливался с muted в два серых пятна. */
      const s = a.s >= 0.4 ? a.s - 0.15 : Math.max(a.s, 0.25);
      const accent = escapeInkDeadZone(
        hslToHex(a.h, s, Math.min(0.72, a.l + 0.1)),
        hslToHex(a.h, 0.08, 0.09),
      );
      return {
        bg: hslToHex(a.h, 0.08, 0.09),
        surface: hslToHex(a.h, 0.1, 0.14),
        text: hslToHex(a.h, 0.05, 0.94),
        muted: hslToHex(a.h, 0.07, 0.62),
        line: hslToHex(a.h, 0.1, 0.22),
        accent,
        accentInk: inkFor(accent),
      };
    },
  },
  glass: {
    /* Глассморфизм: глубокий цветной фон, «морозные» панели, крупные
       радиусы. Токены дают непрозрачный эквивалент стекла; сам blur
       добавляется на уровне карточек. */
    label: "Стекло",
    fonts: { heading: "'DM Sans', sans-serif", body: "'DM Sans', sans-serif" },
    googleFamilies: ["DM+Sans:wght@400;500;600;700"],
    radius: { sm: 12, md: 18, lg: 24 },
    shadow: "0 8px 32px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.12)",
    derive: (a) => {
      const accent = hslToHex(a.h, Math.min(1, a.s + 0.1), Math.min(0.75, a.l + 0.15));
      return {
        bg: hslToHex(a.h, 0.45, 0.1),
        surface: hslToHex(a.h, 0.25, 0.18),
        text: "#ffffff",
        muted: hslToHex(a.h, 0.2, 0.7),
        line: hslToHex(a.h, 0.3, 0.28),
        accent,
        accentInk: inkFor(accent),
      };
    },
  },
  neumorphic: {
    /* Мягкий рельеф (soft UI): поверхность совпадает с фоном, глубину
       делает пара теней — светлая сверху-слева, тёмная снизу-справа.
       Текст тёмный: серый-на-сером не проходит по контрасту. */
    label: "Мягкий рельеф",
    fonts: { heading: "'Nunito Sans', sans-serif", body: "'Nunito Sans', sans-serif" },
    googleFamilies: ["Nunito+Sans:wght@400;500;600;700"],
    radius: { sm: 12, md: 18, lg: 24 },
    shadow: "-8px -8px 16px rgba(255,255,255,0.9), 8px 8px 16px rgba(163,177,198,0.6)",
    derive: (a) => {
      const accent = hslToHex(a.h, Math.min(1, a.s + 0.1), Math.min(0.48, a.l));
      return {
        bg: hslToHex(a.h, 0.2, 0.88),
        surface: hslToHex(a.h, 0.2, 0.88),
        text: hslToHex(a.h, 0.2, 0.18),
        muted: hslToHex(a.h, 0.12, 0.4),
        line: hslToHex(a.h, 0.15, 0.78),
        accent,
        accentInk: inkFor(accent),
      };
    },
  },
  flat: {
    /* Плоский стиль швейцарской школы: иерархию делают цвет и
       типографика; тень одна, минимальная — только чтобы отличать
       кликабельное (Flat 2.0). */
    label: "Плоский",
    fonts: { heading: "'IBM Plex Sans', sans-serif", body: "'IBM Plex Sans', sans-serif" },
    googleFamilies: ["IBM+Plex+Sans:wght@400;500;600;700"],
    radius: { sm: 4, md: 6, lg: 8 },
    shadow: "0 1px 3px rgba(0,0,0,0.10)",
    derive: (a, accentHex) => ({
      bg: "#ffffff",
      surface: hslToHex(a.h, 0.06, 0.97),
      text: hslToHex(a.h, 0.15, 0.1),
      muted: hslToHex(a.h, 0.08, 0.42),
      line: hslToHex(a.h, 0.06, 0.88),
      accent: accentHex,
      accentInk: inkFor(accentHex),
    }),
  },
  editorial: {
    /* Редакционный: контрастные serif-заголовки, тёплое ivory вместо
       белого, приглушённый акцент — журнальная типографика. */
    label: "Редакционный",
    fonts: { heading: "'DM Serif Display', serif", body: "'Source Serif 4', serif" },
    googleFamilies: ["DM+Serif+Display:wght@400", "Source+Serif+4:wght@400;600"],
    radius: { sm: 4, md: 6, lg: 10 },
    shadow: "0 2px 8px rgba(40,30,20,0.08)",
    derive: (a) => {
      const accent = hslToHex(a.h, Math.min(0.75, a.s), Math.min(0.5, a.l));
      return {
        bg: hslToHex(35, 0.15, 0.97),
        surface: hslToHex(35, 0.18, 0.93),
        text: hslToHex(28, 0.25, 0.12),
        muted: hslToHex(28, 0.15, 0.4),
        line: hslToHex(35, 0.18, 0.84),
        accent,
        accentInk: inkFor(accent),
      };
    },
  },
};

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

/* ------------------------------------------------------------------ */
/* Палитра → цвета темы                                                */
/* ------------------------------------------------------------------ */

/**
 * Детерминированный маппинг палитры из 4-5 цветов на токены темы.
 *
 * Правила читаемости важнее верности палитре: подобранная палитра может
 * быть целиком пастельной или целиком тёмной, а текст обязан читаться.
 *  1. Сортировка по светимости: самый светлый — фон, самый тёмный — текст.
 *  2. Контраст текст/фон < 4.5 — светлость якорей форсируется (WCAG AA).
 *  3. Акцент — самый насыщенный из средних цветов; контраст с фоном < 3
 *     — светлость акцента сдвигается в нужную сторону.
 *  4. Поверхность — следующий средний цвет, зажатый между фоном и текстом.
 *  5. Приглушённый и линия — производные, с собственной проверкой
 *     контраста.
 */
/**
 * Довести цвет до заданного контраста с фоном, шагая по светлоте.
 * Направление выбирается по ПОТОЛКУ: на среднетональном фоне (L≈0.5)
 * контраст 3:1 вверх недостижим математически — идти надо вниз.
 */
function forceContrast(color: string, bg: string, target: number): string {
  if (contrastRatio(color, bg) >= target) return color;
  const bgLum = luminance(bg);
  const maxUp = 1.05 / (bgLum + 0.05);
  const maxDown = (bgLum + 0.05) / 0.05;
  const darker = maxDown >= maxUp;
  let out = color;
  for (let i = 0; i < 18 && contrastRatio(out, bg) < target; i += 1) {
    const h = hexToHsl(out);
    out = darker
      ? hslToHex(h.h, h.s, Math.max(h.l - 0.05, 0))
      : hslToHex(h.h, h.s, Math.min(h.l + 0.05, 1));
  }
  return out;
}

/**
 * УВЕСТИ АКЦЕНТ ИЗ «МЁРТВОЙ ЗОНЫ» ЧЕРНИЛ.
 *
 * У средней светлоты (L ≈ 0.34–0.47) есть неприятное свойство: НИ белый,
 * НИ почти-чёрный текст не набирают на таком фоне 4.5:1 — надпись на
 * акцентной кнопке нечитаема, какие чернила ни выбери. Кнопку лечит
 * только сдвиг самого акцента. Направление выбирается так, чтобы не
 * потерять контраст с фоном страницы: на светлом фоне акцент темнеет,
 * на тёмном — светлеет.
 */
function escapeInkDeadZone(accent: string, bg: string): string {
  let out = accent;
  for (let i = 0; i < 12; i += 1) {
    const inkOk =
      Math.max(contrastRatio(out, "#ffffff"), contrastRatio(out, "#15181c")) >= 4.5;
    if (inkOk) return out;
    const h = hexToHsl(out);
    out =
      luminance(bg) > 0.35
        ? hslToHex(h.h, h.s, Math.max(h.l - 0.04, 0))
        : hslToHex(h.h, h.s, Math.min(h.l + 0.04, 1));
  }
  return out;
}

export function paletteToColors(palette: string[]): ThemeColors | null {
  const hexes = [...new Set(palette.map((c) => c.trim()).filter((c) => /^#[0-9a-fA-F]{6}$/.test(c)))];
  if (hexes.length < 3) return null;
  const lums = hexes.map(luminance);
  const sorted = [...hexes].sort((a, b) => luminance(b) - luminance(a));

  let bg = sorted[0];
  let text = sorted[sorted.length - 1];
  if (contrastRatio(bg, text) < 4.5) {
    const bgH = hexToHsl(bg);
    const txH = hexToHsl(text);
    bg = hslToHex(bgH.h, bgH.s, Math.max(bgH.l, 0.94));
    text = hslToHex(txH.h, txH.s, Math.min(txH.l, 0.15));
  }
  if (lums.every((l) => l > 0.5)) {
    const txH = hexToHsl(sorted[sorted.length - 1]);
    text = hslToHex(txH.h, txH.s * 0.5, 0.12);
  }
  if (lums.every((l) => l < 0.15)) {
    const bgH = hexToHsl(sorted[0]);
    bg = hslToHex(bgH.h, bgH.s * 0.3, 0.92);
  }

  // средние цвета: всё между самым светлым и самым тёмным
  const middle = sorted.slice(1, -1);
  const bySat = [...middle].sort((a, b) => hexToHsl(b).s - hexToHsl(a).s);
  let accent = bySat[0] ?? sorted[0];
  /* КОНТРАСТ АКЦЕНТА ДОВОДИТСЯ ЦИКЛОМ, А НЕ ОДНИМ ШАГОМ.
     Одноразовый сдвиг к L=0.42 не спасал насыщенные светлые цвета
     (циан #00BCC9 на светлом фоне давал 1.14:1 — акцент исчезал на
     каждой третьей палитре набора). После контраста с фоном акцент
     уводится из «мёртвой зоны» чернил — иначе на 15% палитр надпись
     на акцентной кнопке не читалась ни белым, ни чёрным. */
  accent = escapeInkDeadZone(forceContrast(accent, bg, 3), bg);

  /* ПОВЕРХНОСТЬ — ОТТЕНОК ФОНА, А НЕ ЯРКАЯ СЕРЕДИНА ПАЛИТРЫ.
     Роль surface — «фон карточки, чуть отличный от фона страницы».
     Насыщенный средний цвет в этой роли превращал карточки в кричащие
     блоки (73% палитр). Тон берём фоновый, светлость сдвигаем на 5%. */
  const bgHsl = hexToHsl(bg);
  /* Дельта 8%: на насыщенных тёплых фонах 5% светлости неотличимы —
     карточки сливались с фоном на 6% палитр набора. */
  const surface =
    luminance(bg) > 0.5
      ? hslToHex(bgHsl.h, Math.min(bgHsl.s, 0.25), Math.max(bgHsl.l - 0.08, 0))
      : hslToHex(bgHsl.h, Math.min(bgHsl.s, 0.25), Math.min(bgHsl.l + 0.08, 1));

  /* Линия обязана быть ВИДИМОЙ: дельта 12% светлости и порог 1.3:1 —
     прежние 7% на пастельных фонах давали 1.1:1, разделители исчезали. */
  let line =
    bgHsl.l < 0.12
      ? hslToHex(bgHsl.h, bgHsl.s, bgHsl.l + 0.12)
      : hslToHex(bgHsl.h, bgHsl.s * 0.8, bgHsl.l - 0.12);
  for (let i = 0; i < 8 && contrastRatio(line, bg) < 1.3; i += 1) {
    const lH = hexToHsl(line);
    line =
      luminance(bg) > 0.5
        ? hslToHex(lH.h, lH.s, Math.max(lH.l - 0.05, 0))
        : hslToHex(lH.h, lH.s, Math.min(lH.l + 0.05, 1));
  }

  const midL = (bgHsl.l + hexToHsl(text).l) / 2;
  const muted = forceContrast(hslToHex(hexToHsl(accent).h, 0.08, midL), bg, 4.5);

  return { bg, surface, text, muted, line, accent, accentInk: inkFor(accent) };
}

/* ------------------------------------------------------------------ */
/* Разрешение темы и токенов                                           */
/* ------------------------------------------------------------------ */

let cacheKey = "";
let cacheVal: ResolvedTheme | null = null;

export function resolveTheme(spec: ThemeSpec | undefined): ResolvedTheme {
  const s = spec ?? DEFAULT_THEME;
  const key = `${s.preset}|${s.accent}|${s.palette?.join(",") ?? ""}`;
  if (cacheVal && cacheKey === key) return cacheVal;
  const def = PRESETS[s.preset] ?? PRESETS.minimal;
  const paletteColors = s.palette ? paletteToColors(s.palette) : null;
  const derived = paletteColors ?? def.derive(hexToHsl(s.accent), s.accent);
  /* Страховка для ЛЮБОГО пресета: пользовательский акцент из пипетки
     может попасть в «мёртвую зону» чернил (L ≈ 0.34-0.47) — тогда
     надпись на акцентной кнопке не читается ни белым, ни чёрным.
     Уводим акцент и пересчитываем чернила. */
  const safeAccent = escapeInkDeadZone(derived.accent, derived.bg);
  const colors =
    safeAccent === derived.accent
      ? derived
      : { ...derived, accent: safeAccent, accentInk: inkFor(safeAccent) };
  const resolved: ResolvedTheme = {
    preset: s.preset,
    colors,
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

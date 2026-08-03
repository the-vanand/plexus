/**
 * ДЕТЕРМИНИРОВАННЫЙ ИЗМЕРИТЕЛЬ ТЕКСТА ДЛЯ СТЕНДА.
 *
 * В Node нет canvas, поэтому Pixi CanvasTextMetrics недоступен. Здесь —
 * приближение по таблице средних ширин символов для трёх семейств.
 * Абсолютные пиксели отличаются от реального рендера на единицы процентов,
 * НО алгоритм переноса тот же (greedy по словам, без разрыва слов), поэтому
 * стенд честно ловит структурные ошибки: переполнения, схлопнутые колонки,
 * потерянные переносы. Пиксель-в-пиксель сверяется уже в самом приложении.
 */
import type { MeasureFn, TextSize } from "../../src/core/types";

/** Средняя ширина глифа как доля от кегля (эмпирика по метрикам семейств). */
const FAMILY_K: Array<[RegExp, number]> = [
  [/georgia|times|serif/i, 0.5],
  [/courier|mono/i, 0.6],
  [/arial|helvetica|inter|sans/i, 0.5],
];

const WIDE = new Set("MWmw@%".split(""));
const NARROW = new Set("iljt.,;:'|!I ".split(""));

function glyphWidth(ch: string, fontSize: number, k: number): number {
  if (WIDE.has(ch)) return fontSize * k * 1.55;
  if (NARROW.has(ch)) return fontSize * k * 0.48;
  if (ch >= "A" && ch <= "Z") return fontSize * k * 1.18;
  return fontSize * k;
}

export const LINE_HEIGHT_K = 1.32;

export const measureStub: MeasureFn = (text, fontSize, fontWeight, fontFamily, wrapWidth, extra): TextSize => {
  const k = (FAMILY_K.find(([re]) => re.test(fontFamily))?.[1] ?? 0.5) * (fontWeight >= 600 ? 1.03 : 1);
  const ls = extra?.letterSpacing ?? 0;
  const lh = extra?.lineHeight ?? LINE_HEIGHT_K;
  const body = extra?.uppercase ? (text || " ").toUpperCase() : text || " ";

  const wordWidth = (w: string): number => {
    let sum = 0;
    for (const ch of w) sum += glyphWidth(ch, fontSize, k) + ls;
    return sum;
  };

  const lines = body.split("\n");
  if (wrapWidth === undefined) {
    const w = Math.max(...lines.map(wordWidth));
    return { w: Math.ceil(w), h: Math.ceil(lines.length * fontSize * lh) };
  }

  let count = 0;
  let widest = 0;
  for (const line of lines) {
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      count += 1;
      continue;
    }
    let cur = 0;
    const space = glyphWidth(" ", fontSize, k) + ls;
    let opened = false;
    for (const word of words) {
      const ww = wordWidth(word);
      const add = opened ? space + ww : ww;
      if (opened && cur + add > wrapWidth) {
        widest = Math.max(widest, cur);
        count += 1;
        cur = ww;
      } else {
        cur += add;
        opened = true;
      }
    }
    widest = Math.max(widest, cur);
    count += 1;
  }
  return { w: Math.ceil(Math.min(widest, wrapWidth)), h: Math.ceil(count * fontSize * lh) };
};

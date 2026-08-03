/**
 * Измерение текста ТЕМ ЖЕ движком, каким рендерит Pixi (CanvasTextMetrics).
 * Это гарантия паритета: решатель раскладки и экранный текст переносят
 * строки одинаково — текст не может «поехать» из-за разницы алгоритмов.
 */
import { CanvasTextMetrics, TextStyle } from "pixi.js";
import type { MeasureFn, TextSize } from "../core/types";

export const LINE_HEIGHT_K = 1.32;

const cache = new Map<string, TextSize>();

export const measureText: MeasureFn = (text, fontSize, fontWeight, fontFamily, wrapWidth, extra) => {
  const wrapKey = wrapWidth === undefined ? "nw" : String(Math.round(wrapWidth));
  const ls = extra?.letterSpacing ?? 0;
  const lh = extra?.lineHeight ?? LINE_HEIGHT_K;
  const up = extra?.uppercase ? 1 : 0;
  const key = `${fontWeight}|${fontSize}|${fontFamily}|${wrapKey}|${ls}|${lh}|${up}|${text}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const style = new TextStyle({
    fontFamily,
    fontSize,
    fontWeight: `${fontWeight}` as "400" | "500" | "600" | "700",
    lineHeight: fontSize * lh,
    letterSpacing: ls,
    ...(wrapWidth !== undefined
      ? { wordWrap: true, wordWrapWidth: Math.max(24, wrapWidth), breakWords: false }
      : {}),
  });
  const body = extra?.uppercase ? (text || " ").toUpperCase() : text || " ";
  const m = CanvasTextMetrics.measureText(body, style);
  const size: TextSize = { w: Math.ceil(m.width), h: Math.ceil(m.height) };

  if (cache.size > 4000) cache.clear();
  cache.set(key, size);
  return size;
};

/** Сброс кеша — вызывается после догрузки веб-шрифтов темы. */
export function clearMeasureCache(): void {
  cache.clear();
}

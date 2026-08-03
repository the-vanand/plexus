/**
 * АНАЛИЗ ИСТОЧНИКА: что вообще можно импортировать из этой страницы.
 *
 * Зачем: импорт SPA даёт «три пустых div-а», и это выглядит как баг
 * приложения, хотя импортёр честно перенёс всё, что прислал сервер.
 * Разница между «страница статичная» и «страница собирается скриптом»
 * видна ДО разбора — надо просто посчитать.
 *
 * Пример на реальных данных (июль 2026):
 *   music.yandex.ru  — 175 КБ, из них 161 КБ скриптов; в теле 23 тега
 *                      и 46 знаков текста: это React-лоадер, а не страница
 *   youtube.com/watch — 1216 КБ, из них 1183 КБ скриптов; видимого текста
 *                      239 знаков (ссылки подвала). Плеера и комментариев
 *                      в разметке нет вовсе — они строятся из ytInitialData
 *
 * Модуль чистый: ни DOM, ни Pixi, ни React.
 */

/** Насколько страница пригодна для разбора из серверного HTML. */
export type SourceKind =
  /** Разметка на месте: обычный сайт, импортируется целиком. */
  | "static"
  /** Разметка есть, но часть собирается скриптом: импорт будет неполным. */
  | "hydrated"
  /** В теле только каркас и лоадер: импортировать нечего. */
  | "spa-shell";

export interface SourceReport {
  kind: SourceKind;
  /** Доля скриптов в весе страницы, 0..1. */
  scriptShare: number;
  /** Тегов в теле после удаления скриптов и стилей. */
  bodyTags: number;
  /** Знаков видимого текста. */
  textLength: number;
  imageCount: number;
  linkCount: number;
  /** Найденные признаки клиентского рендера — человекочитаемо. */
  markers: string[];
  /** Встроенное состояние приложения: имя переменной → размер в КБ. */
  embeddedState: Array<{ name: string; kilobytes: number }>;
  /** Что делать пользователю. Одна фраза, без терминов. */
  advice: string;
}

/** Признаки того, что страницу рисует скрипт, а не сервер. */
const MARKERS: Array<[RegExp, string]> = [
  [/<!--\$\?-->|<template id="B:\d/, "React 18 streaming: в теле только заглушки Suspense"],
  [/<div id="root"[^>]*>\s*<\/div>/i, "пустой контейнер #root — точка монтирования SPA"],
  [/<div id="__next"[^>]*>\s*<\/div>/i, "пустой контейнер #__next (Next.js)"],
  [/<app-root|<ng-component/i, "Angular: разметка появляется после загрузки"],
  [/data-svelte-h|<!--\[-->/, "Svelte/Vue: гидратация на клиенте"],
  [/id="ytd-app"|ytInitialData/, "YouTube: интерфейс строится из ytInitialData"],
  [/SuspenseLoader|Preloader|-loader__|class="[^"]*spinner/i, "в теле экран загрузки, а не контент"],
  [/<noscript>[\s\S]{0,400}(включите|enable)[^<]*javascript/i, "страница сама сообщает, что требует JavaScript"],
];

/** Переменные, в которых сайты держат состояние: там лежит настоящий контент. */
const STATE_VARS = [
  "ytInitialData",
  "ytInitialPlayerResponse",
  "__NEXT_DATA__",
  "__NUXT__",
  "__INITIAL_STATE__",
  "__APOLLO_STATE__",
  "__PRELOADED_STATE__",
  "Ya.Music",
];

const SCRIPT_RE = /<script[\s\S]*?<\/script>/gi;
const STYLE_RE = /<style[\s\S]*?<\/style>/gi;

export function analyzeSource(html: string): SourceReport {
  const total = Math.max(1, html.length);
  const scripts = html.match(SCRIPT_RE) ?? [];
  const scriptBytes = scripts.reduce((a, s) => a + s.length, 0);

  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  const body = bodyMatch ? bodyMatch[1] : html;
  const clean = body.replace(SCRIPT_RE, "").replace(STYLE_RE, "");

  const bodyTags = (clean.match(/<[a-zA-Z][\w-]*/g) ?? []).length;
  const text = clean.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const imageCount = (clean.match(/<img[\s>]/gi) ?? []).length;
  const linkCount = (clean.match(/<a[\s>]/gi) ?? []).length;

  const markers = MARKERS.filter(([re]) => re.test(html)).map(([, label]) => label);

  const embeddedState: SourceReport["embeddedState"] = [];
  for (const name of STATE_VARS) {
    const re = new RegExp(`${name.replace(/[.$]/g, "\\$&")}\\s*=\\s*`);
    const at = re.exec(html);
    if (!at) continue;
    // размер до конца скрипта — оценка объёма встроенных данных
    const from = at.index;
    const end = html.indexOf("</script>", from);
    embeddedState.push({
      name,
      kilobytes: Math.round(((end === -1 ? total : end) - from) / 1024),
    });
  }

  /* ---------- вердикт ---------- */
  const scriptShare = scriptBytes / total;
  let kind: SourceKind;
  if (bodyTags < 40 && text.length < 400) kind = "spa-shell";
  else if (markers.length > 0 || (scriptShare > 0.8 && text.length < 2000)) kind = "hydrated";
  else kind = "static";

  const advice =
    kind === "spa-shell"
      ? "Сервер прислал только каркас: разбирать нечего. Нужен импорт через браузер — со страницы, уже собранной скриптом."
      : kind === "hydrated"
        ? "Разметка неполная: часть интерфейса появляется только после запуска скриптов. Импортируется каркас и статичные секции."
        : "Разметка на месте — страница импортируется целиком.";

  return { kind, scriptShare, bodyTags, textLength: text.length, imageCount, linkCount, markers, embeddedState, advice };
}

/** Короткая строка для панели логов. */
export function formatSourceReport(r: SourceReport): string {
  const pct = Math.round(r.scriptShare * 100);
  const head =
    r.kind === "static" ? "статичная страница" : r.kind === "hydrated" ? "частично собирается скриптом" : "каркас SPA";
  return (
    `Источник: ${head} · скрипты ${pct}% веса · в теле ${r.bodyTags} тегов, ` +
    `${r.textLength} знаков текста, картинок ${r.imageCount}`
  );
}

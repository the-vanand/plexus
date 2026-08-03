/**
 * АДАПТЕРЫ СТОРОННИХ ВИДЖЕТОВ.
 *
 * Принцип: НЕ пытаться воспроизвести чужой инструмент, а поставить на его
 * место честный аналог из модели Plexus. Плеер YouTube, карта, чат, лента
 * комментариев — это не вёрстка, которую можно скопировать: это приложение
 * внутри страницы. Попытка «нарисовать похоже» даёт мёртвую картинку,
 * которая ломается при первом же изменении.
 *
 * Поэтому:
 *   известный виджет → соответствующий узел (video / embed) с исходной ссылкой;
 *   неизвестный интерактив → узел «встраивание» с пометкой, что это заглушка.
 *
 * Так раскладка не разъезжается, а пользователь видит, что именно тут было.
 *
 * Модуль чистый: ни DOM, ни Pixi, ни React.
 */

export type WidgetKind = "video" | "map" | "embed" | "form" | "social" | "player" | "comments";

export interface WidgetMatch {
  kind: WidgetKind;
  /** Человекочитаемое имя узла: «Видео YouTube», «Карта Яндекса». */
  label: string;
  /** Провайдер для узла video. */
  provider?: "youtube" | "vimeo" | "file";
  /** Пропорции рамки по умолчанию. */
  ratio?: number;
  /** Что сказать пользователю в логах: чем это заменено. */
  note?: string;
}

/** Хост в ссылке → чем это является. */
const BY_HOST: Array<[RegExp, WidgetMatch]> = [
  [/(?:youtube(?:-nocookie)?\.com|youtu\.be)/i, { kind: "video", label: "Видео YouTube", provider: "youtube", ratio: 16 / 9 }],
  [/player\.vimeo\.com|vimeo\.com/i, { kind: "video", label: "Видео Vimeo", provider: "vimeo", ratio: 16 / 9 }],
  [/rutube\.ru/i, { kind: "video", label: "Видео Rutube", ratio: 16 / 9 }],
  [/vk\.com\/video_ext|vkvideo\.ru/i, { kind: "video", label: "Видео VK", ratio: 16 / 9 }],
  [/dzen\.ru\/embed|ok\.ru\/videoembed/i, { kind: "video", label: "Видео", ratio: 16 / 9 }],
  [/yandex\.[a-z]+\/map|api-maps\.yandex/i, { kind: "map", label: "Карта Яндекса", ratio: 4 / 3 }],
  [/google\.[a-z.]+\/maps|maps\.google/i, { kind: "map", label: "Карта Google", ratio: 4 / 3 }],
  [/2gis\.[a-z]+/i, { kind: "map", label: "Карта 2ГИС", ratio: 4 / 3 }],
  [/openstreetmap\.org/i, { kind: "map", label: "Карта OSM", ratio: 4 / 3 }],
  [/disqus\.com|hyvor|commento|isso/i, { kind: "comments", label: "Комментарии", ratio: 3 / 4 }],
  [/open\.spotify\.com|music\.apple\.com|music\.yandex\.[a-z]+\/iframe/i, { kind: "player", label: "Аудиоплеер", ratio: 21 / 9 }],
  [/soundcloud\.com/i, { kind: "player", label: "Плеер SoundCloud", ratio: 21 / 9 }],
  [/(?:docs|forms)\.google\.com|forms\.yandex|typeform\.com|tally\.so/i, { kind: "form", label: "Внешняя форма", ratio: 3 / 4 }],
  [/calendly\.com|cal\.com/i, { kind: "form", label: "Запись на встречу", ratio: 3 / 4 }],
  [/(?:t\.me|telegram)\/|twitter\.com|x\.com\/.*status|instagram\.com\/p\//i, { kind: "social", label: "Пост из соцсети", ratio: 3 / 4 }],
  [/codepen\.io|codesandbox\.io|jsfiddle|replit\.com|figma\.com\/embed/i, { kind: "embed", label: "Встраивание", ratio: 16 / 9 }],
];

/** Классы и атрибуты популярных библиотек: то, что не является iframe. */
const BY_SIGNATURE: Array<[RegExp, WidgetMatch]> = [
  [/\bswiper\b|swiper-container|swiper-wrapper/i, { kind: "embed", label: "Слайдер (Swiper)", note: "слайдер заменён галереей — карусель на холсте не воспроизводится" }],
  [/\bslick-slider\b|\bslick-track\b/i, { kind: "embed", label: "Слайдер (Slick)", note: "слайдер заменён галереей" }],
  [/\bsplide\b|glide__|flickity|owl-carousel|keen-slider/i, { kind: "embed", label: "Карусель", note: "карусель заменена галереей" }],
  [/\bytd-player\b|html5-video-player|video-js|plyr__|jwplayer/i, { kind: "video", label: "Видеоплеер", ratio: 16 / 9, note: "плеер заменён узлом «Видео»" }],
  [/\bymaps\b|ymaps-2-1|gm-style|leaflet-container|mapboxgl-map/i, { kind: "map", label: "Карта", ratio: 4 / 3, note: "карта заменена встраиванием" }],
  [/comment-list|comments-list|ytd-comments|\bcomment-thread\b/i, { kind: "comments", label: "Комментарии", ratio: 3 / 4, note: "лента комментариев динамическая — вставлена заглушка" }],
  [/recaptcha|h-captcha|cf-turnstile/i, { kind: "form", label: "Капча", ratio: 3 / 1, note: "капча заменена заглушкой" }],
  [/\bcanvas\b/i, { kind: "embed", label: "Canvas-графика", note: "рисование на canvas не переносится — вставлена заглушка" }],
];

/** Виджет по ссылке iframe. */
export function matchByUrl(src: string | null | undefined): WidgetMatch | null {
  if (!src) return null;
  for (const [re, hit] of BY_HOST) if (re.test(src)) return hit;
  // неизвестный iframe — всё равно встраивание, а не потеря блока
  return { kind: "embed", label: "Встраивание", ratio: 16 / 9, note: "неизвестный виджет перенесён как встраивание" };
}

/**
 * Виджет по классам и атрибутам элемента.
 * Строку собирает вызывающий: `class` + `id` + имена data-атрибутов.
 */
export function matchBySignature(signature: string): WidgetMatch | null {
  if (!signature) return null;
  for (const [re, hit] of BY_SIGNATURE) if (re.test(signature)) return hit;
  return null;
}

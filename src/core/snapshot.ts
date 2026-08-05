/**
 * СНИМОК ЖИВОЙ СТРАНИЦЫ.
 *
 * Другой подход к импорту: не разбирать HTML+CSS своим движком, а дать
 * странице загрузиться в настоящем браузере и СНЯТЬ с неё результат —
 * `getBoundingClientRect()` + `getComputedStyle()` для каждого элемента.
 *
 * Почему это радикально надёжнее разбора разметки:
 *  1. JS-контент существует. У music.yandex.ru в серверном HTML 23 тега и
 *     46 знаков текста (React-лоадер), у youtube.com/watch — 145 тегов и
 *     239 знаков (ссылки подвала). Разбирать там нечего. В браузере
 *     страница к моменту снимка уже собрана.
 *  2. Свой CSS-движок не нужен вообще. Браузер уже посчитал `clamp()`,
 *     `vw`, проценты, каскад, специфичность, `@media`, container queries.
 *     В снимке лежат ГОТОВЫЕ пиксели и разрешённые цвета.
 *  3. Веб-шрифты применены, поэтому метрики текста настоящие — исчезает
 *     весь класс ошибок «текст съезжает».
 *  4. Пропорции картинок известны точно (`naturalWidth/naturalHeight`).
 *
 * Формат сознательно плоский и компактный: снимок едет через IPC-мост
 * из webview в приложение, а на COSPEX это ~250 элементов.
 *
 * Модуль чистый: типы и текст скрипта-сборщика. Сам скрипт исполняется
 * НЕ здесь, а внутри целевой страницы.
 */

/** Один элемент страницы. Ключи короткие — снимок передаётся целиком. */
export interface SnapNode {
  /** Индекс родителя в массиве; -1 у корня. */
  p: number;
  /** Тег в нижнем регистре. */
  t: string;
  /** Первый класс — для имени узла в редакторе. */
  c?: string;
  /** HTML id — переносится как якорь. */
  i?: string;
  /** Прямоугольник в координатах документа: x, y, ширина, высота. */
  r: [number, number, number, number];
  /** Вычисленные стили: только то, что влияет на модель. */
  s: Record<string, string>;
  /** Собственный текст элемента (без текста детей). */
  x?: string;
  /**
   * Тот же текст, но с метками (символ с кодом 0) на местах детей.
   * Пишется только когда хоть один ребёнок стоит не в конце — см. `ownText`.
   * У снимков, снятых до появления поля, его нет: читатель обязан
   * откатываться на `x`.
   */
  xm?: string;
  /** Атрибуты: src, href, alt, placeholder, type… */
  a?: Record<string, string>;
  /** Пропорции картинки из natural-размеров. */
  ar?: number;
  /** Разметка inline-svg, если она невелика. */
  svg?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  /** Ширина вьюпорта, при которой снимали: она же ширина страницы. */
  viewportWidth: number;
  viewportHeight: number;
  /** Полная высота документа. */
  documentHeight: number;
  /** Цвет фона страницы. */
  background: string;
  /** Семейства шрифтов, реально применённые на странице. */
  fonts: string[];
  nodes: SnapNode[];
  /** Сколько элементов пропущено как невидимые. */
  skipped: number;
  /** Сколько мс ждали сборки страницы. */
  settleMs: number;
}

/** Свойства, которые снимаем. Список закрытый: снимок не должен раздуваться. */
export const SNAP_PROPS = [
  "display", "position", "float",
  "flex-direction", "flex-wrap", "justify-content", "align-items", "align-self",
  "row-gap", "column-gap",
  "grid-template-columns", "grid-column-start", "grid-column-end",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "width", "height", "max-width", "min-height",
  "background-color", "background-image", "background-size", "background-position",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-color", "border-top-style", "border-radius",
  "color", "font-family", "font-size", "font-weight", "font-style",
  "line-height", "letter-spacing", "text-transform", "text-align", "text-decoration-line",
  "opacity", "object-fit", "overflow", "z-index", "aspect-ratio", "box-shadow",
  "white-space",
] as const;

/**
 * ТЕКСТ СКРИПТА-СБОРЩИКА.
 *
 * Возвращает функцию-строку, которую хост исполняет ВНУТРИ целевой страницы:
 * в Tauri — как initialization_script скрытого окна, в браузере — внутри
 * same-origin iframe. Один и тот же код для обоих путей: расхождение
 * сборщиков означало бы, что снимки несравнимы.
 *
 * Скрипт написан на ES5-подобном подмножестве без внешних зависимостей —
 * он попадает в чужую страницу, где нет ни сборки, ни полифилов.
 */
export function collectorScript(opts: { maxNodes?: number; settleMs?: number } = {}): string {
  const maxNodes = opts.maxNodes ?? 4000;
  const settleMs = opts.settleMs ?? 1200;
  return `
(function () {
  var PROPS = ${JSON.stringify(SNAP_PROPS)};
  var MAX_NODES = ${maxNodes};
  var SETTLE = ${settleMs};
  /* Метка места ребёнка в собственном тексте и перевод строки. Оба заданы
     кодами, а не литералами: текст сборщика едет сюда шаблонной строкой,
     где обратный слэш пришлось бы удваивать, и правка рядом молча ломала
     бы синтаксис уже внутри чужой страницы. */
  var MARK = String.fromCharCode(0);
  var NL = String.fromCharCode(10);
  /* Служебный знак для настоящего тега BR: отличает перенос разметки от
     перевода строки в исходнике, который в обычном абзаце — просто пробел. */
  var BR = String.fromCharCode(1);
  var SKIP = { SCRIPT:1, STYLE:1, LINK:1, META:1, NOSCRIPT:1, TEMPLATE:1, HEAD:1, TITLE:1, BASE:1, BR:1, WBR:1 };
  /* Значения, совпадающие с дефолтом браузера: в снимок не попадают.
     Сборщик сцены обязан трактовать отсутствие свойства как этот дефолт. */
  var DEFAULTS = {
    'position': 'static', 'float': 'none',
    'flex-direction': 'row', 'flex-wrap': 'nowrap',
    'justify-content': 'normal', 'align-items': 'normal', 'align-self': 'auto',
    'row-gap': 'normal', 'column-gap': 'normal',
    'grid-template-columns': 'none', 'grid-column-start': 'auto', 'grid-column-end': 'auto',
    'padding-top': '0px', 'padding-right': '0px', 'padding-bottom': '0px', 'padding-left': '0px',
    'margin-top': '0px', 'margin-right': '0px', 'margin-bottom': '0px', 'margin-left': '0px',
    'max-width': 'none', 'min-height': 'auto',
    'background-color': 'rgba(0, 0, 0, 0)', 'background-image': 'none',
    'background-size': 'auto', 'background-position': '0% 0%',
    'border-top-width': '0px', 'border-right-width': '0px',
    'border-bottom-width': '0px', 'border-left-width': '0px',
    'border-top-style': 'none', 'border-radius': '0px',
    'font-style': 'normal', 'letter-spacing': 'normal',
    'text-transform': 'none', 'text-align': 'start', 'text-decoration-line': 'none',
    'opacity': '1', 'object-fit': 'fill', 'overflow': 'visible', 'z-index': 'auto',
    'aspect-ratio': 'auto', 'box-shadow': 'none', 'white-space': 'normal'
  };

  /** Ждём, пока страница действительно собралась, а не просто загрузилась. */
  function waitReady(done) {
    var started = Date.now();
    function step() {
      var idle = Date.now() - started;
      var fontsOk = !document.fonts || document.fonts.status === 'loaded';
      // ждём шрифты и даём время гидратации; жёсткий потолок — 12 секунд
      if ((fontsOk && idle > SETTLE) || idle > 12000) { done(idle); return; }
      setTimeout(step, 150);
    }
    if (document.readyState === 'complete') step();
    else window.addEventListener('load', step, { once: true });
  }

  /**
   * СОБСТВЕННЫЙ ТЕКСТ ЭЛЕМЕНТА ВМЕСТЕ С МЕСТАМИ ДЕТЕЙ.
   *
   * Раньше собирался только текст, а места дочерних элементов терялись.
   * Сборщик сцены потом склеивал «свой текст, следом текст детей», и порядок
   * слов ломался на любом смешанном содержимом: ссылка вида
   * a > span«#» + «discuss» давала «discuss #», а абзац Википедии со
   * ссылками внутри превращался в текст, к которому все ссылки приписаны
   * хвостом. Для редактора страниц это порча содержимого, а не мелочь.
   *
   * Возвращает две строки: чистый текст (поле x, каким он был) и текст с
   * метками на местах детей (поле xm). Вторая пишется в снимок ТОЛЬКО когда
   * хоть один ребёнок стоит не в самом конце: если все дети хвостовые,
   * прежняя склейка и так верна, а лишнее поле удвоило бы текст.
   *
   * Нормализация пробелов прежняя (пробельные символы схлопываются в один
   * пробел, пробелы вокруг перевода строки убираются, края обрезаются), но
   * выполняется посимвольно: только так метку можно поставить между двумя
   * словами, сохранив разделяющий их пробел.
   */
  /* ПЕРЕВОД СТРОКИ В ИСХОДНИКЕ — ЭТО ПРОБЕЛ.
     В обычном абзаце (white-space: normal) браузер сворачивает перевод
     строки разметки в пробел: строки он раскладывает сам, по ширине
     колонки. Сборщик же писал перевод в снимок как есть, и дальше он
     доезжал до сцены жёстким переносом — абзац лонгрида в 585 знаков с
     одиннадцатью переводами в исходнике занимал двенадцать строк вместо
     восьми. Ошибка ЧИСТО в тексте: ширина совпадала точно.
     Настоящий перенос, тег BR, сохраняется: он значим при любом
     white-space, и отличить его от форматирования исходника можно
     только здесь, у самой разметки. */
  function ownText(el, collapseNl) {
    var raw = '';
    var marks = [];
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3) raw += n.nodeValue;
      else if (n.nodeType === 1 && n.tagName === 'BR') raw += BR;
      else if (n.nodeType === 1) marks.push(raw.length);
    }
    var plain = '';
    var mark = '';
    var sp = 0, nl = 0, mi = 0;
    for (var k = 0; k <= raw.length; k++) {
      while (mi < marks.length && marks[mi] === k) {
        // пробел перед меткой выносим в строку сразу: иначе он потеряется
        if (!nl && sp && mark) { mark += ' '; sp = 0; }
        mark += MARK;
        mi++;
      }
      if (k === raw.length) break;
      var ch = raw.charAt(k);
      if (ch === BR) { nl++; sp = 0; }
      else if (ch === NL && collapseNl) { if (!nl) sp = 1; }
      else if (ch === NL) { nl++; sp = 0; }
      else if (ch === ' ' || ch === String.fromCharCode(9) || ch === String.fromCharCode(13) || ch === String.fromCharCode(12) || ch === String.fromCharCode(11)) { if (!nl) sp = 1; }
      else {
        if (nl) {
          for (var q = 0; q < nl; q++) { if (plain) plain += NL; if (mark) mark += NL; }
          nl = 0; sp = 0;
        } else if (sp) {
          if (plain) plain += ' ';
          if (mark) mark += ' ';
          sp = 0;
        }
        plain += ch;
        mark += ch;
      }
    }
    return { text: plain, marked: mark };
  }

  var ATTRS = ['src','href','alt','placeholder','type','name','value','role','aria-label','data','loading','srcset'];
  function attrs(el) {
    var out = null;
    for (var i = 0; i < ATTRS.length; i++) {
      var v = el.getAttribute && el.getAttribute(ATTRS[i]);
      if (v) { out = out || {}; out[ATTRS[i]] = v.length > 500 ? v.slice(0, 500) : v; }
    }
    // имена data-атрибутов нужны для распознавания виджетов
    if (el.attributes) {
      var data = [];
      for (var j = 0; j < el.attributes.length; j++) {
        var nm = el.attributes[j].name;
        if (nm.indexOf('data-') === 0) data.push(nm);
      }
      if (data.length) { out = out || {}; out['_data'] = data.join(' '); }
    }
    return out;
  }

  function snap(done) {
    var nodes = [];
    var skipped = 0;
    var fonts = {};
    var sx = window.scrollX || 0, sy = window.scrollY || 0;

    function visit(el, parentIndex) {
      if (nodes.length >= MAX_NODES) return;
      if (SKIP[el.tagName]) return;

      var cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') { skipped++; return; }

      var box = el.getBoundingClientRect();
      var w = Math.round(box.width), h = Math.round(box.height);
      var ws = cs.whiteSpace || 'normal';
      var parts = ownText(el, ws.indexOf('pre') !== 0 && ws !== 'break-spaces');
      var text = parts.text;
      var hasKids = el.children && el.children.length > 0;
      // нулевой размер без текста и детей — служебная обёртка
      if (w <= 0 && h <= 0 && !text && !hasKids) { skipped++; return; }
      // элемент, уведённый далеко за пределы документа (скрытые подписи)
      if (box.left + sx < -2000 || box.top + sy < -5000) { skipped++; return; }

      // Значения по умолчанию не пишем: они занимают ~70% снимка, а смысла
      // не несут. Снимок едет через IPC-мост, его размер важен.
      var s = {};
      for (var i = 0; i < PROPS.length; i++) {
        var prop = PROPS[i];
        var v = cs.getPropertyValue(prop);
        if (!v) continue;
        if (DEFAULTS[prop] === v) continue;
        s[prop] = v;
      }
      if (s['font-family']) fonts[s['font-family']] = 1;

      var rec = {
        p: parentIndex,
        t: el.tagName.toLowerCase(),
        r: [Math.round(box.left + sx), Math.round(box.top + sy), w, h],
        s: s
      };
      if (el.className && typeof el.className === 'string') {
        var first = el.className.trim().split(/\\s+/)[0];
        if (first) rec.c = first.slice(0, 40);
      }
      if (el.id) rec.i = String(el.id).slice(0, 60);
      if (text) rec.x = text.length > 2000 ? text.slice(0, 2000) : text;
      /* Текст с местами детей пишем, только когда хоть один ребёнок стоит
         НЕ в конце: иначе склейка «свой текст, потом дети» и так верна, а
         поле удвоило бы текст в снимке. */
      var interior = parts.marked.replace(new RegExp(MARK + '+$'), '');
      if (interior !== parts.text && interior.indexOf(MARK) >= 0) {
        rec.xm = interior.length > 2200 ? interior.slice(0, 2200) : interior;
      }
      var a = attrs(el);
      if (a) rec.a = a;

      // пропорции картинки — из настоящих размеров файла
      if (el.tagName === 'IMG' && el.naturalWidth > 0 && el.naturalHeight > 0) {
        rec.ar = Math.round((el.naturalWidth / el.naturalHeight) * 1000) / 1000;
      }
      if (el.tagName === 'VIDEO' && el.videoWidth > 0) {
        rec.ar = Math.round((el.videoWidth / el.videoHeight) * 1000) / 1000;
      }
      // небольшой inline-svg переносим целиком: логотипы и иконки
      if (el.tagName === 'svg' || el.tagName === 'SVG') {
        var markup = el.outerHTML || '';
        if (markup && markup.length < 6000) rec.svg = markup;
        nodes.push(rec);
        return; // внутрь svg не идём
      }

      var myIndex = nodes.length;
      nodes.push(rec);
      var kids = el.children;
      for (var k = 0; k < kids.length; k++) visit(kids[k], myIndex);
    }

    var body = document.body;
    var bodyStyle = body ? window.getComputedStyle(body) : null;
    var htmlStyle = window.getComputedStyle(document.documentElement);
    var bg = (bodyStyle && bodyStyle.backgroundColor) || '';
    if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') {
      bg = htmlStyle.backgroundColor || 'rgb(255, 255, 255)';
    }

    if (body) {
      var kids = body.children;
      for (var i = 0; i < kids.length; i++) visit(kids[i], -1);
    }

    var famList = [];
    for (var f in fonts) if (fonts.hasOwnProperty(f)) famList.push(f);

    done({
      url: location.href,
      title: document.title || '',
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentHeight: Math.max(
        document.documentElement.scrollHeight,
        body ? body.scrollHeight : 0
      ),
      background: bg,
      fonts: famList,
      nodes: nodes,
      skipped: skipped,
      settleMs: 0
    });
  }

  return new Promise(function (resolve) {
    waitReady(function (idle) {
      snap(function (result) {
        result.settleMs = idle;
        resolve(result);
      });
    });
  });
})()
`.trim();
}

/* ------------------------------------------------------------------ */
/* Разбор значений снимка: всё уже в пикселях и rgb()                  */
/* ------------------------------------------------------------------ */

/** `"24px"` → 24. В снимке все длины — вычисленные пиксели. */
export const snapPx = (value: string | undefined): number => {
  if (!value) return 0;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

/** `"rgb(7, 26, 21)"` / `"rgba(…, .96)"` → hex + альфа. */
export function snapColor(value: string | undefined): { hex: string; alpha: number } | null {
  if (!value) return null;
  const v = value.trim();
  if (!v || v === "transparent" || v === "none") return null;
  const m = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (!m) return /^#[0-9a-f]{3,8}$/i.test(v) ? { hex: v.slice(0, 7).toLowerCase(), alpha: 1 } : null;
  const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  const [r, g, b] = parts;
  const a = parts.length > 3 ? parts[3] : 1;
  if (![r, g, b].every((n) => Number.isFinite(n))) return null;
  const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return { hex: `#${hex2(r)}${hex2(g)}${hex2(b)}`, alpha: Number.isFinite(a) ? a : 1 };
}

/**
 * ИЗМЕРЕННЫЕ ширины дорожек в пикселях, как их посчитал браузер.
 *
 * В отличие от `snapTracks` здесь ничего не сворачивается в доли: это сырьё
 * для сопоставления детей с дорожками по геометрии. Имена линий в
 * вычисленном значении приходят в квадратных скобках
 * (`[content-start] 60px [content-end]`) и на дорожки не влияют —
 * `parseFloat("[content-start]")` даёт NaN, такие лексемы отбрасываем.
 */
export function snapTrackPx(value: string | undefined): number[] | null {
  if (!value || value === "none") return null;
  const nums = value.split(/\s+/).map((t) => parseFloat(t)).filter((n) => Number.isFinite(n));
  return nums.length > 0 ? nums : null;
}

/**
 * `grid-template-columns` из снимка — это УЖЕ использованные пиксели
 * (`"297.5px 297.5px 297.5px"`), а не исходные `1fr 1fr 1fr`.
 * Равные дорожки сворачиваем в доли: так сетка останется адаптивной,
 * а не застынет на ширине, при которой снимали.
 */
export function snapTracks(value: string | undefined): Array<{ fr?: number; px?: number }> | null {
  if (!value || value === "none") return null;
  const nums = value.split(/\s+/).map((t) => parseFloat(t)).filter((n) => Number.isFinite(n));
  if (nums.length < 2) return null;
  const max = Math.max(...nums);
  // все дорожки нулевые — сетки как таковой нет
  if (!(max > 0)) return null;
  /* Делитель для долей — наименьшая ПОЛОЖИТЕЛЬНАЯ дорожка. Пустые дорожки
     в вычисленном стиле встречаются постоянно (`grid-template-columns:
     repeat(3, 1fr) 0px` у сеток с пустой служебной колонкой), и деление на
     ноль давало `fr: Infinity`. Дальше frTotal тоже уходил в Infinity, а
     `free * Infinity / Infinity` — уже NaN: на stripe.com 74 узла получали
     ширину NaN и просто исчезали с холста. */
  const min = Math.min(...nums.filter((n) => n > 0));
  // разброс меньше 2% — считаем колонки равными
  if (max - min < max * 0.02 && nums.every((n) => n > 0)) return nums.map(() => ({ fr: 1 }));
  // иначе доли пропорционально измеренным ширинам: сайдбар и асимметрия
  return nums.map((n) =>
    n <= 0 || (n < 200 && n / max < 0.35)
      ? { px: Math.max(0, Math.round(n)) }
      : { fr: Math.round((n / min) * 100) / 100 },
  );
}

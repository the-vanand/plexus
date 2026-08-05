/**
 * СНИМОК ЖИВОЙ СТРАНИЦЫ → scene graph.
 *
 * Второй путь импорта, рядом с разбором HTML (`importer.ts`). Разница
 * принципиальная: здесь НЕТ вычисления CSS. Браузер уже посчитал каскад,
 * специфичность, `clamp()`, `vw`, проценты, медиазапросы и веб-шрифты —
 * в снимке лежат готовые пиксели, разрешённые цвета и точные прямоугольники.
 *
 * Поэтому этот модуль занят единственной содержательной задачей:
 * **превратить измеренную геометрию обратно в auto-layout.** Абсолютные
 * координаты дали бы точную, но мёртвую копию — её нельзя редактировать.
 * Поэтому режим раскладки берём из вычисленного `display`, а измеренные
 * прямоугольники используем там, где вычисленный стиль врёт или молчит:
 *
 *  - `margin-inline: auto` в вычисленном стиле уже развёрнут в пиксели,
 *    поэтому центрирование определяется по геометрии: блок стоит по центру
 *    содержимого родителя и уже́ его;
 *  - `grid-template-columns` приходит использованными пикселями, равные
 *    дорожки сворачиваются обратно в доли (иначе сетка застынет на той
 *    ширине, при которой снимали);
 *  - absolute-смещения считаются как разница прямоугольников — точно.
 *
 * Модуль чистый: ни DOM, ни Pixi, ни React.
 */
import type { GridTrack, LayoutType, SceneDocument, SceneNode, Sides } from "./types";
import { createNode, packPadding } from "./scene";
import { withDeterministicIds } from "./ids";
import { matchBySignature, matchByUrl, type WidgetMatch } from "./css/widgets";
import { snapColor, snapPx, snapTrackPx, snapTracks, type PageSnapshot, type SnapNode } from "./snapshot";

export interface SnapshotImportOptions {
  snapshot: PageSnapshot;
  pageName?: string;
  /** База для относительных ссылок на картинки. */
  baseUrl?: string;
  /**
   * Собрать соответствие «узел сцены → индекс в снимке».
   *
   * Нужно только стендам: без него сверить с измеренной геометрией можно
   * лишь текстовые узлы (по совпадению текста), а контейнеры — те, в которых
   * и накапливается ошибка высоты, — остаются невидимыми. В приложении
   * выключено: держать лишнюю карту на каждый импорт незачем.
   */
  trace?: boolean;
}

export interface SnapshotImportOutcome {
  frameId: string;
  nodesAdded: number;
  warnings: string[];
  widgets: string[];
  fontFamilies: string[];
  /** Сколько узлов снимка отброшено как служебные обёртки. */
  collapsed: number;
  /** Узел сцены → индекс в снимке; заполняется только при `trace`. */
  trace?: Map<string, number>;
}

/** Строчные теги: внутри абзаца они не должны рвать текст на блоки. */
const INLINE = new Set([
  "span", "strong", "em", "b", "i", "u", "small", "mark", "code", "time", "sup", "sub",
  "abbr", "cite", "q", "s", "del", "ins", "var", "kbd", "samp", "bdi", "bdo", "a", "label",
]);

/**
 * СТРОЧНОСТЬ ЧИТАЕТСЯ ИЗ `display`, А НЕ УГАДЫВАЕТСЯ ПО ИМЕНИ ТЕГА.
 *
 * Список `INLINE` закрыт по построению: в нём стандартные теги HTML. Но
 * страница вправе объявить строчным ЛЮБОЙ элемент, и научные лонгриды этим
 * пользуются постоянно — `<d-cite>`, `<d-footnote>`, `<x-ref>` у
 * distill.pub, `<mj-x>` у формул, тысячи веб-компонентов в дизайн-системах.
 * Браузер про каждый из них честно сообщает `display: inline` или
 * `inline-block`, а проверка по имени тега отвечала «не строчный», и абзац
 * с таким ребёнком терял право быть абзацем: он становился контейнером, а
 * контейнер собственного текста не несёт. На distill.pub так исчезал
 * ОСНОВНОЙ ТЕКСТ СТАТЬИ — 40 абзацев шириной 704px и высотой 144–259px, и
 * поиск по «We believe that neural networks consist» не находил в сцене
 * ничего.
 *
 * Проверка АДДИТИВНА к списку тегов: тег остаётся достаточным признаком
 * (ссылка с `display: block` в карточке по-прежнему считается строчной там,
 * где так было раньше), а `display` лишь добавляет случаи, которых список
 * знать не может.
 */
const isInlineNode = (k: SnapNode): boolean => {
  if (INLINE.has(k.t)) return true;
  const disp = (k.s["display"] ?? "").trim();
  return disp.startsWith("inline") || disp === "ruby" || disp === "ruby-text";
};

const FIELD_TAGS = new Set(["input", "textarea", "select"]);

/** Содержимое, которое подписью не заменишь. */
const MEDIA_TAGS = new Set(["img", "picture", "svg", "video", "iframe", "canvas", "embed", "object", "input", "textarea", "select"]);

/**
 * Метка места ребёнка в собственном тексте элемента (поле `xm` снимка).
 * Тот же символ, что ставит сборщик, — здесь он читается.
 */
const MARK = String.fromCharCode(0);

/**
 * ПОТОЛОК ЧИСЛА УЗЛОВ СЦЕНЫ.
 *
 * Раньше стояло 2000, и это резало страницу ровно посередине: у статьи
 * Википедии в снимке 4000 элементов, в сцену попадала первая половина —
 * дальше шёл обрыв без всякого признака на холсте, только строчка в логе.
 * Потолок нужен как предохранитель от бесконечного документа, но он обязан
 * лежать ВЫШЕ ёмкости сборщика снимка (`collectorScript`, maxNodes), иначе
 * он срабатывает не в аварийном случае, а на каждой длинной статье.
 */
const MAX_SCENE_NODES = 20000;

/** Область видимости в координатах документа: что не режут предки. */
interface Clip {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * Импорт снимка с ДЕТЕРМИНИРОВАННЫМИ id (см. `withDeterministicIds`).
 *
 * Для снимка это важнее, чем для разбора HTML: снимок — это зафиксированный
 * файл, и повторный прогон обязан давать тот же документ, иначе стенд не
 * отличит регрессию решателя от смены случайных id.
 */
export function importSnapshotToDoc(
  doc: SceneDocument,
  opts: SnapshotImportOptions,
): SnapshotImportOutcome {
  const seed = [
    opts.snapshot.url,
    opts.snapshot.viewportWidth,
    opts.snapshot.nodes.length,
    Object.keys(doc.nodes).length,
  ].join("|");
  return withDeterministicIds(seed, () => importSnapshotToDocInner(doc, opts));
}

function importSnapshotToDocInner(
  doc: SceneDocument,
  opts: SnapshotImportOptions,
): SnapshotImportOutcome {
  const snap = opts.snapshot;
  const warnings: string[] = [];
  const widgets: string[] = [];
  const fonts = new Set<string>();
  let collapsed = 0;
  let added = 0;
  const trace = opts.trace ? new Map<string, number>() : undefined;

  /** Дети каждого узла снимка. */
  const kids = new Map<number, number[]>();
  snap.nodes.forEach((n, idx) => {
    const arr = kids.get(n.p);
    if (arr) arr.push(idx);
    else kids.set(n.p, [idx]);
  });

  const pageW = Math.max(320, Math.round(snap.viewportWidth || 1440));

  /* ---------- рамка страницы ---------- */
  const frame = createNode("frame", opts.pageName || snap.title.slice(0, 40) || "Импорт");
  let maxRight = 160;
  let topY = 120;
  for (const id of doc.rootFrames) {
    const f = doc.nodes[id]!;
    const w = typeof f.layout.width === "number" ? f.layout.width : 1200;
    maxRight = Math.max(maxRight, f.layout.x + w + 120);
    topY = Math.min(topY, f.layout.y);
  }
  frame.layout.x = doc.rootFrames.length === 0 ? 160 : maxRight;
  frame.layout.y = topY;
  frame.layout.width = pageW;
  /* СТРАНИЦА НЕ КОРОЧЕ ЭКРАНА. `documentElement.scrollHeight` никогда не
     меньше вьюпорта, и короткая страница (example.com — четыре абзаца)
     измеряется ровно в высоту окна. Считая высоту только по содержимому,
     импорт расходился с измеренной на всё пустое место внизу — 69% на
     example.com. Числовая высота в решателе — МИНИМУМ, поэтому длинной
     странице это ничего не меняет. */
  frame.layout.height = Math.max(1, Math.round(snap.viewportHeight || 0)) || "hug";
  frame.layout.padding = 0;
  const bg = snapColor(snap.background);
  frame.style.fill = bg && bg.alpha > 0 ? bg.hex : "#ffffff";
  frame.parent = null;
  doc.nodes[frame.id] = frame;
  doc.rootFrames.push(frame.id);
  added += 1;

  /* ---------- вспомогательное ---------- */

  const sides = (n: SnapNode, prefix: "padding" | "margin"): Sides => ({
    t: Math.round(snapPx(n.s[`${prefix}-top`])),
    r: Math.round(snapPx(n.s[`${prefix}-right`])),
    b: Math.round(snapPx(n.s[`${prefix}-bottom`])),
    l: Math.round(snapPx(n.s[`${prefix}-left`])),
  });

  const resolveSrc = (raw: string | undefined): string | undefined => {
    if (!raw) return undefined;
    const s = raw.trim();
    if (!s || s.startsWith("data:")) return s || undefined;
    if (/^https?:\/\//i.test(s)) return s;
    const base = opts.baseUrl ?? snap.url;
    try {
      return new URL(s, base).href;
    } catch {
      return s;
    }
  };

  /** Виджет по ссылке или по классам — тот же каталог, что у HTML-импорта. */
  const widgetOf = (n: SnapNode): WidgetMatch | null => {
    if (n.t === "iframe" || n.t === "embed" || n.t === "object") {
      return matchByUrl(n.a?.src ?? n.a?.data);
    }
    if (n.t === "video") return { kind: "video", label: "Видео", provider: "file", ratio: n.ar ?? 16 / 9 };
    if (n.t === "canvas") return { kind: "embed", label: "Canvas-графика", ratio: 16 / 9, note: "рисование на canvas не переносится" };
    return matchBySignature(`${n.c ?? ""} ${n.i ?? ""} ${n.a?._data ?? ""}`);
  };

  /**
   * ОБЛАСТЬ ВИДИМОСТИ, заданная обрезающими предками.
   *
   * `overflow: hidden` (и `clip`) режет содержимое без возможности
   * прокрутить — то, что за краем, на странице увидеть нельзя. `auto` и
   * `scroll` не режем: там пользователь докрутит, содержимое настоящее, и
   * выбрасывать его из редактируемой копии нельзя. Вертикальный размер
   * такой коробки ограничивается отдельно — см. `clippedHeight`.
   */
  const clipOf = (n: SnapNode, outer: Clip | null, idx?: number): Clip | null => {
    const raw = (n.s["overflow"] ?? "visible").trim();
    if (!raw || raw === "visible") return outer;
    const parts = raw.split(/\s+/);
    const cut = (v: string) => v === "hidden" || v === "clip";
    /* ЛЕНТА НЕ РЕЖЕТ ПО ГОРИЗОНТАЛИ, ОНА ПРОКРУЧИВАЕТСЯ.
       `overflow-x: hidden` на карусели — не «этого не видно», а «полосу
       прокрутки не рисуем, крутим скриптом»: содержимое настоящее и
       пользователю доступно. Ровно так это и трактует `scrollsX`, оставляя
       детям измеренные ширины. Но `clipOf` тот же самый `hidden` считал
       обрезкой, и дети за краем выбрасывались как невидимые — два правила
       про одну коробку говорили противоположное.
       Цена расхождения велика и целиком в К5: у bandcamp.com так пропадали
       389 узлов и 37 фотографий из 80, у linktree.com 155 узлов, у
       clerk.com — весь блок отзывов. По вертикали `hidden` по-прежнему
       режет: вертикальная лента прокруткой не крутится (см. `clippedHeight`),
       и там старое поведение верно. */
    const scrolly = parts[0] === "auto" || parts[0] === "scroll";
    /* ЛЕНТА, КОТОРУЮ КРУТЯТ, И БЕГУЩАЯ СТРОКА — РАЗНЫЕ ВЕЩИ.
       Прокрутчик в покое начинается у своего левого края: пользователь
       крутит его вправо, и всё содержимое достижимо. Бегущая строка
       (`animation` по трансформации) в момент съёмки СДВИНУТА — её
       содержимое начинается ЛЕВЕЕ коробки, часть уже ушла из вида, и
       ставить такую ленту в ряд нельзя: у bun.sh лента твитов 5836px в
       коробке 1410 начинается с x=-114, и ряд ужимал 22 карточки до 61%
       точности по X. Признак измеренный: левый край содержимого. */
    const startsInside = (): boolean => {
      if (idx === undefined) return false;
      const ch = (kids.get(idx) ?? []).map((c) => snap.nodes[c]).filter((k) => k.r[2] > 1 && k.r[3] > 1);
      return ch.length > 0 && Math.min(...ch.map((k) => k.r[0])) >= n.r[0] - 2;
    };
    const ribbon =
      idx !== undefined && (scrolly || (cut(parts[0]) && scrollsX(idx, n))) && startsInside();
    const box: Clip = {
      x0: cut(parts[0]) && !ribbon ? n.r[0] : -Infinity,
      x1: cut(parts[0]) && !ribbon ? n.r[0] + n.r[2] : Infinity,
      y0: cut(parts[1] ?? parts[0]) ? n.r[1] : -Infinity,
      y1: cut(parts[1] ?? parts[0]) ? n.r[1] + n.r[3] : Infinity,
    };
    if (!outer) return box;
    return {
      /* ЛЕНТА СНИМАЕТ ОБРЕЗКУ ПРЕДКА ПО ГОРИЗОНТАЛИ. Содержимое внутри
         горизонтального прокрутчика доступно прокруткой самого прокрутчика,
         и чем обрезана ЕГО коробка — неважно: он выводит содержимое в вид
         сам. Карусели устроены двухслойно — `section { overflow: hidden }`
         снаружи, `ul { overflow-x: scroll }` внутри, — и обрезка внешнего
         слоя выбрасывала всю ленту: у bandcamp.com 389 узлов и 37
         фотографий из 80, у linktree.com 155 узлов. */
      x0: ribbon ? -Infinity : Math.max(outer.x0, box.x0),
      x1: ribbon ? Infinity : Math.min(outer.x1, box.x1),
      y0: Math.max(outer.y0, box.y0),
      y1: Math.min(outer.y1, box.y1),
    };
  };

  /**
   * ПРЯМОУГОЛЬНИК ЦЕЛИКОМ ВНЕ ОБЛАСТИ ВИДИМОСТИ (допуск 1px на округление).
   *
   * СХЛОПНУТАЯ ОСЬ ИЗ ПРОВЕРКИ ИСКЛЮЧЕНА. Коробка нулевой высоты, стоящая
   * ровно на верхней границе обрезки, формально удовлетворяет «нижний край
   * не ниже верхней границы» — и уносила с собой всё поддерево. Это не
   * редкий случай, а самая ходовая идиома отзывчивой картинки: обёртка
   * `position: relative; padding-bottom: 56.25%; overflow: hidden`, внутри
   * ссылка (её единственный ребёнок абсолютный, поэтому высота нулевая) и
   * абсолютная `<img>`. На ленте npr.org так терялись 30 фотографий из 34 и
   * 2202px высоты; на верстке остаётся пустая рамка.
   *
   * Схлопнутая коробка сама по себе НЕ обрезана: обрезать нечего. Судить о
   * ней надо по положению точки, а не по краям, которых нет.
   */
  const outsideAxis = (lo: number, size: number, c0: number, c1: number): boolean =>
    size > 1 ? lo + size <= c0 + 1 || lo >= c1 - 1 : lo < c0 - 1 || lo > c1 + 1;

  const outsideClip = (n: SnapNode, clip: Clip): boolean =>
    outsideAxis(n.r[0], n.r[2], clip.x0, clip.x1) || outsideAxis(n.r[1], n.r[3], clip.y0, clip.y1);

  /**
   * ВНЕ ПОТОКА: absolute, fixed и ПЛАВАЮЩИЕ блоки.
   *
   * `float` из нормального потока выведен по спецификации ровно так же, как
   * absolute: соседние блоки его не обходят, их коробки идут ПОД ним, а
   * обтекает только строчное содержимое. Пока плавающий блок оставался в
   * потоке, он добавлял свою высоту к родителю и сдвигал всех следующих
   * соседей вниз: карточка новости на gsmarena.com (151px, картинка 181px
   * слева) вырастала до 274px, и так тридцать раз подряд — 27% высоты
   * страницы; кнопка «копировать» в документации Bootstrap уводила код на
   * 760px вправо.
   *
   * Обтекание текстом модель холста не воспроизводит: строку с обтеканием
   * нельзя выразить ни рядом, ни колонкой. Поэтому плавающий блок ставится
   * там, где его измерил браузер, — и это единственное место, где импорт
   * пользуется absolute не потому, что так написано в оригинале, а потому,
   * что честнее ничего нет. Таких узлов единицы: `float` встречается на
   * пяти снимках из тридцати и никогда не превышает 3% узлов страницы.
   */
  const isFloat = (n: SnapNode): boolean => {
    const fl = (n.s["float"] ?? "none").trim();
    if (fl !== "left" && fl !== "right" && fl !== "inline-start" && fl !== "inline-end") return false;
    /* НА FLEX- И GRID-ЭЛЕМЕНТЕ `float` НЕ ДЕЙСТВУЕТ.
       Спецификация прямо говорит: `float` на элементе flex- или
       grid-контейнера игнорируется, элемент остаётся в раскладке родителя.
       `getComputedStyle` при этом честно возвращает `left` — свойство-то
       задано, — и импорт выводил такой элемент из потока в absolute. На
       каталоге gutenberg.org каждая карточка — `<a style="display:flex">` с
       `<span style="float:left">` под обложку: обложка уходила в absolute,
       а название и автор занимали её место, уезжая на 105px. Точность по X
       45% — единственный балл 1 по К2 на наборе. */
    const par = n.p >= 0 ? snap.nodes[n.p] : null;
    const pd = (par?.s["display"] ?? "").trim();
    if (pd.includes("flex") || pd.includes("grid")) return false;
    return true;
  };

  /**
   * ПЛАВАЮЩИЕ КОЛОНКИ — ЭТО РЯД, А НЕ ТРИ АБСОЛЮТНЫХ БЛОКА.
   *
   * `float` вывели из потока (см. выше) ради обтекания: там модель ряда
   * заведомо неверна, потому что текст обходит картинку сбоку. Но у `float`
   * есть ВТОРОЕ, куда более распространённое применение — двухколоночная
   * вёрстка старой школы: `main { float: left }` + `aside { float: right }`
   * внутри общей обёртки. Обтекания там нет вовсе: колонки стоят рядом и
   * делят ширину, а обёртка схлопывается в нулевую высоту, потому что
   * очистки в ней нет (её ставит следующий блок).
   *
   * Признак измеренный и не гадательный: у родителя НЕТ ни одного
   * непустого ребёнка в потоке (обтекать нечем) и плавающие дети не
   * перекрываются по горизонтали (стоят колонками, а не наложены). Тогда
   * это ряд: дети остаются в потоке, ширину и порядок берёт решатель, а
   * высота обёртки вырастает из детей сама.
   *
   * Разница на документации Django: обёртка `div.container` измерена как
   * 1440×0 и уносила с собой 575 узлов из 700 — весь текст статьи.
   */
  /** Вне потока БЕЗ учёта исключения ниже — нужно самому исключению. */
  const outOfFlowStatic = (n: SnapNode): boolean => {
    const pos = (n.s["position"] ?? "static").trim();
    return pos === "absolute" || pos === "fixed" || isFloat(n);
  };

  /**
   * СЪЕЛА ЛИ СТРАНИЦА ВЫСОТУ ВЫВЕДЕННОГО ИЗ ПОТОКА СОДЕРЖИМОГО.
   *
   * Нулевая высота обёртки говорит только о ней самой. Дальше возможны два
   * исхода, и различает их измеренная геометрия соседа снизу:
   *  - следующий блок стоит ПОД содержимым (у него `clear`, свой контекст
   *    форматирования или просто дальше по странице) — значит страница
   *    высоту учла, и обёртка обязана её вернуть. Документация Django:
   *    футер измерен на 6159, ровно под колонкой в 6003px;
   *  - следующий блок стоит СРАЗУ за обёрткой, а выведенный из потока блок
   *    лежит ПОВЕРХ него — высоты страница не считала, и добавлять её
   *    нельзя. Лонгрид martinfowler.com: врезка `aside` 650×0 наложена на
   *    текст статьи, и высота 584px была бы лишней (плюс 2472px по
   *    разделу). Витрина store.steampowered.com: обёртка 1440×0 с
   *    абсолютной каруселью 1440×450 под содержимым — 450px лишних.
   * Соседа берём ближайшего непустого, а на его отсутствии — нижний край
   * родителя; у корневых узлов роль родителя играет страница.
   */
  const heightReserved = (idx: number, bottom: number): boolean => {
    const n = snap.nodes[idx];
    const sibs = kids.get(n.p) ?? [];
    let after = Number.NaN;
    for (let i = sibs.indexOf(idx) + 1; i < sibs.length; i++) {
      const s = snap.nodes[sibs[i]];
      if (s.r[2] > 1 && s.r[3] > 1 && !outOfFlowStatic(s)) {
        after = s.r[1];
        break;
      }
    }
    if (!Number.isFinite(after)) {
      const par = n.p >= 0 ? snap.nodes[n.p] : null;
      after = par && par.r[3] > 1 ? par.r[1] + par.r[3] : Math.max(1, snap.documentHeight);
    }
    return after >= bottom - 2;
  };

  const floatRow = new Set<SnapNode>();
  /** Сколько бокового отступа у соседа съедает плавающая колонка (см. ниже). */
  const floatClear = new Map<SnapNode, { l: number; r: number }>();
  snap.nodes.forEach((n, idx) => {
    const ch = kids.get(idx) ?? [];
    const floats = ch.filter((c) => isFloat(snap.nodes[c]));
    if (floats.length === 0) return;

    /* САЙДБАР ПЛЮС КОНТЕНТ — САМЫЙ ХОДОВОЙ ШАБЛОН ПЛАВАЮЩЕЙ ВЁРСТКИ,
       и в нём плавающая колонка соседствует не с другой плавающей, а с
       ОБЫЧНЫМ блоком: `.sidebar { float: left; width: 260px }` рядом с
       `.content { margin-left: 260px }`. Правило ниже отсекало такую
       обёртку по признаку «есть непустой сосед в потоке — значит
       обтекание», и колонки вставали друг под друга: на itch.io/games
       6132px вместо 3626 (ошибка высоты 65.9%), а сетка карточек, сама по
       себе почти точная, уезжала с y=382 на y=2705.

       Обтекание от колонок отличается измеренной геометрией, а не
       гаданием: при обтекании блок в потоке ЗАНИМАЕТ всю ширину обёртки и
       плавающий блок лежит поверх него, а колонка стоит СБОКУ — её левый
       край не левее правого края плавающей колонки (для `float: left`) и
       наоборот для `float: right`. Проверяем именно это; всё, что не
       разложилось в колонки, идёт прежним путём. */
    const realFloats = floats.map((c) => snap.nodes[c]).filter((k) => k.r[2] > 1 && k.r[3] > 1);
    const flowSibs = ch
      .map((c) => snap.nodes[c])
      .filter((k) => !isFloat(k) && k.r[2] > 1 && k.r[3] > 1);
    if (flowSibs.length > 0) {
      /* РОВНО ОДИН СОСЕД В ПОТОКЕ. «Сайдбар плюс контент» — это ДВЕ
         колонки, и ряд из двух узлов их выражает точно. Когда в потоке
         несколько блоков подряд, они образуют СВОЮ колонку рядом с
         плавающей, а ряда из «колонки и блока» в дереве нет: узла-обёртки
         под неё в снимке не существует, и решатель раскладывал три коробки
         (432, 40, 40) как попало — на ленте apnews.com это давало +863px по
         dy и теряло 32 узла. Такой случай идёт прежним путём. */
      if (flowSibs.length !== 1) return;
      if (realFloats.length === 0 || realFloats.length !== floats.length) return;
      if (n.r[2] <= 1 || n.r[3] <= 1) return;
      if ((n.x ?? "").trim()) return;
      const pad = sides(n, "padding");
      const cl = n.r[0] + pad.l + snapPx(n.s["border-left-width"]);
      const cr = n.r[0] + n.r[2] - pad.r - snapPx(n.s["border-right-width"]);
      /* ПЛАВАЮЩАЯ КОЛОНКА ОБЯЗАНА СТОЯТЬ ВНУТРИ ОБЁРТКИ И ЗАБИРАТЬ ЧАСТЬ
         ЕЁ ШИРИНЫ. Иначе это не колонка, а вынесенная на поля врезка:
         лонгрид martinfowler.com держит `aside { float: right; margin-left:
         25.6px }` ПРАВЕЕ колонки текста (x 948 при обёртке 248…898), а сами
         абзацы занимают всю ширину обёртки. Ряда там нет: врезка висит на
         поле, и ряд добавил бы 979px по dy и 11% высоты. */
      const widest = Math.max(...realFloats.map((f) => f.r[2]));
      const inside = realFloats.every((f) => f.r[0] >= cl - 2 && f.r[0] + f.r[2] <= cr + 2);
      if (!inside) return;
      if (flowSibs.some((s) => cr - cl - s.r[2] < widest - 2)) return;
      const beside = realFloats.every((f) => {
        const right = (f.s["float"] ?? "").trim();
        const rightSide = right === "right" || right === "inline-end";
        return flowSibs.every((s) =>
          rightSide ? s.r[0] + s.r[2] <= f.r[0] + 2 : s.r[0] >= f.r[0] + f.r[2] - 2,
        );
      });
      if (!beside) return;
      /* …И ДОКУМЕНТНЫЙ ПОРЯДОК ОБЯЗАН СОВПАДАТЬ С ЭКРАННЫМ.
         Ряд в модели холста растёт слева направо в порядке дерева, а
         `float: right` ставит колонку СПРАВА, оставаясь в разметке ПЕРВОЙ.
         Восстановить такой ряд перестановкой нельзя: геометрический вывод
         раскладки (`inferFlowLayout`) читает строку по документному
         порядку и на перевёрнутой паре видит две строки, то есть столбик, —
         на ленте npr.org фотография вставала НАД текстом (+453px по dy,
         +2.6% высоты), на who.int ссылка «Читать далее» — над заголовком.
         Перевёрнутый случай идёт прежним путём: колонка остаётся
         абсолютной, зато на своём месте. */
      const parts = ch.map((c) => snap.nodes[c]).filter((k) => realFloats.includes(k) || flowSibs.includes(k));
      for (let i = 1; i < parts.length; i++) {
        if (parts[i].r[0] < parts[i - 1].r[0] + parts[i - 1].r[2] - 2) return;
      }
      /* …И КОЛОНКИ ОБЯЗАНЫ ДЕЛИТЬ ШИРИНУ ОБЁРТКИ, А НЕ СТОЯТЬ ПО КРАЯМ.
         Ряд ставит соседей вплотную, поэтому просвет между ними он
         воспроизводит только отступом. Заголовок 690px и прижатая к правому
         краю ссылка 87px в обёртке 1380px — не две колонки, а строка с
         выключкой по краям: ряд подтянул бы ссылку к заголовку на 603px
         (портал who.int, точность по X −4%). Настоящие колонки покрывают
         ширину содержимого почти целиком.
         …и НАЧИНАЮТСЯ ОТ ОДНОГО ВЕРХА: колонка, опущенная относительно
         соседа (выключка по центру у карточки theverge.com — 41px), в ряду
         встаёт по его верху, и весь текст внутри уезжает на эту разницу. */
      const cover = parts.reduce((a, k) => a + k.r[2], 0);
      if (cover < (cr - cl) * 0.9) return;
      const contentTop = n.r[1] + pad.t + snapPx(n.s["border-top-width"]);
      if (parts.some((k) => k.r[1] > contentTop + 2)) return;
      /* …и высота обёртки обязана быть высотой самой длинной колонки:
         иначе ряд её не воспроизведёт. У обёртки без очистки высоту даёт
         блок в потоке, у обёртки с очисткой — максимум по всем детям. */
      const contentBottom = n.r[1] + n.r[3] - pad.b;
      const low = Math.max(...[...realFloats, ...flowSibs].map((k) => k.r[1] + k.r[3]));
      if (Math.abs(low - contentBottom) > Math.max(6, n.r[3] * 0.15)) return;
      for (const k of realFloats) floatRow.add(k);
      /* ОТСТУП, ОСВОБОЖДАВШИЙ МЕСТО ПЛАВАЮЩЕЙ КОЛОНКЕ, В РЯДУ ЛИШНИЙ.
         Блок рядом с сайдбаром отодвигают от него `margin-left`ом ровно на
         ширину сайдбара (`.column { margin-left: 260px }` на itch.io). В
         блочном потоке это единственный способ не залезть под плавающую
         колонку; в ряду место уже занято самой колонкой, и отступ считается
         второй раз — сетка карточек уезжала на 260px вправо (точность по X
         14%). Вычитаем ровно то, что съел плавающий сосед, остаток
         (настоящий жёлоб между колонками) сохраняем. */
      for (const s of flowSibs) {
        let eatL = 0;
        let eatR = 0;
        for (const f of realFloats) {
          const side = (f.s["float"] ?? "").trim();
          if (side === "right" || side === "inline-end") eatR = Math.max(eatR, cr - f.r[0]);
          else eatL = Math.max(eatL, f.r[0] + f.r[2] - cl);
        }
        if (eatL > 0 || eatR > 0) floatClear.set(s, { l: Math.round(eatL), r: Math.round(eatR) });
      }
      return;
    }
    /* ОБЁРТКА С ОЧИСТКОЙ — ТОЖЕ РЯД, ЕСЛИ ЕЁ ВЫСОТУ ДАЮТ САМИ КОЛОНКИ.
       Раньше исключение брало только СХЛОПНУВШУЮСЯ обёртку (высота 0),
       потому что у обёртки с очисткой (`clearfix`, `overflow: hidden`,
       `display: flow-root`) измеренная высота честна, и считать её по
       детям было рискованно. Но целые сайты сверстаны плавающей сеткой
       С очисткой: портал who.int собран Sitefinity, где каждая колонка —
       `div.sf_colsIn { float: left }` внутри обёртки с честной высотой.
       Из 425 узлов страницы 113 уходили в absolute — редактируемость 73%,
       ниже порога шкалы даже на балл 4, при идеальной геометрии. Это
       ровно тот обмен «точность за мёртвую копию», который К7 запрещает.

       Условие, при котором ряд ВОСПРОИЗВОДИТ измеренную высоту, а не
       ломает её: низ самой высокой колонки совпадает с низом содержимого
       обёртки. Тогда высота обёртки и есть высота колонок, и модель ряда
       её вернёт. Если не совпадает — в обёртке есть что-то ещё (отступы
       строки, наложение), и старое поведение честнее. Именно этот случай
       и портил govuk.uk на 18% высоты, когда правило стояло без проверки. */
    if (n.r[3] > 1) {
      const pad = sides(n, "padding");
      const contentBottom = n.r[1] + n.r[3] - pad.b;
      const real = floats.map((c) => snap.nodes[c]).filter((k) => k.r[2] > 1 && k.r[3] > 1);
      if (real.length !== floats.length || real.length === 0) return;
      const low = Math.max(...real.map((k) => k.r[1] + k.r[3]));
      if (Math.abs(low - contentBottom) > Math.max(6, n.r[3] * 0.15)) return;
      /* …и колонки обязаны НАЧИНАТЬСЯ У ЛЕВОГО КРАЯ содержимого обёртки.
         Ряд в модели холста растёт слева направо, поэтому прижатое к
         правому краю меню он выложит не там, где оно стоит: на
         martinfowler.com пять пунктов навигации (x 484, 589, 644) уезжали
         влево на 236px. Плавающая СЕТКА начинается от левого края — это
         её определение, а меню у правого края — не сетка. */
      const contentLeft = n.r[0] + pad.l + snapPx(n.s["border-left-width"]);
      if (Math.min(...real.map((k) => k.r[0])) > contentLeft + 4) return;
    }
    /* …и только та, у которой ШИРИНА настоящая. Нулевая по обеим осям
       обёртка коробки не образует вовсе (её разворачивают в родителя), и
       место её плавающих детей определяет не она, а тот, кто их примет:
       на github.com такая `ul` шириной 0 стоит правее собственных детей. */
    if (n.r[2] <= 1) return;
    // хоть один непустой сосед в потоке — это обтекание, модель ряда не годится
    const flowy = ch.some((c) => {
      const k = snap.nodes[c];
      return !isFloat(k) && k.r[2] > 1 && k.r[3] > 1;
    });
    if (flowy) return;
    if ((n.x ?? "").trim()) return;
    const boxes = floats
      .map((c) => snap.nodes[c])
      .filter((k) => k.r[2] > 1 && k.r[3] > 1)
      .sort((a, b) => a.r[1] - b.r[1] || a.r[0] - b.r[0]);
    if (boxes.length !== floats.length || boxes.length === 0) return;
    /* НЕПЕРЕКРЫТИЕ ПРОВЕРЯЕТСЯ ВНУТРИ СТРОКИ, А НЕ ПО ВСЕМУ СПИСКУ.
       Плавающая сетка ПЕРЕНОСИТСЯ: у портала wikipedia.org двенадцать
       блоков «другие проекты» стоят 4×3, и четыре из них имеют один и тот
       же левый край. Проверка по списку, отсортированному по X, видела в
       этом наложение и отказывалась считать сетку рядом — все двенадцать
       уходили в absolute, а текст внутри съезжал на 495px (точность по X
       52%, единственный такой случай на наборе). Наложены только те, что
       лежат на ОДНОЙ строке, — строки и разделяем по верхним краям. */
    let band: SnapNode[] = [];
    for (const k of boxes) {
      const prev = band[band.length - 1];
      if (prev && k.r[1] < prev.r[1] + prev.r[3] - 1) {
        if (k.r[0] < prev.r[0] + prev.r[2] - 1) return;
        band.push(k);
      } else band = [k];
    }
    /* ГЛАВНАЯ ПРОВЕРКА: СЪЕЛА ЛИ СТРАНИЦА ЭТУ ВЫСОТУ.
       Нулевая высота обёртки говорит только о ней самой. Дальше возможны
       два исхода — см. `heightReserved`. */
    const bottom = Math.max(...boxes.map((k) => k.r[1] + k.r[3]));
    if (!heightReserved(idx, bottom)) return;
    for (const k of boxes) floatRow.add(k);
  });

  /**
   * АБСОЛЮТНАЯ ОБЁРТКА ВСЕГО ПРИЛОЖЕНИЯ — ЭТО ПОТОК, А НЕ НАКЛАДКА.
   *
   * `position: absolute` осмысленно ровно тогда, когда рядом есть поток,
   * над которым узел висит. Одностраничные приложения пользуются им иначе:
   * `<div id="root"><div class="full-page-app-wrapper" style="position:
   * absolute; inset: 0">` — вся страница целиком. Обтекать там нечего,
   * накладывать не на что, и высоту документа задаёт именно это поддерево.
   *
   * Оставляя такую обёртку абсолютной, импорт получает фрейм высотой во
   * вьюпорт (bandcamp.com: 900px вместо 5929 — ошибка 85%) и страницу,
   * целиком вынутую из auto-layout: редактировать нечего.
   *
   * Признак измеренный, а не гадательный: у родителя высота схлопнута в
   * ноль (она схлопнулась ИМЕННО потому, что ребёнок ушёл из потока),
   * выведенный из потока ребёнок у него ровно один, и он начинается в
   * левом верхнем углу родителя. Тогда возврат ребёнка в поток
   * воспроизводит страницу точно: родитель вырастет по нему, как и было
   * до `position: absolute`. Это то же рассуждение, что и `floatRow`,
   * только для второго способа выйти из потока.
   */
  const flowBack = new Set<SnapNode>();
  snap.nodes.forEach((n, idx) => {
    if (n.r[3] > 1) return;
    if (n.r[2] <= 1) return;
    const ch = (kids.get(idx) ?? []).map((c) => snap.nodes[c]).filter((k) => k.r[2] > 1 && k.r[3] > 1);
    if (ch.length !== 1) return;
    const k = ch[0];
    const pos = (k.s["position"] ?? "static").trim();
    if (pos !== "absolute" && pos !== "fixed") return;
    if (Math.abs(k.r[0] - n.r[0]) > 2 || Math.abs(k.r[1] - n.r[1]) > 2) return;
    /* …и та же проверка, что у `floatRow`: страница обязана эту высоту
       УЧЕСТЬ. Обёртка 1440×0 с абсолютной каруселью 1440×450 под
       содержимым — витрина Steam — высоты не резервировала: следующий блок
       стоит сразу за обёрткой, карусель лежит ПОД ним фоном. Возврат в
       поток добавлял бы 450px ошибки высоты. */
    if (!heightReserved(idx, k.r[1] + k.r[3])) return;
    flowBack.add(k);
  });

  /* ПОДВАЛ, ЗАДАЮЩИЙ ВЫСОТУ СТРАНИЦЫ, — ТОЖЕ ПОТОК.
     `position: absolute` у корневого элемента не значит «накладка»: у
     ahrefs.com/blog подвал `absolute` стоит НИЖЕ всего потока (y=5691) и
     его низ совпадает с высотой документа (6274) — прокрутка страницы
     считает его наравне с потоком. Оставляя его абсолютным, импорт получал
     фрейм 5429px вместо 6274 (ошибка 13.5%) при верной геометрии внутри.
     Признак измеренный: элемент последний в разметке среди корневых, его
     верх не выше низа всего корневого потока (значит он ничего не
     накрывает), и его низ и есть высота документа. */
  {
    const roots = kids.get(-1) ?? [];
    let flowBottom = 0;
    for (const i of roots) {
      const r = snap.nodes[i];
      if (!outOfFlowStatic(r) && r.r[2] > 1 && r.r[3] > 1) flowBottom = Math.max(flowBottom, r.r[1] + r.r[3]);
    }
    for (let i = roots.length - 1; i >= 0; i--) {
      const r = snap.nodes[roots[i]];
      if (r.r[2] <= 1 || r.r[3] <= 1) continue;
      if ((r.s["position"] ?? "static").trim() !== "absolute") break;
      if (r.r[1] < flowBottom - 2) break;
      if (r.r[1] + r.r[3] < snap.documentHeight - 4) break;
      flowBack.add(r);
      break;
    }
  }

  const outOfFlow = (n: SnapNode): boolean => {
    const pos = (n.s["position"] ?? "static").trim();
    if (pos === "absolute" || pos === "fixed") return !flowBack.has(n);
    return isFloat(n) && !floatRow.has(n);
  };

  /** Индексы детей в потоке: absolute, fixed и float браузер из него вывел. */
  const flowKidIdx = (idx: number): number[] =>
    (kids.get(idx) ?? []).filter((c) => !outOfFlow(snap.nodes[c]));

  /** Дети, участвующие в потоке: absolute и fixed браузер из него вывел. */
  const flowKids = (idx: number): SnapNode[] => flowKidIdx(idx).map((c) => snap.nodes[c]);

  /**
   * МЕСТО РЕБЁНКА В СЕТКЕ — ИЗ ИЗМЕРЕННОЙ ГЕОМЕТРИИ, А НЕ ИЗ СТИЛЯ.
   *
   * `grid-column-start` в снимке чаще всего бесполезен: настоящая вёрстка
   * ставит элементы по ИМЕНОВАННЫМ линиям (`grid-column: main-column-start /
   * span 8`), и в вычисленном стиле лежит имя, а не число. Плюс `grid-area`,
   * `order` и `grid-auto-flow: dense` — их в снимке нет вовсе.
   *
   * Зато есть ширины дорожек в пикселях и прямоугольник ребёнка. Границы
   * дорожек считаются от левого края СОДЕРЖИМОГО сетки (граница + внутренний
   * отступ), дальше ищется минимальный диапазон дорожек, накрывающий ребёнка.
   * Такой поиск устойчив к `justify-self`: элемент, прижатый внутри своей
   * ячейки, всё равно лежит внутри её границ.
   *
   * Это чинит два разных дефекта одной причиной: колонку статьи Википедии
   * (`196px 1132px`, дети по именам) и сетку Guardian из 18 дорожек, где
   * «подряд» не совпадает ни с чем.
   */
  const gridPlace = new Map<number, { start: number; span: number; row: number; rows: number }>();

  /** Просвет слева от строчного соседа: индекс в снимке → пиксели. */
  const inlineLead = new Map<number, number>();

  /**
   * РЯДЫ СЕТКИ ИЗ ГЕОМЕТРИИ.
   *
   * Ряд закрывается по САМОМУ РАННЕМУ нижнему краю в нём, а не по самому
   * позднему. Разница принципиальная: элемент, растянутый на несколько рядов
   * (сайдбар во всю страницу), иначе поглотил бы все последующие ряды в один
   * и вернул бы нас к исходной ошибке. Раз ряд закрывается по короткому
   * соседу, длинный элемент остаётся в своём ряду, а его протяжённость
   * выражается числом занятых рядов.
   */
  const rowBands = (boxes: Array<[number, number]>): number[] => {
    const tops = [...boxes].sort((a, b) => a[0] - b[0]);
    const starts: number[] = [];
    let bandBottom = -Infinity;
    for (const [top, bottom] of tops) {
      if (top >= bandBottom - 1) {
        starts.push(top);
        bandBottom = bottom;
      } else bandBottom = Math.min(bandBottom, bottom);
    }
    return starts;
  };

  const planGrid = (idx: number, n: SnapNode): void => {
    const px = snapTrackPx(n.s["grid-template-columns"]);
    if (!px || px.length < 2) return;
    const gap = snapPx(n.s["column-gap"]) || 0;
    const left0 = n.r[0] + snapPx(n.s["border-left-width"]) + snapPx(n.s["padding-left"]);
    const starts: number[] = [];
    const ends: number[] = [];
    let x = left0;
    for (const w of px) {
      starts.push(x);
      ends.push(x + w);
      x += w + gap;
    }
    const gridRight = ends[ends.length - 1];
    // допуск — половина самой узкой дорожки, но в разумных пределах
    const narrow = Math.min(...px.filter((w) => w > 0), 40);
    const tol = Math.min(12, Math.max(2, narrow / 2));

    /* Ячейку сетки занимает не всегда прямой ребёнок: `display: contents`
       коробки не образует, и элементами сетки становятся ЕГО дети. Поэтому
       спускаемся сквозь узлы без коробки — ровно так же, как это делает
       браузер. */
    const items: number[] = [];
    const collect = (i: number): void => {
      const c = snap.nodes[i];
      if (c.r[2] <= 1 && c.r[3] <= 1) {
        for (const k of flowKidIdx(i)) collect(k);
      } else items.push(i);
    };
    for (const ci of flowKidIdx(idx)) collect(ci);

    const boxes = items.map((ci): [number, number] => {
      const c = snap.nodes[ci];
      return [c.r[1] - snapPx(c.s["margin-top"]), c.r[1] + c.r[3] + snapPx(c.s["margin-bottom"])];
    });
    const bands = rowBands(boxes);

    items.forEach((ci, k) => {
      const c = snap.nodes[ci];
      /* Нулевая ШИРИНА месту в сетке не мешает: липкая колонка объявлений на
         arstechnica.com — коробка 0×1870 в третьей дорожке. Без места она
         попадала в раскладку «подряд», то есть в первую ячейку первого ряда,
         и растягивала этот ряд на всю свою высоту: карточка на 250px
         становилась 1870px, а страница вырастала наполовину. Пропускаем
         только то, у чего нулевые обе стороны, — такого на экране нет. */
      if (c.r[2] <= 0 && c.r[3] <= 0) return;
      const l = c.r[0] - snapPx(c.s["margin-left"]);
      const r = c.r[0] + c.r[2] + snapPx(c.s["margin-right"]);
      // ребёнок вне сетки (вылез за края) — геометрии не верим
      if (l < left0 - tol || r > gridRight + tol) return;
      let si = 0;
      for (let i = 0; i < starts.length; i++) if (starts[i] <= l + tol) si = i;
      let ei = si;
      for (let i = si; i < ends.length; i++) {
        ei = i;
        if (ends[i] >= r - tol) break;
      }
      const [top, bottom] = boxes[k];
      let ri = 0;
      for (let i = 0; i < bands.length; i++) if (bands[i] <= top + 1) ri = i;
      let rj = ri;
      for (let i = ri + 1; i < bands.length; i++) if (bands[i] < bottom - 1) rj = i;
      gridPlace.set(ci, { start: si + 1, span: ei - si + 1, row: ri + 1, rows: rj - ri + 1 });
    });
  };

  /**
   * РАСКЛАДКА ПО ИЗМЕРЕННОЙ ГЕОМЕТРИИ.
   *
   * `display: block` НЕ означает «дети идут сверху вниз». Так же выглядят:
   *
   *  - строчный поток — `inline`, `inline-block`, `inline-flex` у детей,
   *    плавающие блоки: дети стоят в ряд, а у РОДИТЕЛЯ в вычисленном стиле
   *    об этом нет ни слова;
   *  - многоколоночная вёрстка (`columns: 3`): `column-count` не входит в
   *    снимаемый набор, да и добавление свойства не помогло бы старым
   *    снимкам.
   *
   * Оба случая давали одну и ту же ошибку: дети складывались в столбик.
   * На vitejs.dev блок отзывов `columns-1 lg:columns-3` — девять карточек
   * в три колонки — распрямлялся в девять строк, и третья колонка уезжала
   * ровно на ширину двух дорожек (−920px по X, +1250px к высоте страницы).
   *
   * Догадка тут не нужна: прямоугольники измерены браузером, и режим
   * читается из них однозначно. Важно только не принять за ряд обычный
   * столбик с разными отступами — поэтому оба признака строгие.
   */
  const inferFlowLayout = (
    idx: number,
  ): { preset: LayoutType; columns?: number; wrap?: boolean; inline?: boolean } | null => {
    const ch = flowKidIdx(idx);
    if (ch.length < 2) return null;

    /* Колонка — набор детей с общим левым краем. */
    const cols: Array<{ x: number; w: number; count: number }> = [];
    for (const ci of ch) {
      const c = snap.nodes[ci];
      const hit = cols.find((k) => Math.abs(k.x - c.r[0]) <= 4);
      if (hit) {
        hit.count += 1;
        hit.w = Math.max(hit.w, c.r[2]);
      } else cols.push({ x: c.r[0], w: c.r[2], count: 1 });
    }
    cols.sort((a, b) => a.x - b.x);

    /* МНОГОКОЛОНОЧНЫЙ ПОТОК. Признак жёсткий: колонки равной ширины на
       равном шаге, и хотя бы в одной колонке несколько элементов. Порядок
       заполнения у `columns` — по колонкам сверху вниз, это ровно кладка. */
    if (cols.length >= 2 && cols.length <= 6 && cols.some((k) => k.count > 1)) {
      const wMax = Math.max(...cols.map((k) => k.w));
      const wMin = Math.min(...cols.map((k) => k.w));
      const pitch = cols.slice(1).map((k, i) => k.x - cols[i].x);
      const evenPitch = pitch.every((p) => Math.abs(p - pitch[0]) <= 2);
      /* КОЛОНКИ СТОЯТ РЯДОМ, А НЕ ДРУГ НА ДРУГЕ. Проверка отсутствовала, и
         этого хватало, чтобы принять за кладку обычный столбик: у div.main
         на gsmarena.com четыре блока подряд с левыми краями 515, 516, 526,
         526 — «две колонки шагом 10px» при ширине блока 728. Кладка резала
         колонку пополам, и вся правая часть страницы (36 заголовков ленты)
         уезжала на 357px с шириной вдвое меньше нужной.
         Настоящая колонка отстоит от соседней не меньше чем на свою ширину,
         и содержимое соседних колонок пересекается по вертикали — иначе это
         просто блоки, идущие сверху вниз. */
      const wideEnough = pitch.every((p) => p >= wMax * 0.9);
      let sideBySide = false;
      const colOf = (c: SnapNode): number => cols.findIndex((k) => Math.abs(k.x - c.r[0]) <= 4);
      for (const a of ch) {
        for (const b of ch) {
          const na = snap.nodes[a];
          const nb = snap.nodes[b];
          if (colOf(na) >= colOf(nb)) continue;
          if (Math.min(na.r[1] + na.r[3], nb.r[1] + nb.r[3]) - Math.max(na.r[1], nb.r[1]) > 1) sideBySide = true;
        }
      }
      /* КЛАДКА ИЛИ ПЕРЕНЕСЁННЫЙ РЯД — РАЗНЫЙ ПОРЯДОК ЗАПОЛНЕНИЯ.
         Внешне это одно и то же: равные колонки на равном шаге, в каждой по
         нескольку элементов. Разница в порядке: `columns` заполняет колонку
         СВЕРХУ ВНИЗ и лишь потом переходит к следующей, а перенесённый ряд
         идёт СЛЕВА НАПРАВО. Видно по измеренным краям первых двух детей в
         документном порядке: у кладки второй ребёнок под первым, у ряда —
         справа. Без проверки сетка «других проектов» на wikipedia.org (4×3,
         заполнение по строкам) раскладывалась по колонкам, и каждый второй
         блок вставал не на своё место. */
      /* СУДИТЬ НАДО ПО ВСЕЙ ПОСЛЕДОВАТЕЛЬНОСТИ, А НЕ ПО ДВУМ ПЕРВЫМ.
         Проверка «второй ребёнок под первым» слепа к колонке из ОДНОГО
         элемента: в кладке 3×N первая колонка бывает высокой карточкой, и
         второй ребёнок оказывается уже во второй колонке — признак давал
         «ряд с переносом», а он выкладывает по строкам и путает всё. На
         ленте ahrefs.com/blog так уезжала треть карточек на 380–760px
         (точность по X 71%).
         Различие между кладкой и перенесённым рядом видно в номерах колонок
         по документному порядку: у кладки они НЕ УБЫВАЮТ (сначала вся
         первая колонка, потом вся вторая), у ряда — сбрасываются на нуль в
         начале каждой строки. */
      const seq = ch.map((c) => colOf(snap.nodes[c]));
      const fillsDown = seq.every((v, i) => i === 0 || v >= seq[i - 1]);
      if (fillsDown && evenPitch && wideEnough && sideBySide && wMax > 0 && wMax - wMin <= wMax * 0.02) {
        return { preset: "masonry", columns: cols.length };
      }
      /* Кладкой это не оказалось — и раньше здесь стоял отказ («рваная
         картина, гадать не будем»), то есть столбик. Но ровно так выглядит
         и ПЕРЕНЕСЁННАЯ строка: у первого элемента второй строки тот же
         левый край, что у первого элемента первой, — вот и «колонка из
         двух». Отказ превращал каждое такое меню, ленту тегов и подпись со
         ссылками в столбик, и весь ряд схлопывался к левому краю.
         Поэтому не отказываемся, а проверяем строки ниже: тот признак
         строгий сам по себе и столбик за ряд не примет. */
    }

    /* СТРОЧНЫЙ ПОТОК. Соседи в порядке документа стоят рядом, если
       следующий начинается правее конца предыдущего и они пересекаются
       по вертикали. Так строка отличается от столбика с отступами. */
    const lines: number[][] = [];
    let line: number[] = [];
    for (const ci of ch) {
      const c = snap.nodes[ci];
      const prev = line.length ? snap.nodes[line[line.length - 1]] : null;
      if (!prev) {
        line.push(ci);
        continue;
      }
      const rightOfPrev = c.r[0] >= prev.r[0] + prev.r[2] - 2;
      const overlapY =
        Math.min(c.r[1] + c.r[3], prev.r[1] + prev.r[3]) - Math.max(c.r[1], prev.r[1]);
      if (rightOfPrev && overlapY > 0) line.push(ci);
      else {
        lines.push(line);
        line = [ci];
      }
    }
    lines.push(line);

    if (lines.length === 1) {
      noteInlineLead(lines, idx);
      return { preset: "row", inline: true };
    }
    // несколько строк, и хотя бы в одной больше элемента — строчный перенос
    if (lines.some((l) => l.length > 1)) {
      noteInlineLead(lines, idx);
      return { preset: "row", wrap: true, inline: true };
    }
    return null; // каждый ребёнок на своей строке — обычный столбик
  };

  /**
   * ПРОБЕЛ РАЗМЕТКИ МЕЖДУ СТРОЧНЫМИ СОСЕДЯМИ.
   *
   * У ряда, восстановленного из блочного потока, `column-gap` в стиле всегда
   * `normal`, то есть ноль. Но на экране соседи раздвинуты: между двумя
   * строчными элементами стоит ПРОБЕЛ разметки, и он ничем не описан в
   * вычисленном стиле — это символ, а не свойство. Ставя такой ряд вплотную,
   * импорт терял по 4–12px на каждом стыке, и ошибка копилась вдоль строки:
   * на theverge.com подпись автора уезжала на 9px, счётчик за ней на 17px,
   * дата на 29px — и так в 78 узлах подряд.
   *
   * Просвет записывается КАЖДОМУ соседу отдельно, а не общим `gap` на ряд:
   * между «Автор» и «·» пробела нет, а между «·» и датой он есть, и одним
   * числом это не описать. Носитель — обычный левый отступ, то есть
   * результат остаётся редактируемым: отступ видно в инспекторе и его можно
   * изменить, в отличие от абсолютной координаты.
   *
   * Первый в строке пропускается: его положение задаёт отступ родителя, а в
   * перенесённой строке — сам перенос.
   */
  function noteInlineLead(lines: number[][], parentIdx?: number): void {
    noteLeadingIndent(lines, parentIdx);
    const p = parentIdx === undefined ? null : snap.nodes[parentIdx];
    /* В ПРЕФОРМАТИРОВАННОМ БЛОКЕ ПОТОЛОК НА ПРОСВЕТ НЕ ДЕЙСТВУЕТ.
       Обычную строку раздвигает выравнивание, и просвет шире 60px там
       почти наверняка не пробел, а `justify` или таблица. В коде ровно
       наоборот: между двумя токенами подсветки лежит неразмеченный текст
       («"../node_modules/bootstrap/scss"»), и это сотни пикселей
       НАСТОЯЩЕГО содержимого. Отбрасывая их, импорт сдвигал хвост строки
       влево накопительно — на документации Bootstrap до 1225px. */
    const cap = p && (p.s["white-space"] ?? "").trim() === "pre" ? Math.max(60, p.r[2] * 4) : 60;
    for (const line of lines) {
      for (let i = 1; i < line.length; i++) {
        const prev = snap.nodes[line[i - 1]];
        const cur = snap.nodes[line[i]];
        const own = snapPx(prev.s["margin-right"]) + snapPx(cur.s["margin-left"]);
        const lead = cur.r[0] - (prev.r[0] + prev.r[2]) - own;
        // отрицательный просвет — перекрытие, рядом его не выразить
        if (lead >= 1 && lead <= cap) inlineLead.set(line[i], Math.round(lead));
      }
    }
  }

  /**
   * ОТСТУП КОДА В НАЧАЛЕ ПРЕФОРМАТИРОВАННОЙ СТРОКИ.
   *
   * Первого в строке `noteInlineLead` намеренно пропускает: в обычном потоке
   * пробелы в начале строки СХЛОПЫВАЮТСЯ по спецификации, и элемент стоит
   * ровно по краю содержимого родителя. Просвета там нет и быть не может.
   *
   * Внутри `white-space: pre*` всё наоборот: ведущие пробелы значимы, и
   * именно они образуют лесенку отступов в подсвеченном коде. В снимок эти
   * пробелы не попадают вовсе — сборщик схлопывает пробельные узлы по
   * общему правилу, — поэтому строка кода прижималась к левому краю блока.
   * Ошибка ровная и мелкая, но задевает КАЖДУЮ вложенную строку: на
   * документации React 169 узлов из 181 промахнувшихся — это один и тот же
   * `dx -16`, то есть один уровень отступа. Вне `<pre>` мимо допуска
   * промахивались 2 узла из 115.
   *
   * Отступ не выдумывается, а измеряется: расстояние от края содержимого
   * родителя до первого элемента строки. Носитель — тот же левый просвет,
   * что и у остальных, поэтому строка остаётся редактируемой.
   */
  function noteLeadingIndent(lines: number[][], parentIdx?: number): void {
    if (parentIdx === undefined) return;
    const p = snap.nodes[parentIdx];
    if (!(p.s["white-space"] ?? "").trim().startsWith("pre")) return;
    const innerL = p.r[0] + snapPx(p.s["padding-left"]) + snapPx(p.s["border-left-width"]);
    for (const line of lines) {
      const first = line[0];
      if (first === undefined || inlineLead.has(first)) continue;
      const cur = snap.nodes[first];
      const lead = cur.r[0] - innerL - snapPx(cur.s["margin-left"]);
      /* Полстроки отступа — это уже не лесенка кода, а выравнивание. */
      if (lead >= 1 && lead <= Math.max(60, p.r[2] / 2)) inlineLead.set(first, Math.round(lead));
    }
  }

  /**
   * ПОРЯДОК ДЕТЕЙ — ВИЗУАЛЬНЫЙ, А НЕ ДОКУМЕНТНЫЙ.
   *
   * В сетке и во flex порядок на экране задаёт `order`, `grid-area` и
   * `grid-auto-flow: dense`, а не порядок в разметке. Ни одного из этих
   * свойств в снимке нет — да они и не помогли бы: решатель раскладывает
   * детей подряд. Зато есть измеренные прямоугольники, и по ним видно, где
   * элемент оказался на самом деле.
   *
   * На svelte.dev лента из 96 аватаров спонсоров разложена именно через
   * `order` — в разметке они идут вперемешку, на экране змейкой. Импорт
   * ставил их по разметке, и промахивался почти каждым: средняя ошибка по X
   * 439px при ширине ячейки 36px.
   *
   * Кладку не трогаем: CSS-колонки заполняются по документному порядку,
   * визуальный порядок там и так следствие, а не причина.
   */
  const visualOrder = (list: number[]): number[] => {
    if (list.length < 2) return list;

    /* Строка набирается по пересечению с уже набранным: у сетки с
       `align-items: center` верхние края в одной строке разные, поэтому
       кластеризовать по верхнему краю нельзя. */
    const byTop = [...list].sort((a, b) => snap.nodes[a].r[1] - snap.nodes[b].r[1]);
    const bands: number[][] = [];
    let bandBottom = -Infinity;
    for (const i of byTop) {
      const r = snap.nodes[i].r;
      if (r[1] >= bandBottom - 1 || bands.length === 0) {
        bands.push([i]);
        bandBottom = r[1] + r[3];
      } else {
        bands[bands.length - 1].push(i);
        bandBottom = Math.max(bandBottom, r[1] + r[3]);
      }
    }

    /* ПРОВЕРКА ПРАВДОПОДОБИЯ. Элементы одной строки стоят рядом, значит по
       горизонтали НЕ пересекаются. Если пересекаются — прочитать порядок по
       геометрии нельзя, и разумнее оставить документный.
       Без этой проверки один ребёнок во всю высоту секции (подложка,
       оверлей) пересекался со всеми и склеивал их в одну «строку»: обычный
       столбик пересортировывался по X, и tailwindcss.com разъезжался вдвое. */
    for (const band of bands) {
      const sorted = [...band].sort((a, b) => snap.nodes[a].r[0] - snap.nodes[b].r[0]);
      for (let k = 1; k < sorted.length; k++) {
        const prev = snap.nodes[sorted[k - 1]].r;
        if (snap.nodes[sorted[k]].r[0] < prev[0] + prev[2] - 1) return list;
      }
    }

    const band = new Map<number, number>();
    bands.forEach((items, bi) => items.forEach((i) => band.set(i, bi)));
    return [...list].sort(
      (a, b) => band.get(a)! - band.get(b)! || snap.nodes[a].r[0] - snap.nodes[b].r[0],
    );
  };

  /**
   * ВЫСОТА, КОТОРУЮ СОДЕРЖИМОЕ НЕ ОБЪЯСНЯЕТ.
   *
   * `getComputedStyle().height` — это ИСПОЛЬЗОВАННАЯ высота, и по ней
   * нельзя отличить `height: 100vh` от `height: auto`: в обоих случаях
   * придут пиксели. Поэтому брать её как есть нельзя — auto-layout
   * превратился бы в мёртвую копию, застывшую на высоте съёмки.
   *
   * Но отличить можно по самому снимку: если измеренная коробка ВЫШЕ, чем
   * дотягиваются её дети в потоке, лишнее место зарезервировано чем-то
   * извне содержимого — `height`, `aspect-ratio`, растяжкой строки сетки.
   * Такую высоту нужно сохранить, содержимое её не восстановит.
   *
   * На COSPEX без этого терялось 558px: hero с `height: 100vh` (1080 →
   * 786), блок презентации (780 → 350), пустой `serial-ball` (250 → 0).
   * В решателе числовая высота — МИНИМУМ, а не потолок, поэтому
   * содержимое всё равно раздвинет блок, если его станет больше.
   */
  const reservedHeight = (idx: number, n: SnapNode): number => {
    const pad = sides(n, "padding");
    const ch = flowKids(idx);
    let bottom = n.r[1] + pad.t; // пустая коробка: только верхний отступ
    /* ПУСТОЕ МЕСТО НАД СОДЕРЖИМЫМ — ТОЖЕ РЕЗЕРВ.
       Нужная высота отмерялась от ВЕРХА КОРОБКИ до низа содержимого, и в
       неё молча попадало место, которое положило туда ВЫРАВНИВАНИЕ:
       `align-items: end` во flex-ряду, центрирование, `margin-top`,
       схлопнутый браузером сквозь родителя. Наш решатель такого места не
       создаёт — он выравнивает содержимое ВНУТРИ уже готовой высоты, —
       поэтому коробка выглядела «полностью объяснённой содержимым», резерв
       не ставился, и высота схлопывалась к содержимому.
       На COSPEX блок презентации ровно такой: `height: 780px`,
       `align-items: end`, внутри подпись 335px, прижатая к низу. Резерв не
       ставился (780 от верха до низа подписи сходились ровно), и блок
       выходил 336px вместо 780 — 444px из 460px всей недостачи страницы.
       Мерить надо ВЫСОТУ СОДЕРЖИМОГО, а не расстояние до его низа. */
    let top = Infinity;
    for (const c of ch) {
      const mb = Math.round(snapPx(c.s["margin-bottom"]));
      const mt = Math.round(snapPx(c.s["margin-top"]));
      bottom = Math.max(bottom, c.r[1] + c.r[3] + Math.max(0, mb));
      top = Math.min(top, c.r[1] - Math.max(0, mt));
    }
    const contentTop = Number.isFinite(top) ? top : n.r[1] + pad.t;
    const needed = bottom - contentTop + pad.t + pad.b;
    // запас меньше 4px — обычная погрешность округления, не резерв
    return n.r[3] - needed > 4 ? n.r[3] : 0;
  };

  /**
   * ВЫСОТА, КОТОРУЮ КОРОБКА РЕАЛЬНО ОБРЕЗАЕТ.
   *
   * Зеркальный случай к `reservedHeight`: там коробка ВЫШЕ содержимого и
   * лишнее надо сохранить, здесь она НИЖЕ содержимого и лишнее надо отсечь.
   * В модели прокрутки внутри блока не было, поэтому содержимое липкого
   * сайдбара или ленты с внутренним скроллом разворачивалось в поток целиком
   * и добавляло свою высоту к странице: меню MDN на 8382px в коробке 802px
   * растягивало документ до 33 492px вместо 11 428.
   *
   * Признак не в стиле, а в геометрии, и оба условия обязательны:
   *
   *  1. по вертикали коробка объявлена прокручиваемой или обрезающей
   *     (`overflow-y` ≠ `visible`) — без этого `max-height` был бы выдумкой;
   *  2. дети в потоке ИЗМЕРЕННО вылезают за её низ. Одного `overflow: hidden`
   *     мало: его ставят ради скруглений и очистки обтеканий на коробках,
   *     которые ничего не режут, и потолок высоты там превратил бы живой
   *     блок в застывший.
   *
   * Отдельно исключается прокрутчик РАЗМЕРОМ СО СТРАНИЦУ (`#root { height:
   * 100vh; overflow: auto }`): у него за краем лежит вся страница, и потолок
   * схлопнул бы документ до одного экрана.
   */
  const clippedHeight = (idx: number, n: SnapNode): number => {
    /* СВЁРНУТЫЙ `<details>` — ТОЖЕ ОБРЕЗАЮЩАЯ КОРОБКА, только `overflow` у
       него обычный. Закрытый `<details>` показывает лишь `<summary>`, но его
       содержимое остаётся в дереве с настоящими прямоугольниками. Боковое
       меню MDN собрано из сотни таких: измеренные 32px против 1032px
       содержимого в каждом, в сумме 30 000px развёрнутого меню, и всё, что
       ниже, уезжало на эти же 30 000px. Открытый `<details>` сюда не
       попадает: у него коробка накрывает содержимое, и проверка ниже
       возвращает ноль сама. */
    const raw = (n.s["overflow"] ?? "visible").trim();
    if (n.t !== "details") {
      if (!raw || raw === "visible") return 0;
      const parts = raw.split(/\s+/);
      const ovY = parts[1] ?? parts[0];
      if (ovY === "visible") return 0;
    }
    if (n.r[3] <= 0) return 0;
    if (n.r[3] >= Math.max(1, snap.documentHeight) * 0.6) return 0;
    const bottom = n.r[1] + n.r[3];
    let content = bottom;
    for (const c of flowKids(idx)) content = Math.max(content, c.r[1] + c.r[3]);
    return content > bottom + 4 ? Math.round(n.r[3]) : 0;
  };

  /**
   * Тип раскладки из вычисленного `display`. Для flex и grid браузер
   * сообщает точный режим, включая заданный медиазапросом или container
   * query. Для блочного потока режим восстанавливается по геометрии.
   */
  const layoutOf = (
    idx: number,
    n: SnapNode,
  ): { preset: LayoutType; tracks: GridTrack[] | null; columns?: number; wrap?: boolean; inline?: boolean } => {
    const disp = (n.s["display"] ?? "").trim();
    if (disp.includes("grid")) {
      const tracks = snapTracks(n.s["grid-template-columns"]);
      return { preset: tracks && tracks.length > 1 ? "columns" : "stack", tracks };
    }
    if (disp.includes("flex")) {
      const col = (n.s["flex-direction"] ?? "").startsWith("column");
      /* КОЛОНКА С ПЕРЕНОСОМ — ЭТО КЛАДКА. `flex-flow: column wrap` заполняет
         первую колонку сверху вниз, потом переходит к следующей: ровно
         поведение `columns` в CSS, которое у нас называется `masonry`.
         Столбик с флагом `wrap` решатель разложить не умеет — он игнорирует
         перенос, и все колонки склеиваются в одну: список из 36 марок на
         gsmarena.com (4 колонки по 9) вытягивался в одну колонку высотой
         вчетверо больше, а три четверти пунктов уезжали влево. Число колонок
         не угадываем, а считаем по измеренным левым краям. */
      if (col && (n.s["flex-wrap"] ?? "").includes("wrap")) {
        const lefts: number[] = [];
        for (const c of flowKids(idx)) {
          if (!lefts.some((x) => Math.abs(x - c.r[0]) <= 4)) lefts.push(c.r[0]);
        }
        if (lefts.length > 1 && lefts.length <= 8) {
          return { preset: "masonry", columns: lefts.length, tracks: null };
        }
      }
      return { preset: col ? "stack" : "row", tracks: null };
    }
    const geom = inferFlowLayout(idx);
    if (geom) return { ...geom, tracks: null };
    return { preset: "stack", tracks: null };
  };

  /**
   * ВНЕШНИЕ ОТСТУПЫ — ВСЕМ УЗЛАМ, А НЕ ТОЛЬКО ТЕКСТУ И КОНТЕЙНЕРАМ.
   *
   * Раньше `margin` переносился лишь в двух ветках обхода из шести: картинки,
   * иконки, кнопки и поля форм теряли его молча. В колонке это почти не
   * видно, а в ряду каждый потерянный отступ сдвигает ВСЕХ последующих
   * соседей: на dev.to аватар 32×32 с `margin-right: 8px` уводил дату, автора
   * и счётчик комментариев на 8px влево — и так в каждой из 18 карточек ленты.
   */
  const applyMargins = (node: SceneNode, n: SnapNode, parent: SnapNode | null, idx?: number): void => {
    const mar = sides(n, "margin");
    /* БОЛЬШОЙ ОТРИЦАТЕЛЬНЫЙ ОТСТУП — ЭТО КОМПЕНСАЦИЯ ЧУЖОЙ РАСКЛАДКИ.
       Классическая вёрстка Sphinx: содержимое `float: left; width: 100%`, а
       боковое меню за ним втягивается назад через `margin-left: -100%`. В
       пикселях это −1408px при собственной ширине 350. Плавающий блок мы из
       потока вывели (так требует спецификация), и компенсация осталась без
       того, что компенсировала: меню уезжало на 1408px влево вместе со всем
       оглавлением документации Python.
       Признак безопасный: отступ, превышающий по модулю ширину самого
       элемента, не сдвигает его на соседа, а выкидывает за пределы
       раскладки — такого в живой вёрстке не бывает без подпорок. */
    const ownW = Math.max(1, n.r[2]);
    /* …НО ТОЛЬКО ЕСЛИ КОМПЕНСИРОВАТЬ УЖЕ НЕЧЕГО.
       Тот же `margin-left: -100%` осмысленен, когда сосед, которого он
       перекрывает, ОСТАЛСЯ в потоке: в ряду отступ честно втягивает боковое
       меню назад поверх содержимого. Проверка измеренная и без догадок —
       правый край предыдущего соседа в потоке плюс отступ должны дать
       измеренное место элемента. У документации Python `div.body` —
       flex-элемент, и его `float` спецификация игнорирует (см. `isFloat`):
       сосед в потоке, компенсация настоящая, и обнуление уводило боковое
       меню на 1408px вправо. */
    if (mar.l < -ownW) {
      let honest = false;
      if (idx !== undefined && n.p >= 0) {
        const sibs = flowKidIdx(n.p);
        const at = sibs.indexOf(idx);
        if (at > 0) {
          const prev = snap.nodes[sibs[at - 1]];
          honest = Math.abs(prev.r[0] + prev.r[2] + mar.l - n.r[0]) <= 2;
        }
      }
      if (!honest) mar.l = 0;
    }
    if (mar.r < -ownW) mar.r = 0;
    /* Отступ, освобождавший место плавающей колонке, которая теперь стоит
       в том же ряду, — см. `floatClear`. */
    const clear = floatClear.get(n);
    if (clear) {
      if (clear.l > 0) mar.l = Math.max(0, mar.l - clear.l);
      if (clear.r > 0) mar.r = Math.max(0, mar.r - clear.r);
    }
    /* ОТСТУП, СХЛОПНУВШИЙСЯ ЧЕРЕЗ КРАЙ РОДИТЕЛЯ, ВЫСОТЫ НЕ ЗАНИМАЕТ.
       В блочном потоке `margin-top` первого и `margin-bottom` последнего
       ребёнка схлопываются С отступом самого родителя и ВЫХОДЯТ за его
       коробку, если у родителя нет по этой стороне ни отступа, ни рамки.
       Решатель складывает их внутрь, и высота родителя росла на отступ,
       которого в его коробке нет: на vercel.com секция с `margin: 276px 0`
       в коробке 480px давала 714 (276 + 162 + 276) — 234px на одной секции
       и 10% высоты страницы.
       Гадать не нужно: настоящий просвет ИЗМЕРЕН — это расстояние от края
       содержимого родителя до края ребёнка. Схлопывание, схлопывание
       насквозь и отрицательные отступы учтены в нём разом. Отступы между
       соседями считает `collapseVerticalMargins`, здесь — только крайние.
       Во flex и grid схлопывания нет по спецификации, там не трогаем. */
    if (idx !== undefined && parent && n.p >= 0) {
      const pd = (parent.s["display"] ?? "").trim();
      if (!pd.includes("flex") && !pd.includes("grid")) {
        const sibs = flowKidIdx(n.p);
        const ppad = sides(parent, "padding");
        if (sibs.length > 0 && sibs[0] === idx && mar.t > 0) {
          const top = parent.r[1] + ppad.t + snapPx(parent.s["border-top-width"]);
          const gap = Math.round(n.r[1] - top);
          if (gap >= 0) mar.t = Math.min(mar.t, gap);
        }
        if (sibs.length > 0 && sibs[sibs.length - 1] === idx && mar.b > 0) {
          const bottom = parent.r[1] + parent.r[3] - ppad.b - snapPx(parent.s["border-bottom-width"]);
          const gap = Math.round(bottom - (n.r[1] + n.r[3]));
          if (gap >= 0) mar.b = Math.min(mar.b, gap);
        }
      }
    }
    // пробел разметки перед строчным соседом — тоже внешний отступ слева
    const lead = idx === undefined ? 0 : (inlineLead.get(idx) ?? 0);
    if (lead) mar.l += lead;
    if (mar.t || mar.b || mar.l || mar.r) node.layout.margin = mar;
    /* `margin-inline: auto` приходит уже развёрнутым в пиксели, и как жёсткий
       отступ он бы застыл на ширине съёмки. Признак тот же, что у текста и
       контейнеров, — геометрия (см. `looksCentered`). */
    if (looksCentered(n, parent)) {
      node.layout.centered = true;
      dropSideMargins(node, parent);
    }
  };

  /**
   * Центрирование по ГЕОМЕТРИИ, а не по стилю.
   *
   * `getComputedStyle` возвращает уже разрешённые margin в пикселях, поэтому
   * `margin-inline: auto` в снимке неотличим от жёстких отступов. Зато по
   * прямоугольникам видно однозначно: блок уже родителя и стоит по центру
   * его содержимого — значит он центрирован колонкой.
   */
  const looksCentered = (n: SnapNode, parent: SnapNode | null): boolean => {
    if (!parent) return false;
    const pad = sides(parent, "padding");
    const innerX = parent.r[0] + pad.l;
    const innerW = parent.r[2] - pad.l - pad.r;
    if (innerW <= 0 || n.r[2] >= innerW - 2) return false;
    const leftGap = n.r[0] - innerX;
    const rightGap = innerX + innerW - (n.r[0] + n.r[2]);
    return leftGap > 1 && Math.abs(leftGap - rightGap) <= 2;
  };

  /**
   * Центрирование заменяет только БОКОВЫЕ отступы (это `margin-inline: auto`),
   * а раньше вместе с ними стирались и вертикальные.
   *
   * Вернуть их можно не везде: в блочном потоке соседние вертикальные
   * отступы СХЛОПЫВАЮТСЯ, и измеренные прямоугольники уже это учли —
   * решатель же складывает их подряд, поэтому вернуть отступ значило бы
   * посчитать его дважды. Во flex и grid схлопывания нет по спецификации,
   * там отступ настоящий и держит ритм страницы: на astro.build секции
   * лежат во flex-колонке с `margin-top: 144px`, и без него страница
   * недосчитывалась 1150px из 8841.
   */
  const dropSideMargins = (node: SceneNode, parent: SnapNode | null): void => {
    const m = node.layout.margin;
    if (!m) return;
    const pd = (parent?.s["display"] ?? "").trim();
    const collapses = !pd.includes("flex") && !pd.includes("grid");
    if (!collapses && (m.t || m.b)) node.layout.margin = { t: m.t, r: 0, b: m.b, l: 0 };
    else delete node.layout.margin;
  };

  /**
   * СТРОЧНЫЙ ПОТОК — ЭТО ОДИН АБЗАЦ, А НЕ РЯД КОРОБОК.
   *
   * Раньше абзац считался цельным только если строчные дети совпадали с ним
   * по типографике. Ссылка внутри текста другого цвета — и абзац распадался
   * на отдельные узлы, которые решатель выкладывал РЯДОМ, в одну строку.
   * На статье «Берлин» так разъезжался каждый абзац: 107 ссылок в одном
   * `<p>` высотой 156px вставали в ряд шириной в километр, а перенос строк
   * не воспроизводился вовсе — 1476 расхождений по X из 1677 узлов.
   *
   * Строку текста модель холста не умеет и уметь не должна: `text` — это
   * блок с переносом по словам, а не последовательность рич-ранов. Значит
   * выбор стоит между «одним абзацем с потерей цвета ссылок» и «рядом
   * коробок с потерей самого текста». Первое честнее: текст и его перенос —
   * то, ради чего страница существует.
   *
   * Признак строчного потока не в типографике, а в структуре и геометрии:
   * все дети — строчные теги, и элемент либо несёт собственный текст между
   * ними (тогда это заведомо абзац), либо занимает больше одной строки
   * (тогда дети переносятся, и рядом их не выложить). Однострочная полоска
   * из ссылок без своего текста — это меню, и она остаётся рядом.
   */
  const isWrappedInline = (idx: number, n: SnapNode): boolean => {
    /* Преформатированный блок в абзац не склеивается: у него не перенос по
       словам, а ЖЁСТКИЕ строки, и склейка стирает их все разом (см.
       `preLines`). Такой блок раскладывается столбиком строк. */
    if (preLines(idx, n)) return false;
    const children = kids.get(idx) ?? [];
    /* Единственный строчный ребёнок и ни знака собственного текста — это не
       абзац со ссылкой, а обёртка вокруг ссылки (`<h3><a>Заголовок</a></h3>`).
       Сливать её вредно: у обёртки коробка во всю ширину, а у ссылки — по
       тексту, и слияние отдаёт блоку чужую ширину. */
    if (children.length < 2 && !(n.x ?? "").length) return false;
    /* БЛОЧНЫЙ РЕБЁНОК РАЗРЫВАЕТ СТРОЧНЫЙ ПОТОК НА АНОНИМНЫЕ БЛОКИ.
       По спецификации браузер оборачивает куски строчного потока вокруг
       блочного элемента в анонимные блоки. Модель холста этого не
       выражает, и выбор тот же, что во всём этом правиле: либо один абзац
       с потерей коробки врезки, либо ряд с потерей самого текста. Пока
       стоял безусловный отказ, ОДНА `<blockquote>` среди 77 строчных детей
       лишала абзаца весь текст эссе paulgraham.com — 16 000 знаков вместе
       со сносками выкладывались рядом слева направо (точность по X 4%,
       медиана dy 8367px).
       Когда блочных детей единицы против десятков строчных, абзац честнее:
       текст сохраняется целиком (его собирает `subtreeText`), теряется
       только рамка цитаты. Когда их сравнимо много — это разметка, а не
       абзац, и отказ остаётся. */
    const blocky = children.filter((c) => {
      const k = snap.nodes[c];
      return !isInlineNode(k) || (k.s["display"] ?? "inline").trim() !== "inline";
    });
    if (blocky.length > 0 && (blocky.length * 12 > children.length || !(n.xm ?? "").length)) {
      return false;
    }
    for (const c of children) {
      if (blocky.includes(c)) continue;
      const k = snap.nodes[c];
      /* ПРОВЕРКА ПО СПИСКУ ТЕГОВ СЛЕПА К СТАРОМУ HTML.
         Список `INLINE` закрыт: в нём современные строчные теги. Архивные и
         научные страницы сверстаны `<font>`, `<tt>`, `<big>`, `<nobr>` — их
         в списке нет, и абзац с таким ребёнком терял право быть абзацем.
         Эссе paulgraham.com целиком лежит в одном строчном `<font>` с 77
         строчными детьми: вместо надписи получался ряд, куски текста и
         сноски выстраивались слева направо на одной строке — точность по X
         4%, медиана dy 8367px при идеальной высоте фрейма.
         `isInlineNode` отвечает на тот же вопрос по `display`, который
         браузер сообщает про любой тег, включая устаревшие и custom
         elements; проверка ниже всё равно требует ровно `inline`. */
      if (!isInlineNode(k)) return false;
      /* `display` в снимке есть всегда (в карте дефолтов его нет), и он
         отвечает на вопрос точнее тега: `inline-block`, `flex` и `block`
         образуют собственную коробку и в строку не встраиваются. Строчный
         поток — это ровно `display: inline`. */
      if ((k.s["display"] ?? "inline").trim() !== "inline") return false;
      if ((k.s["position"] ?? "static").trim() !== "static") return false;
      // строчный ребёнок со своей коробкой (кнопка-ссылка) — уже не текст
      if (snapPx(k.s["padding-left"]) > 8 || snapPx(k.s["border-left-width"]) > 0) return false;
      if (kids.get(c)?.some((g) => !isInlineNode(snap.nodes[g]))) return false;
    }
    /* РЕШАЮЩИЙ ПРИЗНАК — ПЕРЕНОС. Строчная последовательность, уместившаяся в
       ОДНУ строку, прекрасно раскладывается рядом: ширины измерены, порядок
       документный, ошибки нет. Ломается только перенос: со второй строки
       ряд обязан вернуться к левому краю, а ряд этого не умеет. Поэтому
       сливаем в абзац лишь тогда, когда дети реально лежат на разных
       строках, — по их измеренным верхним краям. */
    const fs = snapPx(n.s["font-size"]);
    const lh = snapPx(n.s["line-height"]) || fs * 1.4;
    if (!(lh > 0)) return false;
    const tops: number[] = [];
    for (const c of children) {
      const y = snap.nodes[c].r[1];
      if (!tops.some((t) => Math.abs(t - y) < lh * 0.5)) tops.push(y);
    }
    if (tops.length > 1) return true;
    /* ПЕРЕНОС ВИДЕН И ПО САМОМУ АБЗАЦУ, А НЕ ТОЛЬКО ПО ДЕТЯМ.
       Признак «дети на разных строках» слеп к самому частому случаю:
       абзац с ОДНОЙ ссылкой внутри, занимающий две строки. Все дети тогда
       на одной строке, ряд признаётся годным — и собственный текст абзаца
       теряется, потому что узел-контейнер текста не несёт. На странице
       документации Django так пропадало 2768 знаков из 12285 (19 абзацев),
       на ленте npr.org 1322, на портале Yahoo 897.

       Два условия, и оба измеренные, без догадок:
        - СВОЙ ТЕКСТ РАЗРЕЗАН РЕБЁНКОМ. Поле `xm` сборщик пишет ровно тогда,
          когда хоть один ребёнок стоит НЕ в конце (см. `markSegments`), то
          есть склейка «свой текст, потом дети» заведомо путает порядок и
          рядом эту строку не выразить. Когда все дети хвостовые, ряд
          порядок не путает — ломать его незачем;
        - СОДЕРЖИМОЕ ПЕРЕНЕСЛОСЬ: своя высота БЕЗ внутренних отступов больше
          строки. Отступы вычитаются потому, что `li` с `padding: 14px` и
          одной строкой текста иначе выглядел бы двухстрочным. */
    const pv = sides(n, "padding");
    const inner = n.r[3] - pv.t - pv.b;
    return inner > lh * 1.5 && !!n.xm;
  };

  /**
   * ПРЕФОРМАТИРОВАННЫЙ БЛОК — ЭТО СТОЛБИК ЖЁСТКИХ СТРОК.
   *
   * Подсвеченный код приходит в снимок плоским: у `<pre>` десятки строчных
   * `<span>`-токенов подряд, а переводы строк живут в пробельных текстовых
   * узлах, которых в снимке нет вовсе. Дальше срабатывала склейка абзаца
   * («много строчных детей на разных строках — значит перенос»), и весь
   * блок становился ОДНОЙ надписью: 406 токенов из документации React
   * исчезали из сцены, а вместе с ними и разбивка на строки.
   *
   * Но перенос по словам и жёсткая строка — разные вещи. В `white-space:
   * pre*` браузер не переносит по словам вовсе: где в исходнике перевод
   * строки, там и строка. Значит модель — столбик, в котором каждая строка
   * ряд своих токенов; и она восстанавливается из измеренных
   * прямоугольников без единой догадки: у токенов одной строки общий
   * верхний край.
   *
   * Возвращает строки (индексы детей по порядку) или null, если это не
   * преформатированный многострочный поток.
   */
  const preLinesCache = new Map<number, number[][] | null>();
  const preLines = (idx: number, n: SnapNode): number[][] | null => {
    const cached = preLinesCache.get(idx);
    if (cached !== undefined) return cached;
    let out: number[][] | null = null;
    compute: {
      /* Ровно `pre`, без `pre-wrap` и `pre-line`: те переносят по словам,
         и жёстких строк в них нет. Строчный `<code class="pre-wrap">`
         внутри абзаца — как раз такой случай, и столбик строк разносил бы
         его в лесенку из пяти рядов вместо одной строки. */
      if ((n.s["white-space"] ?? "").trim() !== "pre") break compute;
      /* Только САМ БЛОК кода, а не токен внутри него. У строчного токена,
         занявшего несколько строк, прямоугольник — объединение его строк:
         левый край такой коробки не там, где токен начинается. Строить по
         ней столбик строк значит промахиваться на всю ширину блока — на
         документации Bootstrap до 1225px. Внешний `<pre>`/`<code>` от этого
         не страдает: он блочный, и его коробка настоящая. */
      if (n.t !== "pre" && n.t !== "code") break compute;
      const all = kids.get(idx) ?? [];
      const children = flowKidIdx(idx);
      if (children.length < 2) break compute;
      /* Часть детей выведена из потока — порядок строк по прямоугольникам
         уже не восстановить, а гадать в коде нечего: отдаём блок общей
         ветке. */
      if (children.length !== all.length) break compute;
      const fs = snapPx(n.s["font-size"]);
      const lh = snapPx(n.s["line-height"]) || fs * 1.4;
      if (!(lh > 0)) break compute;
      const lineBox = Math.min(...children.map((c) => snap.nodes[c].r[3]));
      /* СОБСТВЕННЫЙ ТЕКСТ БЛОКА НЕ ТЕРЯЕМ. Между токенами подсветки лежит
         неразмеченный код («I'm a button» внутри `<button>`), и он живёт в
         собственном тексте `<pre>`. Разложить его по строкам можно только
         по меткам мест детей (`xm`), и метки обязаны сойтись с детьми: если
         сборщик пропустил скрытого ребёнка, меток окажется больше, текст
         разъедется по чужим строкам — и такой блок честнее отдать старой
         склейке, где текст хотя бы сохраняется целиком. */
      if (markSegments(n).length - 1 > all.length) break compute;
      for (const c of children) {
        const k = snap.nodes[c];
        if (!INLINE.has(k.t)) break compute;
        if ((k.s["display"] ?? "inline").trim() !== "inline") break compute;
        if ((k.s["position"] ?? "static").trim() !== "static") break compute;
        if (k.r[3] <= 0) break compute;
        /* СТРОЧНЫЙ РЕБЁНОК, САМ ЗАНЯВШИЙ НЕСКОЛЬКО СТРОК, ЛОМАЕТ СЧЁТ.
           У строчного элемента `getBoundingClientRect` возвращает ОБЪЕДИНЕНИЕ
           его строк: левый край такой коробки — самый левый из всех строк, а
           не место, где элемент начинается. Раскладывать по таким
           прямоугольникам нечего, и блок честнее отдать общей ветке. */
        if (k.r[3] > lineBox * 1.5) break compute;
      }
      /* Строки собираем ПОДРЯД, а не группировкой по всем верхним краям:
         в коде один и тот же отступ повторяется через десяток строк, и
         группировка склеила бы далёкие строки в одну. */
      const lines: number[][] = [];
      let cur: number[] = [];
      let top = NaN;
      for (const c of children) {
        const y = snap.nodes[c].r[1];
        if (cur.length === 0 || Math.abs(y - top) < lh * 0.5) {
          if (cur.length === 0) top = y;
          cur.push(c);
        } else {
          lines.push(cur);
          cur = [c];
          top = y;
        }
      }
      if (cur.length) lines.push(cur);
      /* Одна строка — тоже строка: ряд с восстановленными пробелами и
         собственным текстом на месте. Столбиком блок становится только при
         нескольких строках, это решает вызывающий. */
      out = lines;
    }
    preLinesCache.set(idx, out);
    return out;
  };

  /**
   * КОРОБКА ЗАПОЛНЕНА СВОИМ ЖЕ ТЕКСТОМ.
   *
   * Склейка поддерева в одну надпись отдаёт надписи коробку узла, а высоту
   * надписи считает измеритель по её строкам. Пока текст занимает коробку
   * целиком, это тождество. Но у полноширинного баннера магазина коробка
   * 1440×820, а текста в ней две строки внизу: остальные 742px — это
   * картинка-фон и воздух. Склейка отдавала такому баннеру высоту 22px, и
   * восемь баннеров подряд съедали 6385px из 12221 (ошибка высоты 52%).
   *
   * Мерить нужно не «сколько текста», а НАСКОЛЬКО ТЕКСТ НАБИВАЕТ КОРОБКУ:
   * объединение прямоугольников текстовых потомков против собственной
   * коробки за вычетом внутренних отступов. Пустое место сверху и снизу и
   * есть та высота, которую склейка стирает.
   */
  const textSpanCache = new Map<number, [number, number] | null>();
  const textSpan = (idx: number): [number, number] | null => {
    const cached = textSpanCache.get(idx);
    if (cached !== undefined) return cached;
    const n = snap.nodes[idx];
    let out: [number, number] | null = null;
    if ((n.x ?? "").trim() && n.r[3] > 0) out = [n.r[1], n.r[1] + n.r[3]];
    for (const c of kids.get(idx) ?? []) {
      const s = textSpan(c);
      if (!s) continue;
      out = out ? [Math.min(out[0], s[0]), Math.max(out[1], s[1])] : s;
    }
    textSpanCache.set(idx, out);
    return out;
  };

  /** Сколько высоты коробки склейка в надпись потеряет. */
  const textSlack = (idx: number, n: SnapNode): number => {
    /* Свой текст узла локализовать нечем: он лежит где-то в коробке, и
       коробка тем самым текстом и определена. Считать нечего. */
    if ((n.x ?? "").trim()) return 0;
    const span = textSpan(idx);
    if (!span) return 0;
    const pad = sides(n, "padding");
    const box = n.r[3] - pad.t - pad.b;
    return Math.max(0, box - (span[1] - span[0]));
  };

  /**
   * КОРОБКА НА ПОРЯДОК МЕНЬШЕ СВОЕГО ТЕКСТА — ЗНАЧИТ ТЕКСТ ОБРЕЗАН.
   *
   * Измеренный прямоугольник — это то, что браузер РЕАЛЬНО ПОКАЗАЛ. Если в
   * него физически не влезает и десятой доли текста элемента, значит текст
   * на странице не виден: он спрятан за маркером, скрыт `line-clamp`,
   * срезан `overflow: hidden` или показывается всплывающей подсказкой.
   * Разворачивая его в поток, импорт добавлял странице высоту, которой на
   * ней нет.
   *
   * Так на distill.pub `<d-footnote>` — надстрочный номер 11×19px, а текста
   * в нём полтысячи знаков: сноска разворачивалась в блок высотой 5104px
   * вместо 19, и восемь таких сносок давали 15 394px лишней высоты при
   * настоящей высоте документа 30 635 — ошибка 50.7%.
   *
   * Признак ГЕОМЕТРИЧЕСКИЙ, без чтения `-webkit-line-clamp` и
   * `text-overflow`: сколько строк вмещает коробка против того, сколько
   * строк требует текст при этой ширине. Порог намеренно грубый (втрое с
   * запасом в строку): цель — отличить маркер от абзаца, а не измерить
   * шрифт. Погрешность метрики знака втрое не ошибается.
   */
  const clipCache = new Map<number, boolean>();
  const clipsOwnText = (idx: number, n: SnapNode): boolean => {
    const cached = clipCache.get(idx);
    if (cached !== undefined) return cached;
    let out = false;
    const text = (n.x ?? "").replace(/\s+/g, " ").trim();
    compute: {
      if (text.length < 12) break compute;
      /* СХЛОПНУТАЯ В ТОЧКУ КОРОБКА — ЭТО НЕ ОБРЕЗАННЫЙ ТЕКСТ, А СПРЯТАННЫЙ
         ЭЛЕМЕНТ, и у него своё правило (`.sr-only`, см. обход). Разница
         существенна: спрятанную подпись обход выбрасывает целиком, но её
         текст остаётся в склеенном тексте родителя — а обрезанный маркер
         из склейки исключается. Смешав два случая, импорт терял 3% текста
         на витрине ikea.com (73 подписи «Option: SLÅNHÖSTMAL…» в коробках
         1×1) и на портале gov.uk. */
      if (n.r[2] <= 1 || n.r[3] <= 1) break compute;
      const fs = snapPx(n.s["font-size"]) || 16;
      const lh = snapPx(n.s["line-height"]) || fs * 1.4;
      if (!(lh > 0) || !(fs > 0)) break compute;
      const pad = sides(n, "padding");
      const innerW = n.r[2] - pad.l - pad.r;
      const innerH = n.r[3] - pad.t - pad.b;
      if (innerW <= 0) {
        out = true;
        break compute;
      }
      /* Строк вмещается — по измеренной высоте; хотя бы одна всегда. */
      const linesFit = Math.max(1, Math.round(innerH / lh));
      /* Знаков в строке — по грубой средней ширине знака. Полукегль — это
         типографская оценка для пропорционального шрифта; точность здесь
         не нужна, нужен порядок величины. */
      const perLine = Math.max(1, innerW / (fs * 0.5));
      const linesNeed = Math.ceil(text.length / perLine);
      out = linesNeed > linesFit * 3 + 1;
    }
    clipCache.set(idx, out);
    return out;
  };

  /**
   * ТЕКСТ СКЛЕЕННОГО АБЗАЦА — БЕЗ ОБРЕЗАННЫХ МАРКЕРОВ.
   *
   * `subtreeText` собирает вообще всё, и вместе с абзацем в надпись
   * попадал текст сноски, которого на странице не видно. Здесь то же
   * обхождение, но поддерево обрезанного маркера пропускается целиком:
   * ни сам маркер, ни его дети в поток не идут — ровно как в браузере.
   */
  const runText = (idx: number): string => {
    const n = snap.nodes[idx];
    let out = n.x ?? "";
    for (const c of kids.get(idx) ?? []) {
      if (clipsOwnText(c, snap.nodes[c])) continue;
      const t = runText(c);
      if (t) out = out ? `${out} ${t}` : t;
    }
    return out.replace(/\s*\n\s*/g, "\n").trim();
  };

  /**
   * БРАУЗЕР УЛОЖИЛ ЭТОТ ТЕКСТ В ОДНУ СТРОКУ.
   *
   * Измеренная коробка высотой в одну строку — прямое доказательство, что
   * переноса не было. Значит и в сцене его быть не должно: см.
   * `LayoutProps.noWrap` о том, почему обтянутая по тексту коробка ломает
   * высоту при малейшей разнице метрик шрифта.
   *
   * Проверок ровно три, и все по измеренному:
   *  - в тексте нет собственных переводов строки (`<br>`, преформат): там
   *    строк заведомо больше одной;
   *  - высота коробки за вычетом отступов не выше строки с запасом 35%
   *    (запас — на разницу между `line-height` и коробкой строки);
   *  - НАША СОБСТВЕННАЯ грубая оценка тоже говорит «около одной строки».
   *
   * Третья проверка — предохранитель, и он обязателен. Отступы у коробки
   * вычитаются законно, но именно из-за них двухстрочный абзац с
   * `padding: 10px 0` (COSPEX: 468×60 при строке 28px) прикидывался
   * однострочным, и запрет переноса срезал ему настоящую вторую строку —
   * ошибка высоты страницы выросла с 4.1% до 6.0%. Расхождение метрик
   * стоит единиц процентов, а не удвоения: если по нашему счёту текста
   * больше чем на 1.6 строки, значит браузер его тоже переносил.
   */
  /** Коробка ростом в одну строку: браузер перенос здесь не делал. */
  const oneLineBox = (n: SnapNode): boolean => {
    const ws = (n.s["white-space"] ?? "").trim();
    if (ws.startsWith("pre")) return false;
    const fs = snapPx(n.s["font-size"]);
    const lh = snapPx(n.s["line-height"]) || fs * 1.4;
    if (!(lh > 0) || !(fs > 0)) return false;
    const pad = sides(n, "padding");
    const innerH = n.r[3] - pad.t - pad.b;
    return innerH > 0 && innerH <= lh * 1.35;
  };

  const singleLine = (n: SnapNode, text: string): boolean => {
    if (!text || text.includes("\n")) return false;
    if (!oneLineBox(n)) return false;
    const fs = snapPx(n.s["font-size"]) || 16;
    const pad = sides(n, "padding");
    const innerW = n.r[2] - pad.l - pad.r;
    if (!(innerW > 0)) return false;
    return text.length / Math.max(1, innerW / (fs * 0.5)) <= 1.6;
  };

  /** Только строчные дети без своей типографики → это один абзац. */
  const isTextRun = (idx: number): boolean => {
    const children = kids.get(idx) ?? [];
    const n = snap.nodes[idx];
    /* КАРТИНКУ ПОДПИСЬЮ НЕ ЗАМЕНИШЬ.
       Склейка в абзац стирает всё поддерево, оставляя один текст, — и это
       законно ровно до тех пор, пока в поддереве нет ничего, кроме текста.
       Ссылка целиком считается строчной («a» — строчный тег), поэтому
       карточка новости `div > a > (картинка + заголовок)` проходила
       проверку типографики и превращалась в одну надпись: на bbc.com так
       исчезали 17 фотографий лент, на stripe.com — половина значков.
       Пропавшая картинка не занимает места, и вся страница под ней
       съезжает вверх. */
    if (children.length > 0 && hasMedia(idx)) return false;
    /* КОРОБКА ВЫШЕ СВОЕГО ТЕКСТА — ЗНАЧИТ В НЕЙ НЕ ТОЛЬКО ТЕКСТ.
       Допуск — одна строка: столько даёт разница между коробкой строки и
       её межстрочным интервалом, и на настоящем абзаце запас не превышен
       никогда. См. `textSlack`. */
    if (children.length > 0) {
      const lh = Math.max(16, Math.round(snapPx(n.s["line-height"])) || 0);
      if (textSlack(idx, n) > lh) return false;
    }
    /* БЕЗДЕТНЫЙ FLEX С ТЕКСТОМ — ЭТО ТЕКСТ.
       Проверка на flex стояла ВЫШЕ проверки на бездетность, и подпись в
       `<span style="display:flex">Research</span>` не становилась узлом
       текста: контейнер текста не несёт, и надпись пропадала совсем. Так
       устроена вся навигация openai.com и половина кнопок современных
       сайтов — flex ради выравнивания значка рядом с подписью. Единственный
       текст внутри flex-контейнера браузер и сам заворачивает в анонимный
       flex-элемент в одну строку, так что узел текста здесь — точная модель.
       Пустой flex-контейнер сюда не попадает: текста нет, и ветка ниже
       вернёт его в контейнеры.
       Про `display: grid` — см. известные пробелы в отчёте круга. */
    const disp = (n.s["display"] ?? "").trim();
    if (children.length === 0 && disp.includes("flex")) return true;
    if (disp.includes("flex") || disp.includes("grid")) return false;
    if (children.length === 0) return true;
    /* В ПРЕФОРМАТИРОВАННОМ БЛОКЕ ТОКЕНЫ НЕ СЛИВАЮТСЯ.
       Обычный абзац сливается в одну надпись, когда типографика у детей та
       же: терять там нечего, перенос по словам всё равно восстановит
       строку. В коде наоборот: пробелы между токенами значимы, в снимке их
       нет, и слияние стирает узлы, чьи прямоугольники — единственный
       источник расстояний. На документации Bootstrap так исчезали 410
       токенов из 25 блоков. */
    if ((n.s["white-space"] ?? "").trim() === "pre" && children.some((c) => subtreeText(c))) return false;
    if (isWrappedInline(idx, n)) return true;
    /* ОБЁРТКА ВОКРУГ ССЫЛКИ — НЕ АБЗАЦ.
       Тот же случай, что уже разобран в `isWrappedInline`, но он приходил и
       сюда: `<h3><a>Заголовок</a></h3>`, где у ссылки та же типографика, что
       у заголовка. Слияние отдавало надписи коробку заголовка — во всю
       ширину колонки вместо ширины по тексту, — и ширина расходилась с
       измеренной на всю разницу. При этом ничего не терялось бы и без
       слияния: у обёртки нет ни своего текста, ни второго ребёнка. */
    if (children.length === 1 && !(n.x ?? "").trim()) {
      const only = snap.nodes[children[0]];
      if (only.r[2] > 0 && only.r[2] < n.r[2] - 4) return false;
    }
    /* ОДНОСТРОЧНАЯ КОРОБКА СО СВОИМ ТЕКСТОМ — ЭТО ОДНА НАДПИСЬ… И ЭТОГО
       НЕЛЬЗЯ СДЕЛАТЬ ИЗ-ЗА ГЕЙТА.
       Узел с разной типографикой у детей дробится на узлы намеренно: цвет
       ссылки и курсив `<em>` дороже склейки. Но в коробке ростом в ОДНУ
       строку дробить некуда: столбик поставит куски друг под друга и порвёт
       строку, а ряд потеряет собственный текст родителя, потому что
       контейнер текста не несёт. Так теряются `<h1><code>grid-template-
       areas</code> CSS property</h1>` на MDN и двенадцать надписей самого
       COSPEX («Handcrafted in Italy · Reserved for Australia», «Discover the
       collections ↓», «Enquire ↗»).

       Правка написана и проверена: доля сохранённого текста растёт на
       наборах с 91% до 94–96%, высота и точность по X не меняются. Но она
       СКЛЕИВАЕТ узлы, а `tools/ci/baseline.json` сверяет `sceneNodes`
       cospex ТОЧНО, без допуска: 217 против 210 — проверка красная. Файл
       неприкосновенен, поэтому правка оставлена выключенной и описана в
       отчёте, а не обойдена подгонкой условия под фикстуру.

    if ((n.x ?? "").trim() && oneLineBox(n) && children.every((c) => isInlineNode(snap.nodes[c]))) {
      return true;
    } */
    return children.every((c) => {
      const k = snap.nodes[c];
      if (!isInlineNode(k)) return false;
      /* Обрезанный маркер типографике не подчиняется: его текст в поток не
         идёт вовсе (см. `clipsOwnText`), поэтому и однородность с ним
         сверять нечего — абзац остаётся абзацем. */
      if (clipsOwnText(c, k)) return true;
      // свой кегль/шрифт/цвет — текст не однороден, дробим на узлы
      return (
        k.s["font-size"] === n.s["font-size"] &&
        k.s["font-weight"] === n.s["font-weight"] &&
        k.s["color"] === n.s["color"] &&
        k.s["font-family"] === n.s["font-family"] &&
        (k.s["background-color"] ?? "") === (n.s["background-color"] ?? "")
      );
    });
  };

  /**
   * ЕСТЬ ЛИ В ПОДДЕРЕВЕ ХОТЬ ОДНА НАСТОЯЩАЯ КОРОБКА.
   *
   * Нужно, чтобы отличить два внешне одинаковых случая — у обоих в снимке
   * нулевой прямоугольник:
   *
   *  - элемент БЕЗ коробки (`display: contents`, `<picture>`, островки
   *    гидратации): по спецификации он не образует бокс вовсе, поэтому
   *    `getBoundingClientRect()` отдаёт нули, а дети у него — настоящие,
   *    со своей геометрией. Такой узел надо развернуть в родителя;
   *  - элемент, спрятанный схлопыванием (`.sr-only`, содержимое закрытого
   *    `<details>`): нулевой не только он сам, но и всё поддерево.
   *    Такого на странице не видно, и в сцене ему делать нечего.
   */
  const realBoxCache = new Map<number, boolean>();
  const hasRealBox = (idx: number): boolean => {
    const cached = realBoxCache.get(idx);
    if (cached !== undefined) return cached;
    let out = false;
    for (const c of kids.get(idx) ?? []) {
      const k = snap.nodes[c];
      if ((k.r[2] > 1 && k.r[3] > 1) || hasRealBox(c)) {
        out = true;
        break;
      }
    }
    realBoxCache.set(idx, out);
    return out;
  };

  /** Весь текст поддерева — для однородного абзаца. */
  const subtreeText = (idx: number): string => {
    const n = snap.nodes[idx];
    let out = n.x ?? "";
    for (const c of kids.get(idx) ?? []) {
      const t = subtreeText(c);
      if (t) out = out ? `${out} ${t}` : t;
    }
    return out.replace(/\s*\n\s*/g, "\n").trim();
  };

  const applyTypography = (node: SceneNode, n: SnapNode): void => {
    const family = (n.s["font-family"] ?? "").trim();
    if (family) {
      node.style.fontFamily = family;
      fonts.add(family);
    }
    const fs = Math.round(snapPx(n.s["font-size"]));
    if (fs > 0) node.style.fontSize = fs;

    const fwRaw = (n.s["font-weight"] ?? "").trim();
    const fw = fwRaw === "normal" ? 400 : fwRaw === "bold" ? 700 : parseInt(fwRaw, 10);
    if (Number.isFinite(fw)) {
      node.style.fontWeight = Math.min(700, Math.max(400, Math.round(fw / 100) * 100)) as 400 | 500 | 600 | 700;
    }

    const col = snapColor(n.s["color"]);
    if (col) node.style.textColor = col.hex;
    if (col && col.alpha < 1) node.style.opacity = col.alpha;

    if ((n.s["font-style"] ?? "").includes("italic")) node.style.italic = true;

    const ta = (n.s["text-align"] ?? "").trim();
    if (ta === "center" || ta === "right") node.style.textAlign = ta;

    const ls = snapPx(n.s["letter-spacing"]);
    if (ls && Math.abs(ls) <= 40) node.style.letterSpacing = Math.round(ls * 100) / 100;

    if (/uppercase/i.test(n.s["text-transform"] ?? "")) node.style.uppercase = true;

    // line-height из снимка — пиксели; переводим в множитель от кегля
    const lh = snapPx(n.s["line-height"]);
    if (lh > 0 && node.style.fontSize > 0) {
      node.style.lineHeight = Math.round((lh / node.style.fontSize) * 1000) / 1000;
    } else if (node.style.fontSize > 0) {
      /* `line-height: normal` — ЭТО НЕ «НЕИЗВЕСТНО», ЭТО ИЗМЕРЕНО.
         При `normal` браузер берёт множитель из метрик гарнитуры (1.1–1.2 у
         большинства), а в снимок приходит слово `normal` — числа там нет.
         Измеритель подставлял свой запас 1.32, и каждая строка выходила на
         3–5px выше настоящей. В одной надписи это незаметно, но страница из
         сотни строк подряд накапливает ошибку: лента lite.cnn.com получала
         3470px вместо 3084 (12.5%) и медиану dy 200px.
         Настоящий множитель у БЛОЧНОЙ коробки ростом в одну строку виден
         прямо: высота её содержимого и есть высота строки. У строчного
         элемента так нельзя — `getBoundingClientRect` отдаёт глифовую
         коробку, а не строку, — поэтому там оставляем запас измерителя. */
      /* У строчного элемента строку показывает ближайший БЛОЧНЫЙ предок:
         это его коробка и есть строка, в которую элемент встроен. Так
         устроена любая лента ссылок — `<li><a>Заголовок</a></li>`, — и без
         этого шага накопление оставалось: у lite.cnn.com 200 строк подряд
         давали 386px лишней высоты. */
      const boxOf = (m: SnapNode | null): SnapNode | null => {
        let cur = m;
        for (let hop = 0; cur && hop < 4; hop++) {
          const d = (cur.s["display"] ?? "").trim();
          if (d === "block" || d === "list-item" || d === "table-cell" || d.includes("flex") || d.includes("grid")) {
            return cur;
          }
          cur = cur.p >= 0 ? snap.nodes[cur.p] : null;
        }
        return null;
      };
      const box = boxOf(n);
      if (box) {
        const pv = sides(box, "padding");
        const inner =
          box.r[3] - pv.t - pv.b - snapPx(box.s["border-top-width"]) - snapPx(box.s["border-bottom-width"]);
        const k = inner / node.style.fontSize;
        if (k >= 0.8 && k <= 1.9) node.style.lineHeight = Math.round(k * 1000) / 1000;
      }
    }

    const td = n.s["text-decoration-line"] ?? "";
    if (/line-through/.test(td)) node.style.strike = true;
    if (/none/.test(td)) node.style.underline = false;
    else if (/underline/.test(td)) node.style.underline = true;
  };

  /**
   * Позиционирование. ВАЖНО: применяется ко всем типам узлов, а не только к
   * контейнерам. Фото-подложка hero — это `<img position:absolute; inset:0`,
   * и пока абсолют ставился лишь контейнерам, картинка оставалась в потоке
   * и забирала половину ряда: контент съезжал ровно на 953px из 1905.
   */
  const applyPosition = (node: SceneNode, n: SnapNode, parent: SnapNode | null): void => {
    const pos = (n.s["position"] ?? "static").trim();
    if (pos === "sticky" && !outOfFlow(n)) {
      // sticky ОСТАЁТСЯ в потоке: место за ним резервируется браузером
      node.sticky = true;
      const solid = snapColor(n.s["background-color"]);
      if (solid && solid.alpha > 0) node.scrollFill = solid.hex;
      return;
    }
    if (!outOfFlow(n)) return;

    /* `fixed` — тоже ВНЕ потока, и это не мелочь. Раньше он лишь помечался
       закреплённым и продолжал занимать строку: закреплённая шапка добавляла
       свою высоту к странице ПОВЕРХ компенсирующего padding-top, который
       сайт для неё же и держит (на tauri.app — лишние 64px), а закреплённая
       ссылка «Skip to content» шириной 113px растягивалась на всю страницу,
       потому что у корневого элемента не было родителя-ограничителя. */
    if (pos === "fixed") {
      node.sticky = true;
      const solid = snapColor(n.s["background-color"]);
      if (solid && solid.alpha > 0) node.scrollFill = solid.hex;
    }

    // отсчёт от родителя, а у корневых элементов — от самой страницы
    const px = parent ? parent.r[0] : 0;
    const py = parent ? parent.r[1] : 0;
    const pw = parent ? parent.r[2] : pageW;
    const ph = parent ? parent.r[3] : Math.max(1, snap.documentHeight);

    node.layout.position = "absolute";
    node.layout.x = Math.round(n.r[0] - px);
    node.layout.y = Math.round(n.r[1] - py);
    // накрывает родителя по оси → растяжка между сторонами (это `inset: 0`)
    if (n.r[2] >= pw - 2) {
      node.layout.right = Math.round(px + pw - (n.r[0] + n.r[2]));
    }
    if (n.r[3] >= ph - 2) {
      node.layout.bottom = Math.round(py + ph - (n.r[1] + n.r[3]));
    }
    node.layout.height = Math.max(1, Math.round(n.r[3]));
    if (n.r[2] < pw - 2) node.layout.width = Math.max(1, Math.round(n.r[2]));
  };

  /**
   * `grid-column: 1 / -1` → элемент на всю строку сетки.
   * В снимке это отдельные `grid-column-start/end`; без них надзаголовок
   * секции занимал одну ячейку, и ВСЯ сетка сдвигалась на колонку —
   * отсюда расхождения ровно в ширину дорожки (1020px на вьюпорте 1920).
   *
   * Измеренное место (см. `planGrid`) ВАЖНЕЕ вычисленного стиля: стиль знает
   * только про явные числа, а геометрия учитывает и имена линий, и `order`,
   * и автоматическое размещение.
   */
  const applyGridSpan = (node: SceneNode, n: SnapNode, idx: number): void => {
    const measured = gridPlace.get(idx);
    if (measured) {
      node.layout.gridColumn = measured.start;
      node.layout.gridSpan = measured.span;
      node.layout.gridRow = measured.row;
      if (measured.rows > 1) node.layout.gridRowSpan = measured.rows;
      return;
    }
    const start = (n.s["grid-column-start"] ?? "auto").trim();
    const end = (n.s["grid-column-end"] ?? "auto").trim();
    if (start === "auto" && end === "auto") return;
    if (end === "-1" && (start === "1" || start === "auto")) {
      node.layout.gridSpan = "full";
      return;
    }
    const spanEnd = /^span (\d+)$/.exec(end);
    if (spanEnd) {
      node.layout.gridSpan = Math.max(1, parseInt(spanEnd[1], 10));
      return;
    }
    const a = parseInt(start, 10);
    const b = parseInt(end, 10);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) node.layout.gridSpan = b - a;
  };

  const applyBox = (node: SceneNode, n: SnapNode): void => {
    const bg = snapColor(n.s["background-color"]);
    if (bg && bg.alpha > 0) {
      node.style.fill = bg.hex;
      if (bg.alpha < 1) node.style.fillAlpha = bg.alpha;
    } else if (bg && bg.alpha === 0) {
      node.style.fill = "transparent";
    }

    const bgImage = n.s["background-image"] ?? "";
    if (bgImage && bgImage !== "none") {
      const url = /url\(["']?([^"')]+)["']?\)/i.exec(bgImage)?.[1];
      if (url) {
        node.style.backgroundImage = resolveSrc(url);
        const size = (n.s["background-size"] ?? "cover").trim();
        node.style.backgroundSize = size.includes("contain") ? "contain" : size.includes("cover") ? "cover" : "auto";
        const pos = n.s["background-position"];
        if (pos) node.style.backgroundPosition = pos.trim();
      }
      if (/gradient\(/i.test(bgImage)) node.style.backgroundGradient = bgImage.trim();
    }

    const radius = snapPx(n.s["border-radius"]);
    if (radius > 0) node.style.radius = Math.round(Math.min(999, radius));

    const bw = {
      t: snapPx(n.s["border-top-width"]),
      r: snapPx(n.s["border-right-width"]),
      b: snapPx(n.s["border-bottom-width"]),
      l: snapPx(n.s["border-left-width"]),
    };
    const maxW = Math.max(bw.t, bw.r, bw.b, bw.l);
    if (maxW > 0 && (n.s["border-top-style"] ?? "solid") !== "none") {
      node.style.borderWidth = Math.min(8, Math.round(maxW));
      const bc = snapColor(n.s["border-top-color"]);
      if (bc && bc.alpha > 0.05) node.style.borderColor = bc.hex;
      const only = [bw.t > 0, bw.r > 0, bw.b > 0, bw.l > 0].filter(Boolean).length === 1;
      if (only) {
        if (bw.t > 0) node.style.borderTop = true;
        else if (bw.b > 0) node.style.borderBottom = true;
        else if (bw.l > 0) node.style.borderLeft = true;
      }
    }

    const op = parseFloat(n.s["opacity"] ?? "1");
    if (Number.isFinite(op) && op < 1 && op >= 0) node.style.opacity = op;
  };

  /* ---------- обход ---------- */

  /**
   * Ширина ребёнка НЕ равна ширине родителя.
   *
   * Картинки и врезки объявлялись `fill` безусловно. В колонке это
   * незаметно, а в ряду иконка 20×20 забирала всё свободное место и
   * уводила соседний текст на сотни пикселей вправо (на vitejs.dev значок
   * в баннере сдвигал подпись на 650px). Измеренная ширина ставится
   * потолком, а не жёстким размером: блок остаётся резиновым вниз.
   */
  const capWidth = (node: SceneNode, n: SnapNode, parent: SnapNode | null): void => {
    const pad = parent ? sides(parent, "padding") : null;
    const inner = parent && pad ? parent.r[2] - pad.l - pad.r : pageW;
    if (n.r[2] > 0 && n.r[2] < inner - 2) node.layout.maxWidth = Math.round(n.r[2]);
  };

  /**
   * ШИРИНА РЕБЁНКА В РЯДУ — ИЗМЕРЕННАЯ, А НЕ ВЫЧИСЛЕННАЯ ПО ТЕКСТУ.
   *
   * В колонке ширина ребёнка ни на что не влияет: сосед идёт снизу. В ряду
   * влияет на ВСЁ — каждая ошибка сдвигает всех правых соседей, и ошибки
   * складываются. А ширина элемента в ряду у нас до сих пор бралась из
   * измерителя текста: `width: fill` с потолком по измеренной ширине даёт
   * измеренную ширину только при избытке места, а при нехватке решатель
   * ужимает строку пропорционально, и позиции разъезжаются лесенкой.
   * На MDN так копилось по 7px на каждом пункте меню: HTML −160, CSS −167,
   * JavaScript −174 и дальше вниз до −258.
   *
   * Браузер уже посчитал эту ширину с учётом `flex-grow`, `flex-basis`,
   * `min-content` и переноса. Держать вместо неё догадку измерителя незачем.
   * Растяжимость при этом не теряется: элемент, занявший в оригинале всё
   * свободное место, остаётся `fill`.
   */
  /**
   * ДЕТИ ЛЕНТЫ С ГОРИЗОНТАЛЬНОЙ ПРОКРУТКОЙ.
   *
   * У них ширина обязана быть ЖЁСТКО измеренной, а не «во всю»: в карусели
   * каждый слайд ровно во всю ширину кадра, и правило «занял всё место —
   * значит fill» отдавало семи слайдам по одной седьмой кадра (47px вместо
   * 330 на newegg.com), после чего название товара получало 7px и
   * разворачивалось на 90 строк.
   */
  const scrollRowKid = new Set<SnapNode>();
  /* Столбик с прокруткой — тот же случай, только по другой оси: у
     свёрнутой панели аккордеона supabase.com коробка 76px, а содержимое
     560px и обрезано по `overflow: hidden`. Решатель ужимал содержимое до
     76px, и абзац разворачивался с 121px до 999. Ширина ребёнка такой
     коробки — измеренная, независимо от того, ряд родитель или столбик. */

  const rowChildWidth = (node: SceneNode, n: SnapNode, parent: SnapNode | null): void => {
    if (node.layout.position === "absolute") return;
    if (typeof node.layout.width === "number") return;
    const w = Math.round(n.r[2]);
    if (w <= 0) return;
    const pad = parent ? sides(parent, "padding") : null;
    const inner = parent && pad ? parent.r[2] - pad.l - pad.r : pageW;
    // элемент во всю доступную ширину — это и есть `fill`, его не фиксируем…
    // …кроме ленты с прокруткой, где во всю ширину КАЖДЫЙ слайд
    if (w >= inner - 2 && !scrollRowKid.has(n)) return;
    node.layout.width = w;
    delete node.layout.maxWidth;
  };

  const walk = (
    idx: number,
    parentSceneId: string,
    parentSnap: SnapNode | null,
    clip: Clip | null,
    parentRow = false,
  ): void => {
    if (added > MAX_SCENE_NODES) return;
    const n = snap.nodes[idx];
    const children = kids.get(idx) ?? [];

    /* УЗЕЛ БЕЗ СОБСТВЕННОЙ КОРОБКИ.
       `display: contents` не образует бокса по спецификации: в снимке у него
       нули, но дети настоящие. Раньше такой узел отсекался вместе со всем
       поддеревом — на theguardian.com из 104 картинок в сцену доходило 7,
       потому что каждый `<picture>` и каждый островок гидратации уносил
       детей с собой. Разворачиваем прозрачно в родителя: место в дереве
       узел не занимает, а его содержимое остаётся на странице.

       НО нулевая коробка бывает и ОБРЕЗАЮЩЕЙ. Идиома скрытия без
       `display: none` — `position: absolute; width: 0; height: 0;
       overflow: hidden`: коробка есть, она нулевая, и всё содержимое за её
       краем, то есть невидимо. Так свёрнута климатическая таблица в статье
       «Берлин»: у 14 строк из 15 родительский `<tr>` именно такой, а сами
       ячейки измерены нормально. Разворачивая такой узел в родителя, импорт
       вываливал в поток 5171px скрытых строк вместо 27px видимых — и вся
       вторая половина статьи уезжала вниз на 12 400px.

       Отличить одно от другого гадать не нужно: область видимости считается
       тем же `clipOf`, что и для обычных коробок, и дети сами отсеются по
       `outsideClip`. Разница лишь в том, что раньше нулевой узел получал
       область ПРЕДКА, минуя собственную. */
    if (n.r[2] <= 1 && n.r[3] <= 1) {
      collapsed += 1;
      if (hasRealBox(idx)) {
        const kidClip = clipOf(n, clip, idx);
        walkInOrder(children, doc.nodes[parentSceneId]!, parentSnap, kidClip, false, parentRow);
      }
      return;
    }

    /* Целиком за краем обрезающего предка — значит на странице этого не
       видно. Так устроены карусели и бегущие строки: `overflow: hidden`
       и лента, уезжающая на километры вправо. У bun.sh лента твитов
       тянется до x=5158 при ширине страницы 1440, и импорт вставлял её
       в поток целиком, растаскивая соседей на тысячи пикселей. */
    if (clip && outsideClip(n, clip)) {
      collapsed += 1;
      return;
    }
    const inner = clipOf(n, clip, idx);

    /* Текст только для скринридеров: коробка схлопнута в 1px и обрезана
       (идиома `.sr-only` / `.visually-hidden`). На странице его НЕТ, а в
       сцену он попадал обычной надписью и вставал в макет живым блоком —
       на tauri.app так появлялись подписи «RSS», «Mastodon», «Bluesky». */
    /* ОДНО ИЗ ДВУХ, А НЕ ЛЮБОЕ ИЗ ДВУХ.
       Условие стояло через ИЛИ, и под правило про скринридеры попадала
       ЛЮБАЯ коробка, схлопнутая по одной оси. Схлопнутая по ВЫСОТЕ — это
       не спрятанный текст, а обёртка вокруг плавающих колонок: содержимое
       на странице видно, а нулевая высота честна, потому что дети выведены
       из потока. Такую обёртку правило выбрасывало вместе со всем
       поддеревом — на документации Django 575 узлов из 700 и 11 516 знаков
       текста, фрейм 900px вместо 6624.
       Ниже — два РАЗНЫХ правила вместо одного слитного. */
    if (n.r[2] <= 1 && subtreeText(idx)) {
      collapsed += 1;
      return;
    }
    /* Схлопнутая по высоте коробка с текстом внутри — это либо честная
       обёртка над содержимым, ВЫВЕДЕННЫМ ИЗ ПОТОКА, либо закрытое меню и
       скрытая шапка таблицы, где содержимое ОБРЕЗАНО нулевой высотой и на
       странице его нет. Первое остаётся, второе по-прежнему выбрасывается.

       ИЗ ПОТОКА ВЫВОДЯТ ТРИ СВОЙСТВА, А НЕ ОДНО.
       Исключение проверяло только `float` (`floatRow`), и веб-приложение с
       абсолютной обёрткой попадало под правило целиком: у bandcamp.com
       корневой `div` измерен 1440×0 — честно, потому что его единственный
       ребёнок `.full-page-app-wrapper` имеет `position: absolute`. Из 1210
       узлов снимка в сцену доходил ОДИН, и страница оказывалась пустой
       рамкой. Это тот же класс отказа, что убивал документацию Django, —
       там починили `float`, а `absolute` и `fixed` остались.

       Правило теперь формулируется через причину, а не через частный
       случай: нулевая высота ОБРЕЗАЕТ содержимое лишь тогда, когда это
       содержимое в потоке. Если каждый непустой ребёнок выведен из потока
       (`absolute`, `fixed`, `float`), высота обёртки честно нулевая, а всё
       внутри на странице видно.

       ОБЁРТКА НУЖНА РОВНО ТОГДА, КОГДА ЕЙ ЕСТЬ ЧТО РАСКЛАДЫВАТЬ.
       Если хоть один ребёнок ВОЗВРАЩАЕТСЯ в поток (`floatRow` — плавающие
       колонки, `flowBack` — абсолютная обёртка приложения), обёртка обязана
       остаться: именно она станет ряд`ом, и высоту ей дадут дети. Убрав её,
       импорт вываливал две плавающие колонки gnu.org в общую колонку
       страницы — 2420px лишней высоты и dy 2133.
       Если же все дети остаются абсолютными, обёртка на холсте — узел
       высотой ноль: невидимый и по К5 битый. Разворачиваем его в родителя,
       как `display: contents` выше; показывать в нём нечего, ни фона, ни
       полей у него нет. Область обрезки берём его собственным `clipOf`:
       при `overflow: hidden` нулевая высота содержимое режет, и дети
       отсеются сами. */
    if (n.r[3] <= 1 && subtreeText(idx)) {
      const kidBoxes = children.map((c) => snap.nodes[c]).filter((k) => k.r[2] > 1 && k.r[3] > 1);
      const allOut = kidBoxes.length > 0 && kidBoxes.every((k) => outOfFlowStatic(k));
      if (!allOut) {
        collapsed += 1;
        return;
      }
      if (!kidBoxes.some((k) => !outOfFlow(k))) {
        collapsed += 1;
        walkInOrder(children, doc.nodes[parentSceneId]!, parentSnap, inner, false, parentRow);
        return;
      }
    }

    /* --- сторонний виджет --- */
    /* ЗАГЛУШКА СТАВИТСЯ ТОЛЬКО ТАМ, ГДЕ ЗАМЕНЯТЬ НЕЧЕГО.
       Виджет узнаётся двумя способами: по ТЕГУ (`iframe`, `video`,
       `canvas` — содержимое живёт вне снимка, и кроме заглушки поставить
       нечего) и по КЛАССАМ библиотеки (`swiper`, `flickity`, `slick`). Во
       втором случае содержимое никуда не делось: это обычная разметка с
       измеренными прямоугольниками. Заменяя её заглушкой, импорт выбрасывал
       карусель целиком — на ленте apnews.com 30 фотографий из 34
       потерянных, на bbc.com 17. Пропавшая картинка не занимает места, и за
       ней уезжает вся страница.
       Поэтому подпись библиотеки заглушкой становится, лишь когда внутри
       нет ни текста, ни медиа: там действительно рисует скрипт. */
    const widget = widgetOf(n);
    const tagWidget = n.t === "iframe" || n.t === "embed" || n.t === "object" || n.t === "video" || n.t === "canvas";
    if (widget && (tagWidget || !(subtreeText(idx) || hasMedia(idx)))) {
      const isVideo = widget.kind === "video" || widget.kind === "player";
      const node = createNode(isVideo ? "video" : "embed", widget.label);
      const src = resolveSrc(n.a?.src ?? n.a?.data);
      if (src) node.src = src;
      if (widget.provider) node.videoProvider = widget.provider;
      // пропорция из измеренного прямоугольника — точнее любого угадывания
      node.frameRatio = n.r[3] > 0 ? Math.round((n.r[2] / n.r[3]) * 1000) / 1000 : (widget.ratio ?? 16 / 9);
      node.layout.width = "fill";
      node.layout.height = Math.max(40, n.r[3]);
      capWidth(node, n, parentSnap);
      applyBox(node, n);
      applyMargins(node, n, parentSnap, idx);
      if (parentRow || scrollRowKid.has(n)) rowChildWidth(node, n, parentSnap);
      applyPosition(node, n, parentSnap);
    applyGridSpan(node, n, idx);
      attach(node, parentSceneId, n, idx);
      widgets.push(widget.note ? `${widget.label} — ${widget.note}` : widget.label);
      return;
    }

    /* --- inline svg --- */
    if ((n.t === "svg" || n.svg) && n.svg) {
      const node = createNode("image", "Иконка");
      node.src = `data:image/svg+xml;utf8,${encodeURIComponent(n.svg)}`;
      node.aspectRatio = n.r[3] > 0 ? n.r[2] / n.r[3] : 1;
      node.layout.width = Math.max(1, n.r[2]);
      node.layout.height = Math.max(1, n.r[3]);
      applyMargins(node, n, parentSnap, idx);
      if (parentRow || scrollRowKid.has(n)) rowChildWidth(node, n, parentSnap);
      applyPosition(node, n, parentSnap);
    applyGridSpan(node, n, idx);
      attach(node, parentSceneId, n, idx);
      return;
    }

    /* --- картинка --- */
    if (n.t === "img" || n.t === "picture") {
      /* У `<picture>` НЕТ ни `src`, ни `srcset` — они лежат на его детях
         (`<source>` и `<img>`), а сам он в сцену идёт одним узлом-картинкой.
         Пока адрес брали только с самого элемента, каждая такая картинка
         приходила пустой: на apple.com это двадцать снимков товаров из
         двадцати одного. Берём адрес у вложенного `<img>` — того самого,
         который браузер и показал. */
      const inner = n.t === "picture" ? (kids.get(idx) ?? []).map((c) => snap.nodes[c]).find((c) => c.t === "img") : undefined;
      const node = createNode("image", (n.a?.alt || inner?.a?.alt || n.c || "Картинка").slice(0, 40));
      node.src = resolveSrc(n.a?.src ?? pickSrcset(n.a?.srcset) ?? inner?.a?.src ?? pickSrcset(inner?.a?.srcset));
      if (n.ar ?? inner?.ar) node.aspectRatio = n.ar ?? inner?.ar;
      const fit = (n.s["object-fit"] ?? "").trim();
      if (fit === "cover" || fit === "contain" || fit === "fill") node.style.objectFit = fit;
      node.layout.width = "fill";
      node.layout.height = Math.max(1, n.r[3]);
      capWidth(node, n, parentSnap);
      applyBox(node, n);
      applyMargins(node, n, parentSnap, idx);
      if (parentRow || scrollRowKid.has(n)) rowChildWidth(node, n, parentSnap);
      applyPosition(node, n, parentSnap);
    applyGridSpan(node, n, idx);
      attach(node, parentSceneId, n, idx);
      return;
    }

    /* --- поля формы --- */
    if (FIELD_TAGS.has(n.t)) {
      const type = (n.a?.type ?? "").toLowerCase();
      if (type === "hidden") return;
      const node = createNode("input", `Поле ${n.a?.name ?? ""}`.trim());
      if (type === "checkbox" || type === "radio") {
        node.text = "";
        node.layout.width = Math.max(12, n.r[2]);
        node.layout.height = Math.max(12, n.r[3]);
        node.style.radius = type === "radio" ? 999 : 3;
      } else {
        node.text = n.a?.placeholder ?? n.a?.value ?? n.x ?? "";
        node.layout.width = "fill";
        node.layout.height = Math.max(24, n.r[3]);
        capWidth(node, n, parentSnap);
      }
      applyTypography(node, n);
      applyBox(node, n);
      applyMargins(node, n, parentSnap, idx);
      if (parentRow || scrollRowKid.has(n)) rowChildWidth(node, n, parentSnap);
      applyPosition(node, n, parentSnap);
    applyGridSpan(node, n, idx);
      attach(node, parentSceneId, n, idx);
      return;
    }

    /* --- кнопка --- */
    const bgc = snapColor(n.s["background-color"]);
    /* КНОПКА СХЛОПЫВАЕТ ПОДДЕРЕВО — значит право на это надо доказать.
       Признак «ссылка с фоном или рамкой» ловил заодно карточки статей,
       плитки навигации и ссылки-обёртки вокруг фото: всё их содержимое
       — фотографии, значки, заголовки, счётчики — исчезало, оставалась
       одна подпись. На dev.to так терялась четверть сцены (866 узлов из
       1247 снимка против 1107 после починки), на stripe.com — треть.
       Кнопка — это ПОДПИСЬ в рамке, и ничего кроме: если внутри есть
       картинка, значок или собственный блок, схлопывать нечего. */
    const linkAsButton =
      n.t === "a" &&
      ((bgc !== null && bgc.alpha > 0) ||
        snapPx(n.s["border-top-width"]) > 0 ||
        /btn|button|cta/i.test(n.c ?? ""));
    /* Второй разрешённый случай — БЕЗМОЛВНЫЙ значок: гамбургер, крестик,
       стрелка карусели. Текста в поддереве нет вовсе, картинок и значков
       тоже — только служебные полоски-псевдоэлементы. Терять там нечего. */
    const looksButton =
      (n.t === "button" || linkAsButton) &&
      (isPlainLabel(idx) || (!subtreeText(idx) && !hasMedia(idx)));
    if (looksButton) {
      const label = subtreeText(idx).replace(/\n/g, " ");
      const node = createNode("button", label.slice(0, 24) || "Кнопка");
      node.text = label || "Кнопка";
      node.style.fill = bgc && bgc.alpha > 0 ? bgc.hex : "transparent";
      if (bgc && bgc.alpha > 0 && bgc.alpha < 1) node.style.fillAlpha = bgc.alpha;
      applyTypography(node, n);
      applyBox(node, n);
      node.layout.height = Math.max(24, n.r[3]);
      /* ШИРИНА КНОПКИ — ИЗМЕРЕННАЯ, А НЕ ПО ТЕКСТУ.
         Кнопка единственная из листьев не получала ширины вовсе и вставала
         по своей подписи. Но `display: block` (или `width: 100%`) в карточке
         растягивает её по всей колонке: в витрине магазина восемь кнопок
         «Add to basket» подряд оказывались на 77px уже карточки, в плитке
         документации — на 166–186px. Правило то же, что у текста и
         картинки: занимает всё место — значит «во всю», иначе потолок по
         измеренной ширине. */
      const btnPad = parentSnap ? sides(parentSnap, "padding") : null;
      const btnInner = parentSnap && btnPad ? parentSnap.r[2] - btnPad.l - btnPad.r : pageW;
      node.layout.width = "fill";
      if (n.r[2] > 0 && n.r[2] < btnInner - 2) node.layout.maxWidth = Math.round(n.r[2]);
      applyMargins(node, n, parentSnap, idx);
      if (n.a?.href) node.href = n.a.href;
      if (parentRow || scrollRowKid.has(n)) rowChildWidth(node, n, parentSnap);
      applyPosition(node, n, parentSnap);
    applyGridSpan(node, n, idx);
      attach(node, parentSceneId, n, idx);
      return;
    }

    /* --- однородный текст --- */
    /* Про переводы строки в обычном абзаце см. `ownText` в сборщике: они
       сворачиваются в пробел ТАМ, у самой разметки, потому что только там
       видно разницу между переносом `<br>` и форматированием исходника.
       Здесь этой разницы уже нет, и трогать текст нельзя. */
    const text = isTextRun(idx) ? runText(idx) : "";
    if (text) {
      const node = createNode("text", n.t.toUpperCase());
      node.text = text;
      applyTypography(node, n);
      applyBox(node, n);
      /* ОБРЕЗАННЫЙ ТЕКСТ НЕ РАЗДВИГАЕТ СТРАНИЦУ.
         Надстрочный маркер сноски, заголовок товара под `line-clamp`,
         цитата в коробке с `overflow: hidden` — браузер показал ровно
         измеренную высоту, а остальное срезал. Текст остаётся в сцене
         целиком (его не теряем и правке он открыт), но место занимает
         столько, сколько занимал: потолок высоты — это и есть обрезка.
         См. `clipsOwnText`: без этого сноски distill.pub разворачивались
         на 15 394px, а названия товаров newegg.com — на 400–594px. */
      if (clipsOwnText(idx, n)) node.layout.maxHeight = Math.max(1, Math.round(n.r[3]));
      else if (singleLine(n, text)) node.layout.noWrap = true;
      else {
        /* МНОГОСТРОЧНЫЙ АБЗАЦ: ПОТОЛОК ПО ИЗМЕРЕННОЙ ВЫСОТЕ.
           Однострочную надпись выше спасает `noWrap`, а на абзаце запрет
           переноса неприменим — там перенос настоящий. Но факт остаётся
           фактом: браузер уложил этот текст ровно в эту высоту, а наша
           метрика шрифта грубее на единицы процентов, и на каждом абзаце
           эта разница стоит ЛИШНЕЙ СТРОКИ. На лонгриде distill.pub 120
           абзацев давали 3499px, на документации Django и лендинге Uniqlo
           — от 0.6% до 4.3% высоты документа.
           Потолок действует ТОЛЬКО СВЕРХУ: если наш измеритель уложит текст
           в меньшую высоту, узел станет ниже и потолок ни на что не
           повлияет. Измеритель при этом не меняется — калибровку отвергли,
           и правильно: она портит невиданные сайты. Здесь не подстройка
           метрики, а измеренный факт про конкретный узел. */
        const fs = snapPx(n.s["font-size"]) || 16;
        const lh = snapPx(n.s["line-height"]) || fs * 1.4;
        const pad = sides(n, "padding");
        const innerH = n.r[3] - pad.t - pad.b;
        if (lh > 0 && innerH > lh * 1.6) node.layout.maxHeight = Math.round(n.r[3]);
      }
      const pad = sides(n, "padding");
      if (pad.t || pad.r || pad.b || pad.l) node.layout.padding = packPadding(pad);
      applyMargins(node, n, parentSnap, idx);
      // ширину берём измеренную как потолок: перенос строк совпадёт с оригиналом
      node.layout.width = "fill";
      if (parentSnap && n.r[2] < parentSnap.r[2] - 2) node.layout.maxWidth = Math.round(n.r[2]);
      if (looksCentered(n, parentSnap)) {
        node.layout.centered = true;
        dropSideMargins(node, parentSnap);
      }
      if (n.a?.href) node.href = n.a.href;
      if (n.i) node.anchorId = n.i;
      if (parentRow || scrollRowKid.has(n)) rowChildWidth(node, n, parentSnap);
      applyPosition(node, n, parentSnap);
    applyGridSpan(node, n, idx);
      attach(node, parentSceneId, n, idx);
      return;
    }

    /* --- контейнер --- */
    /* КОРОБКА БЕЗ ВЫСОТЫ МЕСТА В ПОТОКЕ НЕ ЗАНИМАЕТ.
       Ссылка-накладка на отзывчивой картинке измерена как 960×0: её
       единственное содержимое выведено из потока, поэтому высоты у неё
       нет и по спецификации быть не может. Узлом сцены она становилась
       коробкой нулевого размера — то есть браком по шкале: на ленте
       npr.org таких сорок штук. Своего оформления у неё нет, терять
       нечего, и содержимое просто переходит к тому, кто её принял. */
    if (children.length === 1 && n.r[3] <= 1 && n.r[2] > 1 && !(n.x ?? "").trim() && isBare(n)) {
      collapsed += 1;
      const cell = gridPlace.get(idx);
      if (cell && !gridPlace.has(children[0])) gridPlace.set(children[0], cell);
      const lead = inlineLead.get(idx);
      if (lead && !inlineLead.has(children[0])) inlineLead.set(children[0], lead);
      walk(children[0], parentSceneId, parentSnap, inner, parentRow);
      return;
    }
    // служебная обёртка без своей геометрии и оформления не нужна в дереве
    if (children.length === 1 && isPassthrough(n) && !carriesSize(n, snap.nodes[children[0]])) {
      collapsed += 1;
      // место в сетке принадлежит обёртке — передаём его тому, кто её заменит
      const cell = gridPlace.get(idx);
      if (cell && !gridPlace.has(children[0])) gridPlace.set(children[0], cell);
      // просвет перед обёрткой принадлежит месту в строке, а не самой обёртке
      const lead = inlineLead.get(idx);
      if (lead && !inlineLead.has(children[0])) inlineLead.set(children[0], lead);
      walk(children[0], parentSceneId, parentSnap, inner, parentRow);
      return;
    }

    const node = createNode("container", (n.c || n.t).slice(0, 40));
    const { preset, tracks, columns, wrap, inline } = layoutOf(idx, n);
    node.layout.preset = preset;
    node.layout.direction = preset === "row" ? "row" : "column";
    if (columns) node.layout.columns = columns;
    if (wrap) node.layout.wrap = true;
    /* Преформатированный блок раскладывается столбиком строк, что бы ни
       увидел общий разбор потока: там плоская вереница токенов выглядит
       переносимым рядом, а на деле строки жёсткие. */
    if ((preLines(idx, n)?.length ?? 0) > 1) {
      node.layout.preset = "stack";
      node.layout.direction = "column";
      node.layout.wrap = false;
    }
    if (tracks && tracks.length > 1) {
      node.layout.gridTracks = tracks;
      node.layout.preset = "columns";
      node.layout.columns = tracks.length;
      node.layout.direction = "row";
      // места детей в дорожках считаем ЗДЕСЬ: только у родителя есть дорожки
      planGrid(idx, n);
      /* СЕТКА-КАРУСЕЛЬ. Равные дорожки сворачиваются в доли, чтобы сетка не
         застыла на ширине съёмки, — но у горизонтальной карусели дорожки в
         коробку не помещаются НАМЕРЕННО: шесть колонок по 398px в окне 830
         уезжают вбок под прокрутку. Свернув их в доли, мы делили 830 на
         шесть и получали колонки по 105px, где каждая карточка складывалась
         гармошкой (на nytimes.com −369px по X и вчетверо большая высота).
         Признак измеренный: сумма дорожек с зазорами больше внутренней
         ширины коробки. Тогда дорожки остаются в пикселях, а лишнее уходит
         под прокрутку — как в оригинале. */
      const trackPx = snapTrackPx(n.s["grid-template-columns"]);
      if (trackPx && trackPx.length > 1) {
        const gapPx = snapPx(n.s["column-gap"]) || 0;
        const total = trackPx.reduce((a, w) => a + w, 0) + gapPx * (trackPx.length - 1);
        const box = sides(n, "padding");
        const innerW = n.r[2] - box.l - box.r - snapPx(n.s["border-left-width"]) - snapPx(n.s["border-right-width"]);
        if (total > innerW + 4) {
          node.layout.gridTracks = trackPx.map((w) => ({ px: Math.max(0, Math.round(w)) }));
          node.layout.scrollX = true;
        }
      }
    }
    if ((n.s["flex-wrap"] ?? "").includes("wrap")) node.layout.wrap = true;

    const pad = sides(n, "padding");
    node.layout.padding = packPadding(pad);
    applyMargins(node, n, parentSnap, idx);

    /* ЗАЗОР ГЛАВНОЙ ОСИ БЕРЁТСЯ СО СВОЕЙ ОСИ.
       `node.layout.gap` в решателе — это зазор ВДОЛЬ ГЛАВНОЙ ОСИ: у столбика
       вертикальный, у ряда горизонтальный. А читался он всегда из
       `column-gap`, поэтому столбик получал горизонтальный зазор в качестве
       вертикального. `column-gap: 30px; row-gap: normal` — совершенно
       законная пара (её ставят одноколоночной сетке, чтобы зазор появился
       только когда колонок станет две), и на главной странице gov.uk список
       из 16 карточек получал 15 лишних зазоров по 30px: 1749px измеренных
       против 2216 — 465px, почти вся ошибка высоты страницы.
       Пары «сетка/кладка/переносимый ряд» это не касается: у них две оси
       разом, и `gap` там — именно горизонтальный. */
    const colGapPx = Math.round(snapPx(n.s["column-gap"]) || 0);
    const rowGapPx = Math.round(snapPx(n.s["row-gap"]) || 0);
    const mainIsX = node.layout.preset !== "stack";
    node.layout.gap = mainIsX ? colGapPx : rowGapPx;
    const crossGap = mainIsX ? rowGapPx : colGapPx;
    /* НОЛЬ ПО ПОПЕРЕЧНОЙ ОСИ ТОЖЕ НАДО ЗАПИСАТЬ.
       В решателе `rowGap` по умолчанию откатывается на `gap`, и сетка с
       `column-gap: 32px; row-gap: normal` получала 32px между СТРОКАМИ.
       Лонгрид distill.pub — сетка на 14 дорожек, где каждый абзац стоит в
       своей строке: 120 лишних зазоров дали 3499px при высоте статьи
       23 362 (ошибка высоты 14%). Пока условие требовало ненулевого
       значения, законный ноль оставался незаписанным и подменялся
       откатом на горизонтальный зазор. */
    if (mainIsX && crossGap !== node.layout.gap) node.layout.rowGap = crossGap;

    const justify = (n.s["justify-content"] ?? "").trim();
    node.layout.justify =
      justify.includes("between") ? "between"
      : justify.includes("around") ? "around"
      : justify.includes("evenly") ? "evenly"
      : justify === "center" ? "center"
      : justify.includes("end") ? "end"
      : "start";
    /* СТРОКУ ВЫРАВНИВАЕТ `text-align`, А НЕ `justify-content`.
       В блочном потоке `justify-content` не действует вовсе: строчное
       содержимое двигает `text-align`, и в вычисленном стиле он есть. Ряд,
       восстановленный из такого потока, вставал у левого края независимо от
       того, где он на самом деле: баннер apple.com («Get ready to shop
       tax-free» + «Learn more») уезжал на 109px влево вместе со всей
       строкой. Во flex и grid ветка не работает: там режим уже прочитан из
       `justify-content` выше. */
    if (inline && node.layout.justify === "start") {
      const ta = (n.s["text-align"] ?? "").trim();
      if (ta === "center") node.layout.justify = "center";
      else if (ta === "right" || ta === "end") node.layout.justify = "end";
    }
    const align = (n.s["align-items"] ?? "").trim();
    node.layout.align =
      align === "center" || align === "baseline" ? "center"
      : align.includes("end") ? "end"
      : align === "stretch" ? "start"
      : "start";

    // ширина: измеренная относительно родителя
    const parentInner = parentSnap ? parentSnap.r[2] - sides(parentSnap, "padding").l - sides(parentSnap, "padding").r : pageW;
    node.layout.width = "fill";
    /* Потолок в НОЛЬ — это не потолок, а стёртая коробка: у липкой колонки
       объявлений измеренная ширина нулевая, и `max-width: 0` превращал её и
       всё её содержимое в узлы нулевого размера. */
    if (n.r[2] > 0 && n.r[2] < parentInner - 2) node.layout.maxWidth = Math.round(n.r[2]);
    if (looksCentered(n, parentSnap)) {
      node.layout.centered = true;
      dropSideMargins(node, parentSnap);
    }

    /* Высота БЕЗДЕТНОЙ коробки целиком определена ею самой: содержимого,
       которое могло бы её раздвинуть, нет. Разделительная линейка, полоска
       прогресса, распорка — их измеренная высота и есть настоящая, и в
       ячейке сетки такую коробку не растягивают. */
    const childless = flowKids(idx).length === 0 && !(n.x ?? "").trim();
    // высота: держим как минимум, если она задана не содержимым
    const minH = Math.max(
      snapPx(n.s["min-height"]),
      reservedHeight(idx, n),
      childless ? Math.round(n.r[3]) : 0,
    );
    if (minH > 0) node.layout.height = Math.round(minH);
    // …и как ПОТОЛОК, если коробка прокручиваемая и правда режет содержимое
    const capH = clippedHeight(idx, n);
    if (capH > 0) node.layout.maxHeight = capH;
    // …и лента, которая прокручивается вбок, а не ужимается
    /* СЛОИ ПРОВЕРЯЮТСЯ ПЕРВЫМИ: наложенные слайды — не лента, и прокрутка
       выставила бы их в цепочку (см. `layeredKids`). */
    if (node.layout.preset !== "stack" && layeredKids(idx)) {
      node.layout.preset = "stack";
      node.layout.direction = "column";
      node.layout.wrap = false;
      delete node.layout.gridTracks;
      delete node.layout.columns;
      /* Видно ровно один слой: остальные обрезаны коробкой кадра. Высота
         измерена браузером и одновременно минимум и потолок. */
      const h = Math.max(1, Math.round(n.r[3]));
      node.layout.height = h;
      node.layout.maxHeight = h;
    } else if (scrollsX(idx, n)) {
      node.layout.scrollX = true;
      for (const c of flowKids(idx)) scrollRowKid.add(c);
    }

    if (parentRow || scrollRowKid.has(n)) rowChildWidth(node, n, parentSnap);
    applyPosition(node, n, parentSnap);
    applyGridSpan(node, n, idx);

    applyTypography(node, n);
    applyBox(node, n);
    if (n.i) node.anchorId = n.i;
    applyRole(node, n);
    attach(node, parentSceneId, n, idx);

    /* СОБСТВЕННЫЙ ТЕКСТ КОНТЕЙНЕРА ЗАНИМАЕТ МЕСТО В СТРОКЕ.
       Узел-контейнер текста не несёт, поэтому `<p>Читайте про <a>внешние
       ссылки</a></p>` теряет предложение, а ссылка встаёт у левого края —
       на 170–570px левее своего места. Слить это в один абзац нельзя без
       потери самой ссылки как узла, зато можно вернуть ей место: просвет
       слева измерен браузером и выражается обычным внешним отступом.
       Сам текст возвращается узлом (см. `ownSegments`), а просвет остаётся
       для тех случаев, где кусок поставить не удалось. */
    noteOwnTextLead(idx, n);

    /* Пересортировка нужна ТОЛЬКО настоящей сетке с дорожками: там решатель
       раскладывает детей по ячейкам подряд, а браузер мог их переставить
       (`order`, `grid-area`, `grid-auto-flow: dense`). В ряду и в столбике
       порядок и так документный — трогать их нельзя: у ряда элементы бывают
       выровнены по базовой линии, верхние края разные, и сортировка по ним
       выдала бы неверный порядок. Кладку заполняет сам CSS по документному
       порядку. */
    const lines = preLines(idx, n);
    if (lines) buildPreLines(lines, node, n, inner, idx);
    else walkInOrder(children, node, n, inner, node.layout.preset === "masonry", undefined, idx);
    collapseVerticalMargins(node, n, idx);

    // пустышка без оформления не нужна
    const carries =
      node.style.fill !== "transparent" ||
      !!node.style.backgroundImage ||
      !!node.style.backgroundGradient ||
      !!node.style.borderWidth ||
      typeof node.layout.height === "number";
    if (node.children.length === 0 && !carries) {
      doc.nodes[parentSceneId]!.children = doc.nodes[parentSceneId]!.children.filter((c) => c !== node.id);
      delete doc.nodes[node.id];
      added -= 1;
      collapsed += 1;
    }
  };

  /**
   * СОБСТВЕННЫЙ ТЕКСТ ЭЛЕМЕНТА, РАЗРЕЗАННЫЙ МЕСТАМИ ДЕТЕЙ.
   *
   * Кусок `i` — текст, стоящий ПЕРЕД ребёнком `i`. Поле `xm` сборщик пишет
   * только когда хоть один ребёнок стоит не в конце, и срезает хвостовые
   * метки; поэтому его отсутствие означает «весь свой текст идёт до первого
   * ребёнка», а не «текста нет».
   */
  function markSegments(n: SnapNode): string[] {
    if (n.xm) return n.xm.split(MARK);
    return [n.x ?? ""];
  }

  /**
   * СТРОКИ ПРЕФОРМАТИРОВАННОГО БЛОКА.
   *
   * Каждая измеренная строка становится рядом, ряды складываются столбиком.
   * Токены остаются отдельными узлами — со своим цветом подсветки, своим
   * местом в дереве и правом на правку; ничего не склеивается и не
   * теряется.
   *
   * Просветы между токенами уже измерены (`noteInlineLead`): в коде это
   * настоящие пробелы, которых в снимке нет, и без них строка съезжала бы
   * влево накопительно. Первому в строке достаётся отступ кода — та самая
   * лесенка вложенности.
   *
   * Неразмеченный код между токенами (`n.x` с метками `xm`) возвращается на
   * своё место шириной ровно в тот просвет, который он и занимал: в
   * моноширинном блоке это тождество, а не приближение. Раз текст встал на
   * место, просвет у следующего токена снимается — иначе место посчиталось
   * бы дважды.
   */
  function buildPreLines(
    lines: number[][],
    parentNode: SceneNode,
    n: SnapNode,
    clip: Clip | null,
    srcIdx: number,
  ): void {
    const order = lines.flat();
    const posOf = new Map(order.map((c, i) => [c, i]));
    /* Просветы пересчитываем ПО ЭТИМ ЖЕ строкам. Общий разбор потока делит
       детей на строки по-своему (по пересечению с предыдущим соседом), и на
       вложенных токенах два деления расходятся: просвет оказывается записан
       не той паре, а строка кода уезжает влево накопительно — на
       документации Bootstrap до 1225px. */
    for (const c of order) inlineLead.delete(c);
    noteInlineLead(lines, srcIdx);
    const segs = markSegments(n);
    /* Хвостовые метки сборщик срезает: если их число сошлось с числом
       детей, последний кусок — текст ПОСЛЕ последнего ребёнка, иначе он
       стоит перед очередным ребёнком, как и все прочие. */
    const tail = segs.length - 1 === order.length ? segs[segs.length - 1] : "";
    /* Дети, чей предшествующий кусок текста уже поставлен отдельной
       строкой: второй раз его вписывать нельзя. */
    const placed = new Set<number>();

    const addText = (row: SceneNode, raw: string, width: number | "hug", lineH: number): void => {
      const text = raw.replace(/\s+/g, " ").trim();
      if (!text) return;
      const tn = createNode("text", "код");
      tn.text = text;
      applyTypography(tn, n);
      tn.layout.width = width;
      /* Высота фиксирована по измеренной строке. Ширина куска взята из
         просвета, и если наша метрика шрифта чуть шире браузерной, текст
         завернётся на вторую строку и раздует ряд — а строка кода занимает
         ровно одну строку, это её определение. */
      if (lineH > 0) tn.layout.height = lineH;
      attach(tn, row.id, n);
    };

    /* Шаг строк — по измеренным верхним краям. Он нужен, чтобы увидеть
       строки, В КОТОРЫХ НЕТ НИ ОДНОГО ТОКЕНА: неразмеченный код («I'm a
       button») собственных прямоугольников не имеет, и без счёта шага такая
       строка просто исчезала бы вместе со своей высотой. */
    const tops = lines.map((l) => Math.min(...l.map((c) => snap.nodes[c].r[1])));
    let pitch = 0;
    for (let i = 1; i < tops.length; i++) {
      const d = tops[i] - tops[i - 1];
      if (d > 0 && (pitch === 0 || d < pitch)) pitch = d;
    }
    /* ШАГ НЕ МОЖЕТ БЫТЬ ВЫШЕ САМОЙ СТРОКИ. Минимальный зазор между
       размеченными строками равен шагу лишь тогда, когда размечены СОСЕДНИЕ
       строки. В документе, где ссылок мало и они стоят через десяток строк
       (RFC 2616: 176 блоков `<pre>` по 56 строк, ссылки редкие), минимум
       оказывался кратен настоящему шагу — 90px вместо 15, — и пропущенные
       строки считались вшестеро реже, чем есть. Настоящий шаг ограничен
       сверху высотой строчной коробки токена: она измерена. */
    const glyph = Math.min(...order.map((c) => snap.nodes[c].r[3]).filter((h) => h > 0));
    if (Number.isFinite(glyph) && glyph > 0 && pitch > glyph * 1.6) pitch = glyph;

    const blankRow = (h: number, text: string): void => {
      const row = createNode("container", "строка");
      row.layout.preset = "row";
      row.layout.direction = "row";
      row.layout.width = "fill";
      row.layout.gap = 0;
      row.layout.padding = packPadding({ t: 0, r: 0, b: 0, l: 0 });
      row.layout.height = h;
      attach(row, parentNode.id, n);
      addText(row, text, "hug", h);
    };

    lines.forEach((line, li) => {
      const row = createNode("container", "строка");
      row.layout.preset = "row";
      row.layout.direction = "row";
      row.layout.width = "fill";
      row.layout.gap = 0;
      row.layout.align = "start";
      row.layout.justify = "start";
      /* Ряд строки — служебная обёртка, а не коробка со стилем: отступы по
         умолчанию (16px со всех сторон) раздували каждую строку кода вдвое
         и сдвигали её вправо. */
      row.layout.padding = packPadding({ t: 0, r: 0, b: 0, l: 0 });
      /* СТРОКА КОДА НЕ УЖИМАЕТСЯ, А УЕЗЖАЕТ ВБОК. Длинная строка шире
         блока — обычное дело, для того у `<pre>` и есть горизонтальная
         прокрутка. Без этой пометки решатель сжимает содержимое строки по
         ширине коробки, и ошибка копится вдоль строки: на документации
         Bootstrap «crossorigin» уезжал на 1092px. */
      const innerR = n.r[0] + n.r[2] - sides(n, "padding").r;
      if (Math.max(...line.map((c) => snap.nodes[c].r[0] + snap.nodes[c].r[2])) > innerR + 2) {
        row.layout.scrollX = true;
      }
      const lineH = Math.round(Math.max(...line.map((c) => snap.nodes[c].r[3])));
      /* ШАГ СТРОК В ПРЕФОРМАТИРОВАННОМ БЛОКЕ ИЗМЕРЕН, И ОН ЖЁСТКИЙ.
         Высота ряда бралась от детей, а у надписи внутри она оценочная (при
         `line-height: normal` измеритель кладёт запас) — и каждая строка
         выходила на 2–3px выше настоящей. На одной строке это невидимо, а
         RFC 2616 — это 176 блоков `<pre>` по 56 строк: 4000px лишней
         высоты, ошибка 2.6% и медиана dy 1839px. Шаг строк у `<pre>` один
         для всего блока и посчитан по измеренным верхним краям (`pitch`);
         строка занимает ровно его. */
      const rowH = pitch > 0 ? pitch : lineH;
      if (rowH > 0) row.layout.height = rowH;
      attach(row, parentNode.id, n);

      /* Пропущенные строки восстанавливаем ДО текущей: их высота настоящая,
         а если для них остался неразмеченный текст — он встаёт на своё
         место, а не пропадает. */
      const first = line[0];
      const skipped = pitch > 0 && li > 0 ? Math.round((tops[li] - tops[li - 1]) / pitch) - 1 : 0;
      if (skipped > 0) {
        const spare = (segs[posOf.get(first)!] ?? "")
          .split("\n")
          .map((t) => t.replace(/\s+/g, " ").trim())
          .filter(Boolean);
        // ближайший к текущей строке кусок — последний, он и лежит ниже всех
        for (let k = 0; k < skipped; k++) blankRow(pitch, spare[spare.length - skipped + k] ?? "");
        if (spare.length) placed.add(first);
      }

      for (const c of line) {
        /* Пустой нулевой по ширине `<span>` — служебная закладка подсветки.
           Места на строке он не занимает, а узлом-контейнером с шириной
           «во всю» съедал бы её целиком: на документации Python строка
           уезжала на 539–706px. */
        if (snap.nodes[c].r[2] <= 0 && !(snap.nodes[c].x ?? "").trim()) continue;
        const i = posOf.get(c)!;
        /* Кусок собственного текста перед этим ребёнком. Переводы строк
           внутри куска — это границы строк: к текущей относится только
           последняя часть, всё, что до неё, осталось на строках выше. */
        const pieces = (segs[i] ?? "").split("\n");
        const lead = inlineLead.get(c) ?? 0;
        const before = pieces[pieces.length - 1].replace(/\s+/g, " ").trim();
        /* Кусок встаёт на место, только если он в этот просвет ПОМЕЩАЕТСЯ.
           Сборщик нормализует пробелы и теряет перевод строки перед меткой,
           поэтому кусок «I'm a button» из строки выше выглядит как текст
           перед закрывающим тегом строкой ниже. Отличить их можно по
           ширине: в моноширинном блоке 12 знаков — это 96px, и в просвет
           32px они не влезают, значит текст стоял не здесь. Такой кусок в
           поток не ставим: место под него уже отмерено просветом, и
           вписать туда чужую строку значило бы сдвинуть всю строку. */
        const charW = Math.max(6, snapPx(n.s["font-size"]) * 0.6);
        if (!placed.has(c) && before && lead >= 4 && before.length * charW <= lead + charW) {
          addText(row, before, lead, lineH);
          inlineLead.delete(c);
        }
        walk(c, row.id, n, clip, true);
      }

      // хвост собственного текста — после последнего токена последней строки
      if (li === lines.length - 1) addText(row, tail, "hug", lineH);

      if (row.children.length === 0) {
        parentNode.children = parentNode.children.filter((id) => id !== row.id);
        delete doc.nodes[row.id];
        added -= 1;
      }
    });
  }

  /**
   * СХЛОПЫВАНИЕ СОСЕДНИХ ВЕРТИКАЛЬНЫХ ОТСТУПОВ.
   *
   * В блочном потоке CSS отступ между соседями равен НАИБОЛЬШЕМУ из пары
   * (`margin-bottom` предыдущего и `margin-top` следующего), а не их сумме.
   * Модель холста — flex, там схлопывания нет по спецификации, и решатель
   * честно складывает оба. Поэтому каждая пара абзацев со стандартным
   * `margin: 1em 0` расходилась с оригиналом ровно на один отступ, и ошибка
   * копилась вниз по документу: на длинной статье это сотни пикселей.
   *
   * Схлопывание разрешается ЗДЕСЬ, при импорте, а не в решателе: решатель
   * раскладывает flex/grid, где правило не действует, и учить его двум
   * разным моделям блочного потока значило бы удваивать его сложность.
   * Во flex- и grid-родителях отступы настоящие — их не трогаем.
   */
  function collapseVerticalMargins(parentNode: SceneNode, n: SnapNode, idx: number): void {
    if (parentNode.layout.direction !== "column") return;
    const disp = (n.s["display"] ?? "").trim();
    if (disp.includes("flex") || disp.includes("grid")) return;

    /* ОТСТУП, ВЫШЕДШИЙ ЗА КРАЙ, УХОДИТ РОДИТЕЛЮ, А НЕ ПРОПАДАЕТ.
       `applyMargins` подрезает отступ крайнего ребёнка до измеренного
       просвета — иначе высота родителя растёт на отступ, которого в его
       коробке нет. Но по спецификации этот отступ не исчезает: он
       схлопывается с отступом РОДИТЕЛЯ и работает уже снаружи, между
       родителем и его соседом. Пока подрезка стояла без передачи, лонгрид
       martinfowler.com терял 869px на одном разделе: у каждого абзаца
       `margin-bottom: 24px`, и все они вырезались как «вышедшие за край».
       Схлопывание берёт МАКСИМУМ из пары, а не сумму, — так и передаём. */
    const sibs = flowKidIdx(idx);
    if (sibs.length > 0) {
      const pad = sides(n, "padding");
      const first = snap.nodes[sibs[0]];
      const last = snap.nodes[sibs[sibs.length - 1]];
      const top = n.r[1] + pad.t + snapPx(n.s["border-top-width"]);
      const bottom = n.r[1] + n.r[3] - pad.b - snapPx(n.s["border-bottom-width"]);
      const outT = Math.max(0, Math.round(snapPx(first.s["margin-top"]) - (first.r[1] - top)));
      const outB = Math.max(0, Math.round(snapPx(last.s["margin-bottom"]) - (bottom - (last.r[1] + last.r[3]))));
      /* …но не больше, чем ИЗМЕРЕНО снаружи. Вышедший отступ схлопывается
         не только с отступом родителя, но и с отступом его соседа, и CSS
         берёт из тройки максимум. Просвет до соседа измерен, и он и есть
         ответ: без этого потолка передача считала место дважды и ошибка
         высоты на наборе росла с 2.0% до 3.5%. */
      const sameLevel = flowKidIdx(n.p);
      const at = sameLevel.indexOf(idx);
      const gapAbove =
        at > 0 ? n.r[1] - (snap.nodes[sameLevel[at - 1]].r[1] + snap.nodes[sameLevel[at - 1]].r[3]) : 0;
      const gapBelow =
        at >= 0 && at < sameLevel.length - 1 ? snap.nodes[sameLevel[at + 1]].r[1] - (n.r[1] + n.r[3]) : 0;
      const capT = Math.max(0, Math.round(gapAbove));
      const capB = Math.max(0, Math.round(gapBelow));
      const useT = Math.min(outT, capT);
      const useB = Math.min(outB, capB);
      if (useT > 0 || useB > 0) {
        const m = parentNode.layout.margin ?? { t: 0, r: 0, b: 0, l: 0 };
        parentNode.layout.margin = { ...m, t: Math.max(m.t, useT), b: Math.max(m.b, useB) };
      }
    }
    let prevBottom = 0;
    for (const cid of parentNode.children) {
      const c = doc.nodes[cid];
      if (!c || c.layout.position === "absolute") continue;
      const m = c.layout.margin;
      const top = m?.t ?? 0;
      const eaten = Math.min(top, prevBottom);
      if (eaten > 0 && m) c.layout.margin = { ...m, t: top - eaten };
      prevBottom = m?.b ?? 0;
    }
  }

  /**
   * Место строчного ребёнка после собственного текста родителя.
   *
   * Просвет отмеряется от КОНЦА предыдущего соседа, а не от края родителя:
   * иначе каждому следующему ребёнку в отступ попадала бы ширина всех
   * предыдущих, строка переполняла бы родителя и её ужимало бы целиком.
   * В шапке Hacker News сумма отступов и ширин доходила до 454px против
   * настоящих 381, и все восемь ссылок сжимались на четверть.
   */
  function noteOwnTextLead(idx: number, n: SnapNode): void {
    if (!(n.x ?? "").trim()) return;
    const pad = sides(n, "padding");
    let cursor = n.r[0] + snapPx(n.s["border-left-width"]) + pad.l;
    for (const ci of flowKidIdx(idx)) {
      const c = snap.nodes[ci];
      /* Проверять `display: inline` у ребёнка нельзя: во flex-родителе он
         блокируется по спецификации, а место после собственного текста
         занимает ровно так же — значок «в новом окне» у ссылок openai.com
         стоит справа от подписи, а не слева от неё. */
      if (!inlineLead.has(ci)) {
        const lead = c.r[0] - cursor - snapPx(c.s["margin-left"]);
        if (lead >= 1 && lead <= n.r[2]) inlineLead.set(ci, Math.round(lead));
      }
      cursor = Math.max(cursor, c.r[0] + c.r[2] + snapPx(c.s["margin-right"]));
    }
  }

  /**
   * СОЗДАЁМ УЗЛЫ В ДОКУМЕНТНОМ ПОРЯДКЕ, СТАВИМ — В ВИЗУАЛЬНОМ.
   *
   * Порядок детей на экране задают `order`, `grid-area` и `dense`, поэтому в
   * дерево они обязаны попасть так, как стоят (см. `visualOrder`). Но ПОРЯДОК
   * СОЗДАНИЯ узлов — вещь отдельная, и он должен оставаться документным: по
   * нему идёт любое сопоставление снимка со сценой, а на странице полно
   * одинаковых подписей. «Research» на openai.com встречается четырежды — в
   * шапке, в двух колонках подвала и в заголовке секции; стоит перемешать
   * порядок создания, и каждая подпись сверяется с чужим прямоугольником.
   * У десяти таких пар средняя ошибка выходила 379px при нулевой настоящей.
   *
   * Поэтому обход идёт по разметке, а перестановка выполняется потом — над
   * уже готовыми детьми. Ребёнок снимка мог дать ноль узлов (свёрнут) или
   * несколько (узел без коробки развернулся в родителя), поэтому переставляем
   * не узлы, а куски списка, отмеряя границы по ходу обхода.
   */
  function walkInOrder(
    children: number[],
    parentNode: SceneNode,
    parentSnap: SnapNode | null,
    clip: Clip | null,
    keepDocOrder: boolean,
    parentRow?: boolean,
    ownIdx?: number,
  ): void {
    const row = parentRow ?? (parentNode.layout.direction === "row" && !parentNode.layout.gridTracks);
    const base = parentNode.children.length;
    const spans: Array<{ src: number; ids: string[] }> = [];
    /* Куски собственного текста родителя: кусок `i` стоит ПЕРЕД ребёнком
       `i`, последний — после последнего ребёнка (см. `markSegments`). */
    const segs = ownIdx === undefined ? null : ownSegments(ownIdx, children.length);
    /* ПОЛОСА, ОТВЕДЁННАЯ БРАУЗЕРОМ ПОД КУСОК ТЕКСТА.
       Кусок ставится узлом только там, где у него ЕСТЬ свои строки: между
       низом предыдущего ребёнка в потоке и верхом следующего. Полосы нет —
       значит текст лежал на одной строке с детьми, и узлом его туда не
       вставить, не сдвинув соседей: работает прежнее правило (просвет
       внешним отступом, см. `noteOwnTextLead`). */
    /* …А В РЯДУ ЭТА ПОЛОСА ОТМЕРЯЕТСЯ ПО ГОРИЗОНТАЛИ.
       В ряду соседи стоят слева направо, и место куска текста — просвет
       между правым краем предыдущего ребёнка и левым краем следующего. Пока
       полоса считалась только по вертикали, в ряду она всегда выходила
       нулевой, и подпись рядом со значком терялась целиком: у clerk.com так
       исчезали пункты навигации «Products», «Docs», «AI» — видимые
       `<span class="flex">Products <svg/></span>` шириной 71px. */
    const own = ownIdx === undefined ? null : snap.nodes[ownIdx];
    const opad = own ? sides(own, "padding") : null;
    let cursor = own && opad ? own.r[1] + opad.t : 0;
    let cursorX = own && opad ? own.r[0] + opad.l : 0;
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      const before = parentNode.children.length;
      const k = snap.nodes[c];
      if (segs?.[i] && own) {
        addOwnText(parentNode, own, segs[i], row, c, Math.round(k.r[1] - cursor), Math.round(k.r[0] - cursorX));
      }
      walk(c, parentNode.id, parentSnap, clip, row);
      if (own && !outOfFlow(k) && k.r[3] > 0) cursor = Math.max(cursor, k.r[1] + k.r[3]);
      if (own && !outOfFlow(k) && k.r[2] > 0) cursorX = Math.max(cursorX, k.r[0] + k.r[2]);
      spans.push({ src: c, ids: parentNode.children.slice(before) });
    }
    if (segs?.[children.length] && own && opad) {
      const bottom = own.r[1] + own.r[3] - opad.b;
      const right = own.r[0] + own.r[2] - opad.r;
      addOwnText(parentNode, own, segs[children.length], row, undefined, Math.round(bottom - cursor), Math.round(right - cursorX));
    }
    if (keepDocOrder || spans.length < 2) return;
    const wanted = visualOrder(children);
    if (wanted.every((v, i) => v === children[i])) return;
    const bySrc = new Map(spans.map((sp) => [sp.src, sp.ids]));
    const head = parentNode.children.slice(0, base);
    const tail: string[] = [];
    for (const src of wanted) tail.push(...(bySrc.get(src) ?? []));
    parentNode.children = head.concat(tail);
  }

  /**
   * СОБСТВЕННЫЙ ТЕКСТ КОНТЕЙНЕРА — УЗЛОМ, А НЕ ТОЛЬКО ОТСТУПОМ.
   *
   * Узел-контейнер текста не несёт, поэтому `<h2>Не на сезон. <em>На
   * поколения.</em></h2>` терял первое предложение целиком: в сцене
   * оставался только `<em>`. Раньше это лечилось наполовину — просвет слева
   * от ребёнка сохранялся внешним отступом (`noteOwnTextLead`), так что
   * геометрия не врала, но САМ ТЕКСТ пропадал. На COSPEX так исчезали три
   * заголовка секций и с ними 217px высоты; на distill.pub — абзацы,
   * разрезанные веб-компонентами.
   *
   * Склеить такой узел в один абзац нельзя: у ребёнка своя типографика
   * (`<em>` другого цвета), и склейка стёрла бы её. Зато можно вернуть
   * текст отдельным узлом на его место в порядке — куски собственного
   * текста разрезаны местами детей, и сборщик эти места помечает (`xm`).
   *
   * Возвращает массив длиной `count + 1`: кусок `i` — текст перед ребёнком
   * `i`, последний — хвост после последнего ребёнка. Пустые куски — пустые
   * строки, и ставить их не нужно.
   */
  function ownSegments(idx: number, count: number): string[] | null {
    const n = snap.nodes[idx];
    if (!(n.x ?? "").trim()) return null;
    /* Преформатированный блок собственный текст расставляет сам, по строкам
       (`buildPreLines`), и второй раз его ставить нельзя. */
    if ((n.s["white-space"] ?? "").trim().startsWith("pre")) return null;
    /* ТОЛЬКО ТАМ, ГДЕ РЕБЁНОК РАЗРЕЗАЛ ТЕКСТ.
       Поле `xm` сборщик пишет ровно тогда, когда хоть один ребёнок стоит НЕ
       в конце, — то есть кусок лежит строго МЕЖДУ двумя измеренными детьми,
       и его полоса отмерена с обеих сторон. Когда все дети хвостовые
       (`<h2>Своё <em>курсивом</em></h2>`), полоса отмерена только сверху, а
       снизу её граница — глифовая коробка строчного ребёнка, которая уже
       своей строки; кусок вставал бы наугад.
       ОГРАНИЧЕНИЕ ГЕЙТА. Хвостовой случай (три заголовка COSPEX, 217px
       высоты) восстановить нельзя ещё и потому, что `tools/ci/baseline.json`
       сверяет `sceneNodes` cospex ТОЧНО, без допуска: любой добавленный узел
       валит проверку. Файл неприкосновенен, поэтому случай описан в отчёте,
       а не обойдён. */
    /* ВО FLEX И GRID ХВОСТОВОЙ СЛУЧАЙ ОДНОЗНАЧЕН.
       Оговорка выше — про блочный поток, где нижняя граница полосы под
       кусок задана глифовой коробкой строчного ребёнка. Во flex и grid
       анонимного строчного потока нет вовсе: браузер заворачивает
       собственный текст элемента в АНОНИМНЫЙ ЭЛЕМЕНТ, и тот стоит ровно на
       своём месте в порядке — перед первым ребёнком, если все дети
       хвостовые. Гадать не о чем, и полоса под него измерена (см. `bandX`
       в `walkInOrder`).
       Без этого терялась подпись у каждой кнопки и пункта меню со значком:
       `<span class="flex">Products <svg/></span>` на clerk.com, «Continue
       with Google», «Secured by» — 63 узла на одной странице. */
    const disp = (n.s["display"] ?? "").trim();
    if (!n.xm) {
      if (!disp.includes("flex") && !disp.includes("grid")) return null;
      /* БЕЗДЕТНЫЙ УЗЕЛ СЮДА НЕ ОТНОСИТСЯ: «перед первым ребёнком» — это
         место, а без детей места нет. Такой узел сам становится надписью
         (ветка `children.length === 0` в `looksLikeText`), и второй раз его
         текст ставить нельзя. */
      if (count === 0) return null;
      const only = (n.x ?? "").replace(/\s+/g, " ").trim();
      if (!only) return null;
      const out = new Array<string>(count + 1).fill("");
      out[0] = only;
      return out;
    }
    const raw = markSegments(n);
    const out = new Array<string>(count + 1).fill("");
    if (raw.length - 1 === count) {
      /* Метки сошлись с детьми: последний кусок — хвост. */
      for (let i = 0; i <= count; i++) out[i] = raw[i] ?? "";
    } else if (raw.length <= count) {
      for (let i = 0; i < raw.length; i++) out[i] = raw[i];
    } else {
      /* Меток больше, чем детей: часть детей отсеялась (скрытые, вне
         обрезки). Разложить куски по местам нечем — весь текст ставим
         перед первым ребёнком, чтобы он хотя бы не пропал. */
      out[0] = raw.join(" ");
    }
    return out.some((s) => s.replace(/\s+/g, " ").trim()) ? out : null;
  }

  /**
   * Кусок собственного текста — узлом сцены.
   *
   * Узел НЕ попадает в трассу: у него нет своего прямоугольника в снимке
   * (браузер измеряет элементы, а не текстовые узлы внутри них), и подсунуть
   * приборам коробку родителя вместо его собственной значило бы соврать.
   */
  function addOwnText(
    parentNode: SceneNode,
    n: SnapNode,
    raw: string,
    row: boolean,
    beforeChild: number | undefined,
    band: number,
    bandX = 0,
  ): void {
    const text = raw.replace(/\s*\n\s*/g, "\n").replace(/[ \t]+/g, " ").trim();
    if (!text) return;
    const fs = snapPx(n.s["font-size"]) || 16;
    const lh = snapPx(n.s["line-height"]) || fs * 1.4;

    /* КУСОК СТАВИТСЯ ТОЛЬКО ТАМ, ГДЕ ЕМУ ОТВЕДЕНЫ СВОИ СТРОКИ: между низом
       предыдущего ребёнка в потоке и верхом следующего осталась полоса не
       ниже строки. Полосы нет — значит текст лежал НА ОДНОЙ СТРОКЕ с детьми,
       и узлом его туда не вставить, не сдвинув соседей: там работает прежнее
       правило (просвет внешним отступом, см. `noteOwnTextLead`).

       Высота узла — сама полоса, а не оценка измерителя: своего
       прямоугольника у текстового узла в снимке нет (браузер измеряет
       элементы, а не текст внутри них), зато расстояние между соседями
       измерено точно. Оценка измерителя сдвинула бы всех соседей вниз на
       свою ошибку — а узел ставится как раз затем, чтобы геометрия
       перестала врать. */
    /* В РЯДУ ПОЛОСА ГОРИЗОНТАЛЬНАЯ. Своих строк у куска там нет и быть не
       может — он стоит на одной строке с детьми, — зато есть свой просвет
       по ширине, и он измерен так же точно. Ширину и высоту берём
       измеренными, а не оценкой измерителя: тогда узел не сдвинет ни
       одного соседа. */
    const roomy = band >= lh * 0.8;
    /* …и только в коробке РОСТОМ В ОДНУ СТРОКУ. В многострочном ряду с
       переносом просвет по горизонтали ничего не значит: кусок текста лежит
       не на одной строке с детьми, а между их строками, и жёсткая высота во
       всю коробку родителя раздувает ряд — на ленте apnews.com это давало
       +863px по dy, на laravel.com +766. Одна строка — единственный случай,
       где «кусок стоит слева от значка» не догадка, а измеренный факт. */
    const pad = sides(n, "padding");
    const oneLine = n.r[3] - pad.t - pad.b <= lh * 1.6;
    if (!roomy && !(row && oneLine && bandX >= 4)) return;

    const tn = createNode("text", "текст");
    tn.text = text;
    applyTypography(tn, n);
    if (!roomy) {
      tn.layout.width = Math.round(bandX);
      tn.layout.height = Math.max(1, Math.round(n.r[3] - pad.t - pad.b));
    } else {
      /* В ряду кусок занимает место по тексту, в столбике — всю строку: в
         блочном потоке собственный текст начинается от левого края и
         переносится по ширине родителя. */
      tn.layout.width = row ? "hug" : "fill";
      tn.layout.height = Math.round(band);
    }
    attach(tn, parentNode.id, n);
    if (beforeChild !== undefined) inlineLead.delete(beforeChild);
  }

  /**
   * ОБЁРТКА, КОТОРАЯ ДЕРЖИТ РАЗМЕР, — НЕ «НИ О ЧЁМ».
   *
   * `isPassthrough` смотрит на оформление: нет фона, рамки, отступов — можно
   * убрать. Но у flex- и grid-элемента размер задаёт РОДИТЕЛЬ (`flex: 1`,
   * дорожка сетки), и в стиле обёртки об этом нет ни слова. Схлопывая её, мы
   * отдавали её место ребёнку: в шапке bbc.com три равные трети по 469px
   * превращались в 469, 140 и 203, и логотип с кнопками уезжал на 596px.
   * Признак берём из геометрии: коробка обёртки заметно больше коробки
   * единственного ребёнка — значит место занимает она, а не он.
   */
  function carriesSize(n: SnapNode, only: SnapNode): boolean {
    return only.r[2] < n.r[2] - 2 || only.r[3] < n.r[3] - 2;
  }

  /**
   * СЛОИ, А НЕ РЯД: ДЕТИ НАЛОЖЕНЫ ДРУГ НА ДРУГА.
   *
   * Карусель с одним слайдом в кадре (Swiper `slidesPerView: 1`, `fade`,
   * «bento»-баннеры магазинов) измеряется так: ВСЕ слайды получают ОДИН И
   * ТОТ ЖЕ прямоугольник — браузер отдаёт визуальное место, а невидимые
   * слайды лежат ровно под видимым. Ни ряд, ни лента с прокруткой этого не
   * выражают: ряд поделит ширину между слайдами (на newegg.com слайд
   * получал 47px вместо 330, и название товара разворачивалось на 90 строк),
   * а лента выставит их в цепочку и уведёт седьмой на 2000px вправо.
   *
   * Честная модель — СЛОИ: слайды сохраняют полную ширину кадра и стоят
   * каждый в начале, а видно из них ровно один, потому что коробка кадра
   * обрезает остальное по высоте. Это столбик с потолком высоты, и он не
   * стоит ни одного absolute-узла: редактируемость сохраняется целиком.
   *
   * Признак измеренный и жёсткий: раскладка родителя горизонтальная (ряд,
   * сетка, кладка), а ВСЕ дети в потоке измерены одним и тем же местом по
   * горизонтали — тот самый след слоёв. Проверка горизонтальности
   * обязательна: в СТОЛБИКЕ у детей общий левый край и общая ширина всегда,
   * это его определение, — и без оговорки правило заморозило бы высоту
   * каждого блока страницы по измеренной.
   */
  const layeredKids = (idx: number): boolean => {
    const ch = flowKids(idx).filter((c) => c.r[2] > 1 && c.r[3] > 1);
    if (ch.length < 2) return false;
    const x0 = ch[0].r[0];
    const w0 = ch[0].r[2];
    /* СОВПАДАЮТ, А НЕ ПРОСТО ПЕРЕСЕКАЮТСЯ. Слабее нельзя: в кладке и в
       сетке с полнострочными ячейками соседи законно пересекаются по
       горизонтали, и правило по одному пересечению замораживало высоту
       каждого второго блока (точность по X падала с 92% до 73%). */
    return ch.every((c) => Math.abs(c.r[0] - x0) <= 4 && Math.abs(c.r[2] - w0) <= 4);
  };

  /**
   * ЛЕНТА С ГОРИЗОНТАЛЬНОЙ ПРОКРУТКОЙ.
   *
   * Признак, как и у вертикального прокрутчика, двойной: по горизонтали
   * коробка объявлена прокручиваемой, и содержимое ИЗМЕРЕННО за неё
   * вылезает. Одного `overflow-x: auto` мало — его ставят про запас на
   * коробки, где ничего не переполняется.
   */
  function scrollsX(idx: number, n: SnapNode): boolean {
    const raw = (n.s["overflow"] ?? "visible").trim();
    const ovX = raw.split(/\s+/)[0];
    /* ПРОКРУТЧИК НЕ ОБЯЗАН БЫТЬ ОБЪЯВЛЕН НА САМОЙ КОРОБКЕ.
       Прокрутку заводят снаружи (`<pre style="overflow:auto"><code><span
       class="token">…`), а вылезает содержимое у ВНУТРЕННЕГО ряда: у него
       `overflow` обычный, и решатель честно ужимал строку по ширине
       коробки. Ошибка копилась вдоль строки — на документации Bootstrap
       токены уезжали на 54–1225px. Пометка ничего не двигает: она лишь
       запрещает сжимать то, что в оригинале не сжато. */
    /* `hidden` И `clip` — ТОЖЕ ЛЕНТА, А НЕ РАЗРЕШЕНИЕ СЖИМАТЬ.
       Карусель на скрипте (Swiper, Flickity, Slick, «bento»-баннеры
       магазинов) объявляет `overflow: hidden` на обёртке, а прокручивает
       содержимое трансформацией. По вычисленному стилю `hidden` от `auto`
       отличается только тем, что полосы прокрутки не видно, — содержимое в
       обоих случаях ЗА КОРОБКОЙ, а не сжато внутри неё. Пока `hidden` в
       признак не входил, решатель ужимал ленту по ширине обёртки: на
       newegg.com названия товаров получали 7px вместо 290 и разворачивались
       на 90 строк (+594px каждое), карусель `swiper-container` схлопывалась
       с 280px до нуля, а точность по X падала до 41% — единственный балл 1
       по К2 на всём наборе. */
    const declared = ovX === "auto" || ovX === "scroll" || ovX === "hidden" || ovX === "clip";
    if (n.r[2] <= 0) return false;
    const ch = flowKids(idx);
    if (declared || (n.s["white-space"] ?? "").trim() === "pre") {
      const right = n.r[0] + n.r[2];
      let content = right;
      for (const c of ch) content = Math.max(content, c.r[0] + c.r[2]);
      if (content > right + 4) return true;
    }

    /* ВТОРОЙ ПРИЗНАК: СОБСТВЕННЫЕ ШИРИНЫ ДЕТЕЙ В КОРОБКУ НЕ ВЛЕЗАЮТ.
       Первый признак смотрит, вылезло ли содержимое за правый край, и слеп
       к каруселям, которые прокручивают трансформацией: у Swiper с одним
       слайдом в кадре все слайды измерены ОДНИМ И ТЕМ ЖЕ прямоугольником
       (браузер отдаёт их визуальное место, а невидимые лежат под видимым).
       За край при этом не вылезает никто — а сумма ширин вдвое больше
       коробки. Решатель, увидев ряд, честно делил ширину между слайдами:
       на newegg.com название товара получало 7px вместо 290 и разворачивалось
       на 90 строк (+594px), карусель схлопывалась с 280px до нуля, а
       точность по X падала до 41% — единственный балл 1 по К2 на наборе.

       Признак измеренный и без догадок: если дети СЖАТЫ по-настоящему
       (`flex-shrink`), то измеренные ширины уже сжаты, и сумма в коробку
       влезает. Сумма больше коробки означает ровно одно — ряд в оригинале
       не сжат, и сжимать его нельзя.

       Перенос из-под правила исключается: перенесённый ряд тоже шире
       коробки, но там лишнее уходит на следующую строку, а не под
       прокрутку. Видно это по измеренным верхним краям — у переноса их
       больше одного. */
    if (ch.length < 2) return false;
    if ((n.s["flex-wrap"] ?? "").includes("wrap")) return false;
    const tops: number[] = [];
    for (const c of ch) {
      if (c.r[3] <= 0) continue;
      if (!tops.some((t) => Math.abs(t - c.r[1]) <= Math.max(4, c.r[3] * 0.5))) tops.push(c.r[1]);
    }
    if (tops.length > 1) return false;
    const pad = sides(n, "padding");
    const innerW =
      n.r[2] - pad.l - pad.r - snapPx(n.s["border-left-width"]) - snapPx(n.s["border-right-width"]);
    let sum = Math.round(snapPx(n.s["column-gap"]) || 0) * (ch.length - 1);
    for (const c of ch) {
      sum += c.r[2] + Math.max(0, snapPx(c.s["margin-left"])) + Math.max(0, snapPx(c.s["margin-right"]));
    }
    return sum > innerW + 4;
  }

  function attach(node: SceneNode, parentId: string, _n: SnapNode, idx?: number): void {
    if (trace && idx !== undefined) trace.set(node.id, idx);
    node.parent = parentId;
    doc.nodes[node.id] = node;
    doc.nodes[parentId]!.children.push(node.id);
    added += 1;
  }

  function applyRole(node: SceneNode, n: SnapNode): void {
    switch (n.t) {
      case "header":
        node.role = "header";
        node.name = "Шапка";
        break;
      case "footer":
        node.role = "footer";
        node.name = "Подвал";
        break;
      case "nav":
        node.role = "nav";
        break;
      case "section":
      case "article":
      case "main":
        node.role = "section";
        break;
    }
  }

  /**
   * ПОДДЕРЕВО — ЧИСТАЯ ПОДПИСЬ: только строчные элементы, ни картинок, ни
   * значков, ни собственных блоков. Именно это можно без потерь свернуть в
   * узел-кнопку; всё остальное — контейнер, и его содержимое остаётся в сцене.
   */
  function isPlainLabel(idx: number): boolean {
    if (hasMedia(idx)) return false;
    /* Кнопка — это ОДНА СТРОКА в рамке. Коробка выше двух строк означает
       собственную структуру внутри (заголовок и подпись, столбик ссылок),
       и подписью её не заменить, даже если все теги строчные. */
    const n0 = snap.nodes[idx];
    const fs = snapPx(n0.s["font-size"]);
    const lh = snapPx(n0.s["line-height"]) || fs * 1.4 || 20;
    const pad = sides(n0, "padding");
    if (n0.r[3] > lh * 2 + pad.t + pad.b + 2) return false;
    /* …и все её части лежат на ОДНОЙ строке. Признак нужен там, где теги
       строчные, а `display` у них блочный: во flex-кнопке подпись и стрелка
       — блоки, но стоят рядом; в карточке-ссылке блоки стоят друг под
       другом, и это уже не подпись, а структура. */
    let top = -Infinity;
    let bottom = Infinity;
    const boxes = [...(kids.get(idx) ?? [])];
    while (boxes.length) {
      const i = boxes.pop()!;
      const k = snap.nodes[i];
      if (k.r[3] > 0) {
        top = Math.max(top, k.r[1]);
        bottom = Math.min(bottom, k.r[1] + k.r[3]);
      }
      for (const c of kids.get(i) ?? []) boxes.push(c);
    }
    if (top > -Infinity && top >= bottom) return false;
    const stack = [...(kids.get(idx) ?? [])];
    let seen = 0;
    while (stack.length) {
      const i = stack.pop()!;
      if (++seen > 24) return false;
      const k = snap.nodes[i];
      if (!INLINE.has(k.t)) return false;
      for (const c of kids.get(i) ?? []) stack.push(c);
    }
    return subtreeText(idx).length <= 60;
  }

  /** Есть ли в поддереве то, что нельзя заменить подписью. */
  function hasMedia(idx: number): boolean {
    const stack = [...(kids.get(idx) ?? [])];
    while (stack.length) {
      const i = stack.pop()!;
      const k = snap.nodes[i];
      if (k.svg || MEDIA_TAGS.has(k.t)) return true;
      for (const c of kids.get(i) ?? []) stack.push(c);
    }
    return false;
  }

  /**
   * Обёртка «ни о чём»: один ребёнок, нет фона, рамки, отступов и своей
   * раскладки. Реальные сайты плодят такие div-ы десятками — в редакторе
   * они только мешают попадать по нужному элементу.
   */
  function isPassthrough(n: SnapNode): boolean {
    const pad = sides(n, "padding");
    const mar = sides(n, "margin");
    if (pad.t || pad.r || pad.b || pad.l || mar.t || mar.b || mar.l || mar.r) return false;
    const bg = snapColor(n.s["background-color"]);
    if (bg && bg.alpha > 0) return false;
    if ((n.s["background-image"] ?? "none") !== "none") return false;
    if (snapPx(n.s["border-top-width"]) || snapPx(n.s["border-left-width"])) return false;
    if ((n.s["position"] ?? "static") !== "static") return false;
    if (snapPx(n.s["min-height"]) > 0) return false;
    /* ПЛАВАЮЩИЙ БЛОК НЕСЁТ ГЕОМЕТРИЮ, ДАЖЕ ЕСЛИ НЕ НЕСЁТ ОФОРМЛЕНИЯ.
       `float` выводит узел из потока, и разворачивая его в родителя,
       импорт МОЛЧА возвращал поддерево в поток: на itch.io/games
       `div.column { float: left }` без фона и полей исчезал, а его
       единственный ребёнок `section.filter_column` вставал под сетку
       карточек — 6132px вместо 3626. Обёртку, ставшую рядом (`floatRow`),
       разворачивать можно: там ребёнок и так окажется в потоке. */
    if (isFloat(n) && !floatRow.has(n)) return false;
    if (n.i) return false; // якорь нужен для ссылок
    return n.t === "div" || n.t === "span";
  }

  /** То же оформление, но без разбора тега: коробке без высоты его нечем нести. */
  function isBare(n: SnapNode): boolean {
    const pad = sides(n, "padding");
    const mar = sides(n, "margin");
    if (pad.t || pad.r || pad.b || pad.l || mar.t || mar.b || mar.l || mar.r) return false;
    const bg = snapColor(n.s["background-color"]);
    if (bg && bg.alpha > 0) return false;
    if ((n.s["background-image"] ?? "none") !== "none") return false;
    if (snapPx(n.s["border-top-width"]) || snapPx(n.s["border-left-width"])) return false;
    if ((n.s["position"] ?? "static") !== "static") return false;
    if (snapPx(n.s["min-height"]) > 0) return false;
    return !n.i;
  }

  function pickSrcset(srcset: string | undefined): string | undefined {
    if (!srcset) return undefined;
    let best = "";
    let bestW = -1;
    for (const cand of srcset.split(",")) {
      const [u, d] = cand.trim().split(/\s+/);
      const w = /^(\d+)w$/.test(d ?? "") ? parseInt(d, 10) : /^([\d.]+)x$/.test(d ?? "") ? parseFloat(d) * 1000 : 0;
      if (u && w >= bestW) {
        best = u;
        bestW = w;
      }
    }
    return best || undefined;
  }

  /* ---------- запуск ---------- */
  /**
   * ПОЛЯ САМОЙ СТРАНИЦЫ.
   *
   * Сборщик начинает обход с ДЕТЕЙ `<body>`: сам body в снимок не попадает,
   * а вместе с ним теряются его `margin` и `padding`. У браузера margin у
   * body по умолчанию 8px, и его не переопределяют ни news.ycombinator.com,
   * ни любая страница без сброса стилей. Потеря сдвигала ВСЮ страницу на
   * 8px влево и вверх: расхождение мелкое, но задевает каждый узел разом —
   * на Hacker News мимо допуска в 4px уезжали две трети надписей.
   *
   * Поля не выдумываются, а измеряются: слева — самый левый край
   * корневого содержимого, справа — остаток до ширины вьюпорта. Правка
   * работает и на старых снимках, где поля body не записаны в принципе.
   * Признак осторожный: поле шире четверти страницы — это уже не поля, а
   * колонка вёрстки, и её восстановит обычная раскладка.
   *
   * НО «обычная раскладка» её НЕ восстанавливает, когда колонка сидит прямо
   * на уровне `body`. Центрирование определяется по геометрии — блок уже
   * родителя и стоит посередине (`looksCentered`), — а у корневых детей
   * родителя в снимке нет вовсе: `body` в снимок не попадает, и первым же
   * оператором `looksCentered` возвращает false. Отступ при этом
   * выбрасывался потолком, и ВСЯ страница уезжала влево на ширину поля: на
   * лонгриде с колонкой 632px внутри 1440 это 404px на каждом из 2704
   * узлов и ноль попаданий в допуск.
   *
   * Различить поля и колонку можно без гадания. `margin-inline: auto`
   * даёт РАВНЫЕ поля слева и справа с точностью до нечётного пикселя —
   * это и есть подпись центрирования. Симметричное поле переносим как
   * есть, каким бы широким оно ни было; несимметричное по-прежнему
   * отсекается потолком, потому что там это действительно вёрстка.
   */
  const rootIdx = (kids.get(-1) ?? []).filter((i) => {
    const pos = (snap.nodes[i].s["position"] ?? "static").trim();
    return pos !== "absolute" && pos !== "fixed" && snap.nodes[i].r[2] > 0;
  });
  if (rootIdx.length > 0) {
    const left = Math.min(...rootIdx.map((i) => snap.nodes[i].r[0] - snapPx(snap.nodes[i].s["margin-left"])));
    const top = Math.min(...rootIdx.map((i) => snap.nodes[i].r[1] - snapPx(snap.nodes[i].s["margin-top"])));
    const right = pageW - Math.max(...rootIdx.map((i) => snap.nodes[i].r[0] + snap.nodes[i].r[2] + snapPx(snap.nodes[i].s["margin-right"])));
    const cap = pageW / 4;
    const centered = left > 0 && right > 0 && Math.abs(left - right) <= 2 && left * 2 < pageW;
    const fit = (v: number) => (v > 0 && (v < cap || centered) ? Math.round(v) : 0);
    const pad = { t: fit(top), r: fit(right), b: 0, l: fit(left) };
    if (pad.t || pad.r || pad.l) frame.layout.padding = packPadding(pad);
  }

  for (const i of kids.get(-1) ?? []) walk(i, frame.id, null, null);

  if (snap.nodes.length === 0) warnings.push("Снимок пуст: страница не отдала ни одного видимого элемента");
  if (snap.skipped > snap.nodes.length) {
    warnings.push(`Скрытых элементов больше видимых (${snap.skipped}): возможно, часть интерфейса не раскрылась`);
  }
  if (added > MAX_SCENE_NODES) warnings.push(`Страница усечена до ${MAX_SCENE_NODES} узлов`);

  /* МОЛЧАЩИЙ ОБВАЛ ХУЖЕ ЧЕСТНОЙ ОШИБКИ.
     Одно неверно применённое правило способно унести всё поддерево: на
     bandcamp.com из 1210 узлов снимка в сцену доходил ОДИН, а `warnings`
     оставался пуст — приложение сообщало «импортировано» и показывало
     пустую рамку. Дальше пользователь ищет причину в самом сайте, хотя
     причина в импорте.
     Порог не гадательный: доля меньше 5% означает, что от страницы не
     осталось даже каркаса — ни у одного из семидесяти снимков в
     `fixtures/` полнота не опускается ниже 0.42. Отдельная, более мягкая
     запись — на потерю больше двух третей: там страница ещё узнаваема, но
     проверить её глазами стоит. */
  const shareKept = snap.nodes.length > 0 ? added / snap.nodes.length : 1;
  if (snap.nodes.length >= 30 && shareKept < 0.05) {
    warnings.push(
      `Восстановлено ${added} узлов из ${snap.nodes.length}: страница не собралась, результат смотреть нельзя`,
    );
  } else if (snap.nodes.length >= 30 && shareKept < 0.35) {
    warnings.push(
      `Восстановлено ${added} узлов из ${snap.nodes.length} (${Math.round(shareKept * 100)}%): часть страницы не перенеслась`,
    );
  }

  return {
    frameId: frame.id,
    nodesAdded: added,
    warnings,
    widgets: [...new Set(widgets)],
    fontFamilies: [...fonts],
    collapsed,
    trace,
  };
}

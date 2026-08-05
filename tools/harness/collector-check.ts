/**
 * ПРОВЕРКА СБОРЩИКА СНИМКА БЕЗ БРАУЗЕРА.
 *
 * Текст сборщика едет в чужую страницу шаблонной строкой, и синтаксическая
 * ошибка в нём не видна ни `tsc`, ни сборке: она проявится только в живом
 * окне, где отладчика нет. Поэтому скрипт здесь разбирается как код, а его
 * разбор текста прогоняется на jsdom против набора случаев со смешанным
 * содержимым — того самого, на котором терялся порядок слов.
 *
 *   npx tsx tools/harness/collector-check.ts
 */
import { JSDOM } from "jsdom";
import { collectorScript } from "../../src/core/snapshot";

const src = collectorScript();
let failed = 0;
const check = (name: string, ok: boolean, note = ""): void => {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${note ? ` — ${note}` : ""}`);
};

/* 1. Скрипт обязан быть синтаксически корректным. */
try {
  new Function(`return ${src}`);
  check("текст сборщика разбирается", true, `${(src.length / 1024).toFixed(1)} КБ`);
} catch (e) {
  check("текст сборщика разбирается", false, String(e).slice(0, 160));
}

/* 2. Разбор текста: тот же алгоритм нормализации, что и раньше, плюс метки. */
const dom = new JSDOM("<!doctype html><html><body></body></html>");
const doc = dom.window.document;
const NUL = String.fromCharCode(0);

/** Достаём ownText из текста сборщика и запускаем на настоящем DOM. */
const body = src.slice(src.indexOf("function ownText(el) {"));
const fn = new Function(
  "el",
  `var MARK = String.fromCharCode(0); var NL = String.fromCharCode(10);\n${body.slice(0, body.indexOf("\n  var ATTRS"))}\n return ownText(el);`,
);

const cases: Array<[string, string, string | null]> = [
  ["<p>Просто текст</p>", "Просто текст", null],
  ["<p>a  \n  b</p>", "a\nb", null],
  ["<p>  поля  </p>", "поля", null],
  ["<a><span>#</span>discuss</a>", "discuss", `${NUL}discuss`],
  ["<p>См. <a>доки</a> и дальше</p>", "См. и дальше", `См. ${NUL} и дальше`],
  ["<p>Хвост <a>ссылка</a></p>", "Хвост", null],
  ["<p>a<br>b</p>", "a\nb", null],
  ["<h2>Только <em>вложенное</em></h2>", "Только", null],
];

for (const [html, wantText, wantMark] of cases) {
  const host = doc.createElement("div");
  host.innerHTML = html;
  const el = host.firstElementChild!;
  const got = fn(el) as { text: string; marked: string };
  const interior = got.marked.replace(new RegExp(`${NUL}+$`), "");
  const markOut = interior !== got.text && interior.includes(NUL) ? interior : null;
  const okText = got.text === wantText;
  const okMark = markOut === wantMark;
  check(
    `«${html}»`,
    okText && okMark,
    okText && okMark
      ? ""
      : `текст ${JSON.stringify(got.text)} ждали ${JSON.stringify(wantText)}; метки ${JSON.stringify(markOut)} ждали ${JSON.stringify(wantMark)}`,
  );
}

console.log(`\nИТОГ: провалено ${failed} из ${cases.length + 1}`);
process.exit(failed > 0 ? 1 : 0);

/**
 * Модалка импорта сайта: по ссылке или из HTML-файла на диске.
 *
 * Здесь же задаётся ШИРИНА ВЬЮПОРТА, под которую разбирается страница.
 * Это не косметика: от неё зависят единицы vw, адаптивные кегли `clamp()`,
 * какие медиазапросы попадут в макет и ширина колонки текста. Раньше ширина
 * была зашита (1200px) — поэтому размер исходной страницы игнорировался.
 */
import { useState } from "react";
import { useStore } from "../core/store";
import { useUi } from "../core/uiStore";

/** Типовые ширины: ноутбук, десктоп, широкий монитор, планшет. */
const PRESETS = [1280, 1440, 1600, 1920, 1024] as const;

export function UrlImportModal({ onClose }: { onClose: () => void }) {
  const importUrlSite = useStore((s) => s.importUrlSite);
  const importUrlViaBrowser = useStore((s) => s.importUrlViaBrowser);
  const importHtmlSite = useStore((s) => s.importHtmlSite);
  const importWidth = useUi((s) => s.importWidth);
  const setImportWidth = useUi((s) => s.setImportWidth);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  // способ разбора: быстрый по HTML или точный через настоящий браузер
  const [mode, setMode] = useState<"html" | "browser">("browser");

  const runUrl = async (): Promise<void> => {
    if (!url.trim() || busy) return;
    setBusy(true);
    try {
      if (mode === "browser") await importUrlViaBrowser(url.trim(), importWidth);
      else await importUrlSite(url.trim(), importWidth);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const runFile = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const { pickHtmlFile, isTauri } = await import("../tauri/api");
      if (!isTauri()) {
        useStore.getState().log("info", "Импорт файла с диска доступен в десктоп-версии");
        return;
      }
      const htmlPath = await pickHtmlFile();
      if (htmlPath) {
        await importHtmlSite({ htmlPath, viewportWidth: importWidth });
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Импорт сайта</div>

        <div className="field">
          <label>Ширина страницы при разборе</label>
          <div className="size-control">
            {PRESETS.map((w) => (
              <button
                key={w}
                type="button"
                className={`chip${importWidth === w ? " on" : ""}`}
                onClick={() => setImportWidth(w)}
              >
                {w}
              </button>
            ))}
            <input
              type="number"
              value={importWidth}
              style={{ width: 78 }}
              onChange={(e) => setImportWidth(Number(e.target.value) || 1440)}
            />
          </div>
        </div>
        <div className="side-note" style={{ paddingLeft: 0 }}>
          От ширины зависят единицы vw, адаптивные кегли clamp() и то, какие
          медиазапросы попадут в макет. Она же станет размером страницы на холсте.
        </div>

        <div className="field">
          <label>Способ разбора</label>
          <div className="preset-grid">
            <button
              type="button"
              className={`preset-btn${mode === "browser" ? " on" : ""}`}
              title="Страница открывается в настоящем браузере: работают скрипты, шрифты и вся вёрстка. Медленнее, зато импортируются сайты, которых в HTML нет"
              onClick={() => setMode("browser")}
            >
              <span>◉</span>
              <span>Через браузер</span>
            </button>
            <button
              type="button"
              className={`preset-btn${mode === "html" ? " on" : ""}`}
              title="Читается только серверный HTML и CSS. Быстро, но SPA отдают пустой каркас"
              onClick={() => setMode("html")}
            >
              <span>⚡</span>
              <span>Быстро (HTML)</span>
            </button>
          </div>
        </div>
        <div className="side-note" style={{ paddingLeft: 0 }}>
          {mode === "browser"
            ? "Страница соберётся по-настоящему: скрипты выполнятся, шрифты применятся, геометрия снимется измерением. Так импортируются сайты, у которых в HTML лежит только каркас."
            : "Читается только то, что прислал сервер. Для статичных сайтов быстрее; у SPA в ответе почти пусто."}
        </div>

        <div className="field">
          <label>URL страницы</label>
          <input
            autoFocus
            value={url}
            placeholder="example.com или https://example.com/page"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runUrl();
            }}
          />
        </div>
        <div className="side-note" style={{ paddingLeft: 0 }}>
          Скачаю HTML и связанные CSS, разберу вёрстку в страницу на холсте.
          Картинки подтянутся по абсолютным URL. Динамические сайты (JS-рендер)
          импортируются частично.
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Отмена</button>
          <button className="btn" disabled={busy} onClick={() => void runFile()}>
            HTML с диска…
          </button>
          <button className="btn btn-accent" disabled={busy || !url.trim()} onClick={() => void runUrl()}>
            {busy ? (mode === "browser" ? "Собираю страницу…" : "Импортирую…") : "Импортировать"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Живой предпросмотр сайта.
 *
 * v2 (после фидбэка «переходы между страницами ничего не прогружают»):
 * раньше страница отдавалась через srcDoc — у такого документа origin
 * "null", поэтому переход по ссылке (page.html) вёл в пустоту, а якоря
 * #section не работали. Теперь каждая страница собирается в Blob и
 * отдаётся по blob: URL — навигация внутри iframe работает нативно,
 * ссылки между страницами перехватываются и переключают blob, а якоря
 * прокручивают документ сами (scroll-behavior: smooth).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../core/store";
import { generateProject } from "../core/codegen";
import { getActiveRoot, isTauri, resolveAssetUrl } from "../tauri/api";

/** Служебный скрипт предпросмотра: перехват ссылок и ловля ошибок. */
const PREVIEW_SHIM = `<script>
  window.__PLX_PREVIEW = 1;
  document.addEventListener("click", (e) => {
    const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    const href = a.getAttribute("href") || "";
    if (href.startsWith("#")) return;                 // якоря — нативно
    if (/^(https?:|mailto:|tel:)/.test(href)) {       // внешние — в системный браузер
      e.preventDefault();
      parent.postMessage({ __plx: "external", href }, "*");
      return;
    }
    e.preventDefault();
    parent.postMessage({ __plx: "nav", file: href.split("#")[0], hash: (href.split("#")[1] || "") }, "*");
  });
  window.addEventListener("error", (e) => {
    parent.postMessage({ __plx: "error", id: null, message: String(e.message) }, "*");
  });
</script>`;

/** Инлайн-сборка страницы: css/js внутрь — работает без сервера. */
function buildPreviewHtml(files: Record<string, string>, pageFile: string): string {
  let html = files[`site/${pageFile}`] ?? "<!doctype html><body>Страница не найдена</body>";
  const css = files["site/styles.css"] ?? "";
  const js = files["site/script.js"];

  html = html.replace('<link rel="stylesheet" href="styles.css" />', `<style>\n${css}\n</style>`);
  html = html.replace('<script src="script.js" defer></script>', "");
  html = html.replace("</head>", `${PREVIEW_SHIM}\n</head>`);
  html = html.replace("</body>", `${js ? `<script>\n${js}\n</script>` : ""}\n</body>`);
  if (isTauri() && getActiveRoot()) {
    html = html.replaceAll('src="assets/', `src="${resolveAssetUrl("assets/")}`);
  }
  return html;
}

export function PreviewView() {
  const rev = useStore((s) => s.rev);
  const doc = useStore((s) => s.doc);
  const projectName = useStore((s) => s.projectName);
  const [pageFile, setPageFile] = useState("index.html");
  const [hash, setHash] = useState("");
  const [debouncedRev, setDebouncedRev] = useState(rev);
  const debounceTimer = useRef<number>(0);
  const blobRef = useRef<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  /* дебаунс пересборки при потоке правок */
  useEffect(() => {
    window.clearTimeout(debounceTimer.current);
    debounceTimer.current = window.setTimeout(() => setDebouncedRev(rev), 250);
    return () => window.clearTimeout(debounceTimer.current);
  }, [rev]);

  const { files, pages } = useMemo(() => {
    const generated = generateProject(doc, projectName);
    const pageEntries = Object.keys(generated.files)
      .filter((p) => p.startsWith("site/") && p.endsWith(".html"))
      .map((p) => p.replace("site/", ""));
    return { files: generated.files, pages: pageEntries };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedRev, projectName]);

  /* если текущая страница удалена — вернуться на первую */
  useEffect(() => {
    if (pages.length > 0 && !pages.includes(pageFile)) setPageFile(pages[0]);
  }, [pages, pageFile]);

  /* пересборка blob-документа при смене страницы или модели */
  useEffect(() => {
    const html = buildPreviewHtml(files, pageFile);
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    if (blobRef.current) URL.revokeObjectURL(blobRef.current);
    blobRef.current = url;
    setBlobUrl(hash ? `${url}#${hash}` : url);
    return () => {
      // отзываем только при размонтировании (иначе iframe потеряет источник)
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, pageFile, hash]);

  useEffect(
    () => () => {
      if (blobRef.current) URL.revokeObjectURL(blobRef.current);
    },
    [],
  );

  /* сообщения из iframe: навигация, внешние ссылки, ошибки */
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const data = e.data as { __plx?: string; file?: string; hash?: string; href?: string; id?: string | null; message?: string };
      if (!data?.__plx) return;
      const store = useStore.getState();
      if (data.__plx === "nav") {
        const target = data.file && data.file.length > 0 ? data.file : pageFile;
        setHash(data.hash ?? "");
        setPageFile(target);
        if (!pages.includes(target)) {
          store.log("info", `Предпросмотр: страницы «${target}» нет в проекте`);
        }
      } else if (data.__plx === "external") {
        store.log("info", `Внешняя ссылка: ${data.href}`);
      } else if (data.__plx === "error") {
        const name = data.id ? store.doc.nodes[data.id]?.name ?? data.id : "предпросмотр";
        store.log("err", `Ошибка у «${name}»: ${data.message}`, data.id ?? undefined);
      } else if (data.__plx === "note") {
        store.log("info", `Предпросмотр: ${data.message}`, data.id ?? undefined);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [pageFile, pages]);

  return (
    <div className="preview-view">
      <div className="preview-toolbar">
        <span className="preview-label">Предпросмотр · живой</span>
        <select
          value={pageFile}
          onChange={(e) => {
            setHash("");
            setPageFile(e.target.value);
          }}
        >
          {pages.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <span className="preview-hint">
          ссылки и якоря работают · формы требуют бэкенд (node server/server.js)
        </span>
      </div>
      {blobUrl && (
        <iframe
          className="preview-frame"
          title="Предпросмотр сайта"
          // allow-same-origin нужен, чтобы blob-документ мог читать свой DOM
          sandbox="allow-scripts allow-same-origin"
          src={blobUrl}
        />
      )}
    </div>
  );
}

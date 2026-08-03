/**
 * Поиск бесплатных картинок (Openverse — CC-лицензии, ключ не нужен).
 * Клик по результату: если выделена картинка — заменяет её src,
 * иначе вставляет новую картинку в текущий контейнер.
 */
import { useState } from "react";
import { getInsertTarget, useStore } from "../core/store";

interface FoundImage {
  id: string;
  title: string;
  thumb: string;
  url: string;
}

export function ImagesPanel() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoundImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async (): Promise<void> => {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=12`,
        { headers: { Accept: "application/json" } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        results: Array<{ id: string; title: string | null; thumbnail: string | null; url: string }>;
      };
      setResults(
        json.results
          .filter((r) => r.thumbnail || r.url)
          .map((r) => ({
            id: r.id,
            title: r.title ?? "Без названия",
            thumb: r.thumbnail ?? r.url,
            url: r.url,
          })),
      );
      if (json.results.length === 0) setError("Ничего не найдено");
    } catch (e) {
      setError(`Поиск недоступен: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const insert = (img: FoundImage): void => {
    const s = useStore.getState();
    const sel = s.selection.length === 1 ? s.doc.nodes[s.selection[0]] : null;
    if (sel && sel.type === "image") {
      s.setSrc(sel.id, img.url);
      return;
    }
    const target = getInsertTarget();
    if (!target) {
      s.log("err", "Нет страницы — сначала создай фрейм");
      return;
    }
    s.addNode("image", target, undefined, { name: img.title.slice(0, 28), src: img.url });
  };

  return (
    <div className="images-panel">
      <div className="images-search">
        <input
          value={query}
          placeholder="горы, кофе, офис…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void search();
          }}
        />
        <button className="mini-btn" disabled={busy} onClick={() => void search()}>
          {busy ? "…" : "Найти"}
        </button>
      </div>
      {error && <div className="side-note">{error}</div>}
      {results.length > 0 && (
        <>
          <div className="images-grid">
            {results.map((img) => (
              <button
                key={img.id}
                className="images-item"
                title={`${img.title} — кликни, чтобы вставить`}
                onClick={() => insert(img)}
              >
                <img src={img.thumb} alt={img.title} loading="lazy" />
              </button>
            ))}
          </div>
          <div className="side-note">Openverse · открытые CC-лицензии. Клик — вставить на холст.</div>
        </>
      )}
    </div>
  );
}

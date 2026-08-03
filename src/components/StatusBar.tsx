/** Статусбар: хлебные крошки выделения, зум, статус сохранения, среда. */
import { useStore } from "../core/store";
import { parentChain } from "../core/scene";
import { isTauri } from "../tauri/api";

export function StatusBar({ zoom }: { zoom: number }) {
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const savedAt = useStore((s) => s.savedAt);

  const crumbs =
    selection.length === 1 && doc.nodes[selection[0]]
      ? parentChain(doc, selection[0]).map((n) => n.name).join(" › ")
      : selection.length > 1
        ? `Выбрано: ${selection.length}`
        : "—";

  return (
    <footer className="statusbar">
      <span className="sb-crumbs" title={crumbs}>{crumbs}</span>
      <span className="sb-right">
        {savedAt && (
          <span>
            сохранено {new Date(savedAt).toLocaleTimeString("ru-RU", { hour12: false })}
          </span>
        )}
        <span>{Math.round(zoom * 100)}%</span>
        <span className="sb-env">{isTauri() ? "десктоп" : "браузер"}</span>
      </span>
    </footer>
  );
}

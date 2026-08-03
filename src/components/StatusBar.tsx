/** Статусбар: хлебные крошки выделения, брейкпоинт, зум, статус сохранения, среда. */
import { useStore } from "../core/store";
import { useUi } from "../core/uiStore";
import { parentChain } from "../core/scene";
import { isTauri } from "../tauri/api";

export function StatusBar({ zoom }: { zoom: number }) {
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const savedAt = useStore((s) => s.savedAt);
  const activeBreakpoint = useUi((s) => s.activeBreakpoint);
  const setActiveBreakpoint = useUi((s) => s.setActiveBreakpoint);

  const crumbs =
    selection.length === 1 && doc.nodes[selection[0]]
      ? parentChain(doc, selection[0]).map((n) => n.name).join(" › ")
      : selection.length > 1
        ? `Выбрано: ${selection.length}`
        : "—";

  // ширина базового состояния — ширина первой страницы: понятнее абстрактного «База»
  const baseFrame = doc.rootFrames[0] ? doc.nodes[doc.rootFrames[0]] : undefined;
  const baseW = typeof baseFrame?.layout.width === "number" ? baseFrame.layout.width : null;

  return (
    <footer className="statusbar">
      <span className="sb-crumbs" title={crumbs}>{crumbs}</span>
      <span className="sb-right">
        {doc.breakpoints.length > 0 && (
          <span className="sb-bp" role="group" aria-label="Брейкпоинт">
            <button
              className={`sb-bp-btn${activeBreakpoint === null ? " on" : ""}`}
              onClick={() => setActiveBreakpoint(null)}
              title="Базовое состояние: правки применяются ко всем ширинам"
            >
              База{baseW ? ` ${baseW}` : ""}
            </button>
            {doc.breakpoints.map((bp) => (
              <button
                key={bp.id}
                className={`sb-bp-btn${activeBreakpoint === bp.id ? " on" : ""}`}
                onClick={() => setActiveBreakpoint(bp.id)}
                title={`${bp.name}: правки уходят в переопределения при ширине до ${bp.maxWidth}px`}
              >
                {bp.name} {bp.maxWidth}
              </button>
            ))}
          </span>
        )}
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

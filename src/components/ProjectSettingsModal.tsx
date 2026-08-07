/**
 * Окно «Настройки проекта»: имя + стиль сайта (дизайн-токены).
 * Открывается из меню «Настройки» → «Настройки проекта…» и «Вид» → «Стиль сайта…».
 * Изменения применяются сразу (и попадают в undo/redo через setTheme).
 *
 * Окно прижато к ПРАВОМУ краю, а не по центру: слева остаётся виден холст,
 * и живой предпросмотр палитр действительно видно — иначе «наведите, чтобы
 * посмотреть» было бы обещанием того, что закрыто самим окном.
 */
import { useEffect } from "react";
import { useStore } from "../core/store";
import { useUi } from "../core/uiStore";
import { ThemePanel } from "./ThemePanel";

export function ProjectSettingsModal({ onClose }: { onClose: () => void }) {
  const projectName = useStore((s) => s.projectName);
  const projectPath = useStore((s) => s.projectPath);
  const renameProject = useStore((s) => s.renameProject);
  const setPreview = useUi((s) => s.setThemePreview);

  /* Закрытие всегда гасит предпросмотр: иначе клик по подложке в момент
     наведения на палитру оставлял холст в «чужой» теме без применения. */
  const close = (): void => {
    setPreview(null);
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-backdrop modal-side" onPointerDown={close}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-title">
          Настройки проекта
          <button type="button" className="modal-close" title="Закрыть (Esc)" onClick={close}>
            ×
          </button>
        </div>

        <div className="field">
          <label>Название проекта</label>
          <input
            type="text"
            defaultValue={projectName}
            onBlur={(e) => renameProject(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        </div>
        <div className="project-path" style={{ padding: "0 0 10px" }}>
          {projectPath ?? "проект ещё не сохранён на диск (Ctrl+S)"}
        </div>

        <div className="settings-sep" />
        <div className="settings-subtitle">Стиль сайта</div>
        <div className="side-note" style={{ paddingLeft: 0 }}>
          Токены применяются к сайту и его коду. Интерфейс Plexus не меняется.
        </div>
        <ThemePanel />

        <div className="modal-actions">
          <button className="btn btn-accent" onClick={close}>
            Готово
          </button>
        </div>
      </div>
    </div>
  );
}

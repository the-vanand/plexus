/**
 * Окно «Настройки проекта»: имя + стиль сайта (дизайн-токены).
 * Открывается из меню «Настройки» → «Настройки проекта…» и «Вид» → «Стиль сайта…».
 * Изменения применяются сразу (и попадают в undo/redo через setTheme).
 */
import { useStore } from "../core/store";
import { ThemePanel } from "./ThemePanel";

export function ProjectSettingsModal({ onClose }: { onClose: () => void }) {
  const projectName = useStore((s) => s.projectName);
  const projectPath = useStore((s) => s.projectPath);
  const renameProject = useStore((s) => s.renameProject);

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Настройки проекта</div>

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
          <button className="btn btn-accent" onClick={onClose}>
            Готово
          </button>
        </div>
      </div>
    </div>
  );
}

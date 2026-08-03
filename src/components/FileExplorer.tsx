/**
 * Левая панель: Проект (открыть/создать) · Страницы (как в Figma) ·
 * файлы проекта (модель + генерируемый сайт) · реальная папка на диске.
 */
import { useState } from "react";
import { useStore } from "../core/store";
import { DiskTree } from "./DiskTree";
import { ImagesPanel } from "./ImagesPanel";

export function FileExplorer() {
  const doc = useStore((s) => s.doc);
  const rev = useStore((s) => s.rev);
  const selection = useStore((s) => s.selection);
  const activeTab = useStore((s) => s.activeTab);
  const projectName = useStore((s) => s.projectName);
  const projectPath = useStore((s) => s.projectPath);

  const { openTab, requestFocus, select, addPage, removeNodes, rename } = useStore.getState();

  const [editingId, setEditingId] = useState<string | null>(null);

  const projectFiles = useStore.getState().getProjectFiles();
  // rev в зависимостях: список файлов и страниц обновляется при правках
  void rev;

  const openPage = (id: string): void => {
    select([id]);
    requestFocus(id);
  };

  return (
    <aside className="sidebar">
      {/* --- Проект --- */}
      <div className="side-section">
        <div className="side-title">Проект</div>
        <div className="project-row">
          <div className="project-name" title={projectPath ?? "локально"}>
            {projectName}
          </div>
        </div>
        <div className="project-path">{projectPath ?? "не сохранён на диск"}</div>
        <div className="side-note" style={{ paddingTop: 0 }}>
          Создание и открытие — в меню «Файл».
        </div>
      </div>

      {/* --- Страницы (Figma-подобно) --- */}
      <div className="side-section">
        <div className="side-title">
          Страницы
          <button className="side-refresh" onClick={() => addPage()} title="Добавить страницу">
            +
          </button>
        </div>
        {doc.rootFrames.map((id) => {
          const frame = doc.nodes[id];
          if (!frame) return null;
          const isSel = selection.includes(id);
          return (
            <div key={id} className={`tree-item page${isSel ? " active" : ""}`}>
              {editingId === id ? (
                <input
                  className="rename-input"
                  autoFocus
                  defaultValue={frame.name}
                  onBlur={(e) => {
                    rename(id, e.target.value.trim());
                    setEditingId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                />
              ) : (
                <>
                  <span className="tree-icon">▢</span>
                  <button
                    className="tree-label as-btn"
                    onClick={() => openPage(id)}
                    onDoubleClick={() => setEditingId(id)}
                    title="Клик — перейти, двойной клик — переименовать"
                  >
                    {frame.name}
                  </button>
                  {doc.rootFrames.length > 1 && (
                    <button
                      className="row-x"
                      title="Удалить страницу"
                      onClick={() => removeNodes([id])}
                    >
                      ×
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* --- Файлы проекта --- */}
      <div className="side-section">
        <div className="side-title">Файлы</div>
        {projectFiles.map((path) => (
          <button
            key={path}
            className={`tree-item${activeTab === path ? " active" : ""}`}
            onClick={() => openTab(path)}
          >
            <span className="tree-icon">{path.endsWith(".json") ? "{}" : path.endsWith(".css") ? "#" : "<>"}</span>
            <span className="tree-label">{path.replace(/^site\//, "")}</span>
          </button>
        ))}
      </div>

      {/* --- Картинки (поиск бесплатных) --- */}
      <div className="side-section">
        <div className="side-title">Картинки</div>
        <ImagesPanel />
      </div>

      {/* --- Диск: настоящее дерево с раскрытием папок --- */}
      <div className="side-section">
        <div className="side-title">Диск</div>
        <DiskTree />
      </div>
    </aside>
  );
}

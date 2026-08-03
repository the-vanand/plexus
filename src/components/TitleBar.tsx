/** Верхняя панель: логотип, меню (Файл/Правка/…), имя проекта, «глазик», экспорт, профиль. */
import { useState } from "react";
import { useStore } from "../core/store";
import { MenuBar } from "./MenuBar";
import { ProjectModal } from "./ProjectModal";
import { ProjectSettingsModal } from "./ProjectSettingsModal";
import { UrlImportModal } from "./UrlImportModal";

/** Мини-версия иконки Plexus: графитовая плитка + наклонённый портал. */
function LogoMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 64 64" aria-hidden="true">
      <rect x="2" y="2" width="60" height="60" rx="15" fill="#1d2226" />
      <ellipse
        cx="32"
        cy="31"
        rx="15"
        ry="23"
        transform="rotate(43 32 31)"
        fill="none"
        stroke="#a9c9ea"
        strokeWidth="5.5"
      />
    </svg>
  );
}

export function TitleBar() {
  const exportSite = useStore((s) => s.exportSite);
  const projectName = useStore((s) => s.projectName);
  const eyeMode = useStore((s) => s.eyeMode);
  const toggleEye = useStore((s) => s.toggleEye);
  const [modal, setModal] = useState<null | "new" | "open" | "settings" | "importurl">(null);

  return (
    <header className="titlebar">
      <div className="tb-brand">
        <LogoMark />
        <span className="tb-name">Plexus</span>
        <MenuBar
          onNewProject={() => setModal("new")}
          onOpenProject={() => setModal("open")}
          onProjectSettings={() => setModal("settings")}
          onImportUrl={() => setModal("importurl")}
        />
        <span className="tb-project">{projectName}</span>
      </div>

      <div className="tb-actions">
        <button
          className={`btn eye${eyeMode ? " on" : ""}`}
          onClick={toggleEye}
          title="Показать провода связей (режим «глазик»)"
        >
          👁 Провода
        </button>
        <button className="btn btn-accent" onClick={() => void exportSite()}>
          Экспорт кода
        </button>
        {/* Заготовка авторизации: профиль в правом верхнем углу (см. план, Блок 8) */}
        <button className="profile-chip" title="Профиль — скоро: аккаунт и синхронизация">
          P
        </button>
      </div>

      {(modal === "new" || modal === "open") && (
        <ProjectModal mode={modal} onClose={() => setModal(null)} />
      )}
      {modal === "settings" && <ProjectSettingsModal onClose={() => setModal(null)} />}
      {modal === "importurl" && <UrlImportModal onClose={() => setModal(null)} />}
    </header>
  );
}

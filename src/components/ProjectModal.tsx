/**
 * Окно «Новый / Открыть проект».
 *
 * Выбор папки — нативным диалогом ОС (как в Проводнике Windows): кнопка
 * «Выбрать папку…» открывает системное окно; выбранный путь показывается
 * рядом. Внутренний обзор папок убран (он путал). В веб-режиме — поле пути.
 */
import { useState } from "react";
import { useStore } from "../core/store";
import { PRESETS, PRESET_IDS, type PresetId } from "../core/themes";
import * as host from "../tauri/api";

interface Props {
  mode: "new" | "open";
  onClose: () => void;
}

const SITE_TYPES = [
  { id: "single", label: "Одностраничник" },
  { id: "multi", label: "Многостраничный" },
  { id: "db", label: "С базой данных (Next.js + Prisma)" },
] as const;

export function ProjectModal({ mode, onClose }: Props) {
  const { newProject, openProject, log } = useStore.getState();
  const tauri = host.isTauri();

  const [name, setName] = useState("plexus-site");
  const [siteType, setSiteType] = useState<(typeof SITE_TYPES)[number]["id"]>("single");
  const [preset, setPreset] = useState<PresetId>("minimal");
  const [accent, setAccent] = useState("#aa816a");
  const [folder, setFolder] = useState<string>(""); // new: родитель; open: папка проекта
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);

  const chooseFolder = async (): Promise<void> => {
    const picked = await host.pickFolder();
    if (picked) setFolder(picked);
  };

  const submit = async (): Promise<void> => {
    const dir = folder || manual;
    setBusy(true);
    try {
      if (mode === "new") {
        await newProject({
          parentDir: dir || undefined,
          name,
          theme: { preset, accent },
          secondPage: siteType !== "single",
          siteTarget: siteType === "db" ? "next" : "static",
        });
        if (siteType === "db") log("ok", "Шаблон с БД: вкладка «База данных» → таблицы; экспорт даст Next.js + Prisma");
      } else {
        if (!dir) return;
        await openProject(dir);
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = mode === "new" ? tauri ? !!folder : true : !!(folder || manual);

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-title">{mode === "new" ? "Новый проект" : "Открыть проект"}</div>

        {mode === "new" && (
          <>
            <div className="field">
              <label>Название проекта</label>
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </div>
            <div className="row2">
              <div className="field">
                <label>Тип сайта</label>
                <select value={siteType} onChange={(e) => setSiteType(e.target.value as typeof siteType)}>
                  {SITE_TYPES.map((t) => (
                    <option key={t.id} value={t.id}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Стиль</label>
                <select value={preset} onChange={(e) => setPreset(e.target.value as PresetId)}>
                  {PRESET_IDS.map((id) => (
                    <option key={id} value={id}>{PRESETS[id].label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field">
              <label>Акцентный цвет</label>
              <div className="color-control">
                <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} />
                <span className="color-hex">{accent}</span>
              </div>
            </div>
          </>
        )}

        {/* --- выбор папки --- */}
        {tauri ? (
          <div className="field">
            <label>{mode === "new" ? "Где создать (папка)" : "Папка проекта (с plexus.json)"}</label>
            <div className="folder-pick">
              <button className="btn" onClick={() => void chooseFolder()}>
                📁 Выбрать папку…
              </button>
              <span className="folder-path" title={folder}>
                {folder || "папка не выбрана"}
              </span>
            </div>
            {mode === "new" && folder && (
              <div className="side-note" style={{ paddingLeft: 0 }}>
                Проект появится в: <code>{folder}/{name}</code>
              </div>
            )}
          </div>
        ) : (
          <div className="field">
            <label>{mode === "open" ? "Путь к папке проекта" : "Папка (необязательно в вебе)"}</label>
            <input
              value={manual}
              placeholder={mode === "open" ? "путь к папке проекта" : "оставь пустым — хранить в браузере"}
              onChange={(e) => setManual(e.target.value)}
            />
            {mode === "open" && (
              <div className="side-note" style={{ paddingLeft: 0 }}>
                Полноценное открытие с диска — в десктоп-версии.
              </div>
            )}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Отмена</button>
          <button className="btn btn-accent" disabled={busy || !canSubmit} onClick={() => void submit()}>
            {busy ? "…" : mode === "new" ? "Создать" : "Открыть"}
          </button>
        </div>
      </div>
    </div>
  );
}

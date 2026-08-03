/**
 * Верхнее меню приложения (Файл / Правка / Вставка / Вид / Настройки / Справка).
 * Классическое поведение IDE: клик открывает, наведение переключает открытые
 * меню, клик по пункту выполняет и закрывает, Esc/клик-мимо закрывает.
 */
import { useEffect, useRef, useState } from "react";
import { getInsertTarget, useStore } from "../core/store";
import { useUi } from "../core/uiStore";
import { INSERT_PRESETS } from "../core/scene";
import { BLOCK_CATEGORIES, blocksOf } from "../core/blocks";

type Item = { label: string; hint?: string; danger?: boolean; action: () => void } | "sep";

interface Props {
  onNewProject: () => void;
  onOpenProject: () => void;
  onProjectSettings: () => void;
  onImportUrl: () => void;
}

export function MenuBar({ onNewProject, onOpenProject, onProjectSettings, onImportUrl }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const ui = useUi();
  const eyeMode = useStore((s) => s.eyeMode);
  const components = useStore((s) => s.doc.components);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const store = useStore.getState;

  const menus: Record<string, Item[]> = {
    "Файл": [
      { label: "Новый проект…", action: onNewProject },
      { label: "Открыть проект…", action: onOpenProject },
      // обе ветки импорта ведут в одну модалку: там выбирается ширина
      // вьюпорта, без которой размер исходной страницы не восстановить
      { label: "Импорт HTML-сайта…", action: onImportUrl },
      { label: "Импорт сайта по ссылке…", action: onImportUrl },
      "sep",
      { label: "Сохранить", hint: "Ctrl+S", action: () => void store().saveProject() },
      { label: "Экспорт кода", action: () => void store().exportSite() },
    ],
    "Правка": [
      { label: "Проверить страницу", action: () => store().validateDocument() },
      "sep",
      { label: "Отменить", hint: "Ctrl+Z", action: () => store().undo() },
      { label: "Повторить", hint: "Ctrl+Shift+Z", action: () => store().redo() },
      "sep",
      { label: "Дублировать", hint: "Ctrl+D", action: () => store().duplicateNodes(store().selection) },
      {
        label: "Создать компонент из выделения",
        action: () => {
          const sel = store().selection[0];
          if (sel) store().createComponent(sel);
          else store().log("err", "Сначала выдели элемент");
        },
      },
      {
        label: "Удалить",
        hint: "Del",
        danger: true,
        action: () => store().removeNodes(store().selection),
      },
    ],
    "Вставка": [
      // блоки каталога — по категориям, чтобы список не превращался в простыню
      ...BLOCK_CATEGORIES.flatMap((cat): Item[] => [
        { label: `— ${cat.label}`, action: () => {} },
        ...blocksOf(cat.id).map((b): Item => ({
          label: `   ${b.glyph}  ${b.label}`,
          action: () => store().insertBlock(b.type),
        })),
      ]),
      "sep",
      ...INSERT_PRESETS.map((preset): Item => ({
        label: preset.label,
        action: () => {
          const target = getInsertTarget();
          if (target) store().addNode(preset.type, target, undefined, preset.init);
          else store().log("err", "Нет страницы — сначала создай фрейм");
        },
      })),
      "sep",
      ...Object.entries(components).map(([cid, comp]): Item => ({
        label: `⟐ ${comp.name}`,
        hint: "компонент",
        action: () => {
          const target = getInsertTarget();
          if (target) store().addInstance(cid, target);
        },
      })),
      ...(Object.keys(components).length > 0 ? ["sep" as const] : []),
      { label: "Новая страница", action: () => store().addPage() },
    ],
    "Вид": [
      { label: `${ui.leftOpen ? "✓ " : ""}Левая панель`, action: ui.toggleLeft },
      { label: `${ui.bottomOpen ? "✓ " : ""}Нижняя панель`, action: ui.toggleBottom },
      { label: `${ui.rightOpen ? "✓ " : ""}Правая панель`, action: ui.toggleRight },
      "sep",
      { label: `${ui.gridShow ? "✓ " : ""}Сетка точек`, action: ui.toggleGrid },
      { label: `${ui.gridSnap ? "✓ " : ""}Привязка к сетке`, action: ui.toggleGridSnap },
      "sep",
      { label: "Стиль сайта…", action: onProjectSettings },
      { label: `${eyeMode ? "✓ " : ""}Провода (глазик)`, action: () => store().toggleEye() },
    ],
    "Настройки": [
      { label: "Настройки проекта…", action: onProjectSettings },
      { label: "Сбросить раскладку панелей", action: ui.resetLayout },
      "sep",
      { label: "Тема IDE: Графит (светлая — скоро)", action: () => store().log("info", "Светлая тема IDE — в дорожной карте") },
      { label: "Автосохранение — скоро", action: () => store().log("info", "Автосохранение — в дорожной карте") },
    ],
    "Справка": [
      { label: "Горячие клавиши — см. README", action: () => store().log("info", "Горячие клавиши перечислены в README.md") },
      { label: "О Plexus", action: () => store().log("info", "Plexus v0.2 — визуальная full-stack IDE. Холст, логика и база данных в одной системе.") },
    ],
  };

  const run = (item: Exclude<Item, "sep">): void => {
    item.action();
    setOpen(null);
  };

  return (
    <nav className="menubar" ref={ref}>
      {Object.keys(menus).map((name) => (
        <div key={name} className="menu-wrap">
          <button
            className={`menu-root${open === name ? " open" : ""}`}
            onClick={() => setOpen(open === name ? null : name)}
            onPointerEnter={() => {
              if (open && open !== name) setOpen(name);
            }}
          >
            {name}
          </button>
          {open === name && (
            <div className="ctx-menu menu-pop">
              {menus[name].map((item, i) =>
                item === "sep" ? (
                  <div key={i} className="ctx-sep" />
                ) : (
                  <button
                    key={i}
                    className={`ctx-item${item.danger ? " danger" : ""}`}
                    onClick={() => run(item)}
                  >
                    <span>{item.label}</span>
                    {item.hint && <span className="ctx-hint">{item.hint}</span>}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}

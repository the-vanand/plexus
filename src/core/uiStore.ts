/**
 * Состояние раскладки интерфейса: размеры и видимость панелей («шторки»).
 * Хранится отдельно от документа и переживает перезапуск (localStorage).
 */
import { create } from "zustand";

interface UiState {
  leftW: number;
  rightW: number;
  bottomH: number;
  leftOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
  /** Сетка точек на холсте и привязка перетаскивания к ней. */
  gridShow: boolean;
  gridSnap: boolean;
  /**
   * Ширина вьюпорта, под которую разбирается импортируемый сайт.
   * Она же становится шириной страницы на холсте: раньше ширина была
   * зашита в 1200px и размер исходной страницы просто игнорировался.
   */
  importWidth: number;
  /** Режим левой панели: проект или каталог инструментов. */
  leftTab: "project" | "tools";
  /**
   * АКТИВНЫЙ БРЕЙКПОИНТ РЕДАКТИРОВАНИЯ (null — базовое состояние).
   *
   * Живёт в состоянии интерфейса, а не в документе: это режим работы
   * пользователя, а не свойство страницы. И НЕ переживает перезапуск
   * специально — режим, в котором правки молча уходят в переопределения,
   * не должен восстанавливаться сам, иначе следующая правка «не там».
   */
  activeBreakpoint: string | null;
  /**
   * ЖИВОЙ ПРЕДПРОСМОТР ТЕМЫ (наведение на палитру/пресет).
   * Живёт в интерфейсе, а не в документе: наведение — не правка, оно не
   * должно попадать ни в файл проекта, ни в undo. Холст рисует документ
   * с этой темой, пока поле не null.
   */
  themePreview: import("./themes").ThemeSpec | null;

  setLeftW: (w: number) => void;
  setRightW: (w: number) => void;
  setBottomH: (h: number) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  toggleBottom: () => void;
  toggleGrid: () => void;
  toggleGridSnap: () => void;
  setImportWidth: (w: number) => void;
  setLeftTab: (t: "project" | "tools") => void;
  setActiveBreakpoint: (id: string | null) => void;
  setThemePreview: (t: import("./themes").ThemeSpec | null) => void;
  resetLayout: () => void;
}

const LS_KEY = "plexus:ui";
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

const defaults = {
  leftW: 232,
  rightW: 268,
  bottomH: 180,
  leftOpen: true,
  rightOpen: true,
  bottomOpen: true,
  gridShow: true,
  gridSnap: false,
  importWidth: 1440,
  leftTab: "project" as "project" | "tools",
};

function load(): typeof defaults {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch {
    /* игнор */
  }
  return defaults;
}

export const useUi = create<UiState>()((set, get) => {
  const persist = (): void => {
    const { leftW, rightW, bottomH, leftOpen, rightOpen, bottomOpen, gridShow, gridSnap, importWidth, leftTab } = get();
    try {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({ leftW, rightW, bottomH, leftOpen, rightOpen, bottomOpen, gridShow, gridSnap, importWidth, leftTab }),
      );
    } catch {
      /* игнор */
    }
  };
  const after = <T,>(patch: T): T => {
    queueMicrotask(persist);
    return patch;
  };

  return {
    ...load(),
    activeBreakpoint: null,
    themePreview: null,
    setLeftW: (w) => set(after({ leftW: clamp(w, 160, 480) })),
    setRightW: (w) => set(after({ rightW: clamp(w, 200, 520) })),
    setBottomH: (h) => set(after({ bottomH: clamp(h, 100, 520) })),
    toggleLeft: () => set(after({ leftOpen: !get().leftOpen })),
    toggleRight: () => set(after({ rightOpen: !get().rightOpen })),
    toggleBottom: () => set(after({ bottomOpen: !get().bottomOpen })),
    toggleGrid: () => set(after({ gridShow: !get().gridShow })),
    toggleGridSnap: () => set(after({ gridSnap: !get().gridSnap })),
    setImportWidth: (w) => set(after({ importWidth: clamp(Math.round(w), 320, 2560) })),
    setLeftTab: (leftTab) => set(after({ leftTab })),
    // без after(): активный брейкпоинт намеренно не сохраняется в localStorage
    setActiveBreakpoint: (activeBreakpoint) => set({ activeBreakpoint }),
    // без after(): предпросмотр темы — мимолётное состояние наведения
    setThemePreview: (themePreview) => set({ themePreview }),
    resetLayout: () => set(after({ ...defaults, activeBreakpoint: null, themePreview: null })),
  };
});

/**
 * Мост фронтенда к Rust-командам Tauri.
 *
 * Каждая функция имеет браузерный фоллбэк, чтобы `npm run dev` работал
 * без Rust: файлы уходят в localStorage, терминал вежливо отказывается.
 */
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface CmdOutput {
  code: number;
  stdout: string;
  stderr: string;
}

/** Мы внутри Tauri-окна? (в браузере — false) */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const LS_PROJECT_KEY = "plexus:project";

/** Активный корень проекта (выбранная папка). Живёт на стороне фронтенда. */
let activeRoot: string | null = null;
export const getActiveRoot = (): string | null => activeRoot;
export const setActiveRoot = (root: string | null): void => {
  activeRoot = root;
};

/* ---------------- файловая система ---------------- */

export async function projectRoot(): Promise<string | null> {
  if (activeRoot) return activeRoot;
  if (!isTauri()) return null;
  try {
    const root = await invoke<string>("project_root");
    activeRoot = root;
    return root;
  } catch {
    return null;
  }
}

/** Домашняя папка пользователя — стартовая точка обзора при выборе папки. */
export async function homeDir(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string>("home_dir");
  } catch {
    return null;
  }
}

export async function listDir(path: string): Promise<FsEntry[]> {
  if (!isTauri()) return [];
  return invoke<FsEntry[]>("list_dir", { path });
}

export async function readTextFile(path: string): Promise<string> {
  if (!isTauri()) throw new Error("Файловая система доступна в десктоп-версии");
  return invoke<string>("read_text_file", { path });
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  if (!isTauri()) throw new Error("Файловая система доступна в десктоп-версии");
  return invoke("write_text_file", { path, contents });
}

/* ---------------- проект (plexus.json) ---------------- */

export async function saveProjectFile(json: string): Promise<boolean> {
  if (isTauri()) {
    const root = await projectRoot();
    if (root) {
      await writeTextFile(`${root}/plexus.json`, json);
      return true;
    }
  }
  localStorage.setItem(LS_PROJECT_KEY, json);
  return false;
}

export async function loadProjectFile(): Promise<string | null> {
  if (isTauri()) {
    const root = await projectRoot();
    if (root) {
      try {
        return await readTextFile(`${root}/plexus.json`);
      } catch {
        return null; // файла ещё нет — это нормально
      }
    }
  }
  return localStorage.getItem(LS_PROJECT_KEY);
}

/** Экспорт сгенерированного сайта (набор файлов). true — записано на диск. */
export async function writeSiteFiles(files: Record<string, string>): Promise<boolean> {
  if (!isTauri()) return false;
  const root = await projectRoot();
  if (!root) return false;
  for (const [rel, content] of Object.entries(files)) {
    await writeTextFile(`${root}/${rel}`, content);
  }
  return true;
}

/* ---------------- нативные диалоги и ассеты ---------------- */

/** Нативный выбор папки (плагин dialog). null — отмена или веб-режим. */
export async function pickFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true, multiple: false });
    return typeof dir === "string" ? dir : null;
  } catch {
    return null;
  }
}

/** Нативный выбор файла-картинки. */
export async function pickImageFile(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const file = await open({
      multiple: false,
      filters: [{ name: "Картинки", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
    });
    return typeof file === "string" ? file : null;
  } catch {
    return null;
  }
}

/** Копировать файл пользователя в site/assets проекта → относительный путь. */
export async function copyIntoAssets(src: string): Promise<string | null> {
  const root = await projectRoot();
  if (!root) return null;
  return invoke<string>("copy_into_assets", { src, projectRoot: root });
}

/** То же, но путь источника абсолютный (импорт сайтов). */
export const copyIntoAssetsFrom = copyIntoAssets;

/** Скачать текст по URL (импорт сайта по ссылке; обходит CORS через Rust). */
export async function fetchUrl(url: string): Promise<string> {
  if (!isTauri()) {
    // веб-режим: пробуем обычный fetch (сработает при разрешающем CORS)
    const res = await fetch(url);
    return res.text();
  }
  return invoke<string>("fetch_url", { url });
}

/**
 * СНИМОК ЖИВОЙ СТРАНИЦЫ.
 *
 * Десктоп: скрытое окно webview, страница собирается по-настоящему.
 * Браузер: same-origin iframe — сработает только для локальных файлов и
 * сайтов без X-Frame-Options, поэтому режим честно сообщает об отказе.
 */
export async function captureSnapshot(opts: {
  url: string;
  collector: string;
  width?: number;
  height?: number;
  timeoutMs?: number;
}): Promise<unknown> {
  const width = opts.width ?? 1440;
  const height = opts.height ?? 900;
  const timeoutMs = opts.timeoutMs ?? 45000;

  if (isTauri()) {
    const raw = await invoke<string>("capture_snapshot", {
      url: opts.url,
      collector: opts.collector,
      width,
      height,
      timeoutMs,
    });
    const parsed = JSON.parse(raw) as { error?: string };
    if (parsed && typeof parsed === "object" && parsed.error) throw new Error(parsed.error);
    return parsed;
  }

  /* веб-режим: iframe. Чужой домен не отдаст содержимое из-за политики
     одного источника — это ограничение браузера, а не приложения. */
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.style.cssText = `position:fixed;left:-99999px;top:0;width:${width}px;height:${height}px;border:0`;
    frame.src = opts.url;
    const timer = window.setTimeout(() => {
      frame.remove();
      reject(new Error("страница не собралась за отведённое время"));
    }, timeoutMs);

    frame.onload = () => {
      try {
        const win = frame.contentWindow as (Window & { eval?: (s: string) => unknown }) | null;
        if (!win) throw new Error("нет доступа к окну");
        void Promise.resolve(win.eval!(opts.collector))
          .then((snap) => {
            window.clearTimeout(timer);
            frame.remove();
            resolve(snap);
          })
          .catch((e: unknown) => {
            window.clearTimeout(timer);
            frame.remove();
            reject(e instanceof Error ? e : new Error(String(e)));
          });
      } catch {
        window.clearTimeout(timer);
        frame.remove();
        reject(
          new Error(
            "браузер не даёт читать чужую страницу (политика одного источника). " +
              "Снимок доступен в десктоп-версии",
          ),
        );
      }
    };
    document.body.appendChild(frame);
  });
}

/** Нативный выбор HTML-файла (импорт сайта). */
export async function pickHtmlFile(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const file = await open({
      multiple: false,
      filters: [{ name: "HTML", extensions: ["html", "htm"] }],
    });
    return typeof file === "string" ? file : null;
  } catch {
    return null;
  }
}

/** Относительный "assets/…" или абсолютный путь → URL для webview. */
export function resolveAssetUrl(src: string): string {
  if (!isTauri()) return src;
  if (src.startsWith("assets/")) {
    const root = getActiveRoot();
    if (root) return convertFileSrc(`${root}/site/${src}`);
    return src;
  }
  // абсолютный путь с диска (например, сразу после импорта до копирования)
  if (/^[a-zA-Z]:[\\/]/.test(src) || src.startsWith("/")) {
    return convertFileSrc(src);
  }
  return src;
}

/* ---------------- терминал ---------------- */

export async function runCommand(command: string, cwd?: string): Promise<CmdOutput> {
  if (!isTauri()) {
    return {
      code: -1,
      stdout: "",
      stderr: "Терминал доступен в десктоп-версии (npm run tauri dev).",
    };
  }
  return invoke<CmdOutput>("run_command", { command, cwd: cwd ?? null });
}

/* --- стриминговый запуск (живой вывод построчно) --- */

export interface TermChunk {
  id: number;
  kind: "out" | "err" | "exit";
  line: string;
}

export async function startCommand(command: string, cwd?: string): Promise<number> {
  return invoke<number>("start_command", { command, cwd: cwd ?? null });
}

export async function killCommand(id: number): Promise<void> {
  return invoke("kill_command", { id });
}

/** Подписка на вывод стриминговых команд. Возвращает функцию отписки. */
export async function onTermChunk(cb: (chunk: TermChunk) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<TermChunk>("plx://term", (e) => cb(e.payload));
  return unlisten;
}

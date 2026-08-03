/**
 * Дерево файловой системы: папки раскрываются стрелочками (ленивая загрузка
 * через Rust list_dir), текстовые файлы открываются read-only вкладками.
 */
import { useEffect, useState } from "react";
import { useStore } from "../core/store";
import * as host from "../tauri/api";

/** Расширения, которые открываем как текст. */
const TEXT_EXTS = new Set([
  "html", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "jsonl",
  "md", "txt", "rs", "toml", "yml", "yaml", "svg", "gitignore", "lock", "env",
]);

const extOf = (name: string): string => name.split(".").pop()?.toLowerCase() ?? "";

function iconFor(entry: host.FsEntry, open: boolean): string {
  if (entry.is_dir) return open ? "▾" : "▸";
  const ext = extOf(entry.name);
  if (ext === "json" || ext === "jsonl") return "{}";
  if (ext === "css") return "#";
  if (["js", "ts", "tsx", "jsx", "mjs", "cjs"].includes(ext)) return "()";
  if (ext === "html") return "<>";
  if (ext === "rs") return "🦀";
  return "·";
}

function TreeNode({ entry, depth }: { entry: host.FsEntry; depth: number }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<host.FsEntry[] | null>(null);
  const { openFsFile, log } = useStore.getState();

  const toggle = async (): Promise<void> => {
    if (!entry.is_dir) {
      if (TEXT_EXTS.has(extOf(entry.name))) await openFsFile(entry.path);
      else log("info", `«${entry.name}» — бинарный или неподдерживаемый формат`);
      return;
    }
    if (open) {
      setOpen(false);
      return;
    }
    try {
      setChildren(await host.listDir(entry.path));
      setOpen(true);
    } catch {
      log("err", `Не удалось открыть папку: ${entry.name}`);
    }
  };

  return (
    <>
      <button
        className="tree-item"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => void toggle()}
        title={entry.path}
      >
        <span className="tree-icon">{iconFor(entry, open)}</span>
        <span className="tree-label">{entry.name}</span>
      </button>
      {open &&
        children?.map((child) => <TreeNode key={child.path} entry={child} depth={depth + 1} />)}
    </>
  );
}

export function DiskTree() {
  const projectPath = useStore((s) => s.projectPath);
  const savedAt = useStore((s) => s.savedAt);
  const [roots, setRoots] = useState<host.FsEntry[]>([]);

  const refresh = async (): Promise<void> => {
    const root = await host.projectRoot();
    if (!root) {
      setRoots([]);
      return;
    }
    try {
      setRoots(await host.listDir(root));
    } catch {
      setRoots([]);
    }
  };

  useEffect(() => {
    void refresh();
    // обновляем листинг после сохранений/экспортов
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, savedAt]);

  if (!projectPath) {
    return <div className="side-note">Сохрани или создай проект, чтобы увидеть файлы на диске.</div>;
  }
  if (roots.length === 0) {
    return <div className="side-note">Папка пуста</div>;
  }
  return (
    <>
      {roots.map((entry) => (
        <TreeNode key={entry.path} entry={entry} depth={0} />
      ))}
    </>
  );
}

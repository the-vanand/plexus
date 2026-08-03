/**
 * Просмотр кода (read-only, v0.1).
 * Содержимое живое: пересобирается из модели при каждом изменении документа —
 * поменяй кнопку на холсте и увидишь, как меняется HTML.
 * Полноценный редактор с обратной синхронизацией — флагманская фича roadmap.
 */
import { useStore } from "../core/store";
import * as host from "../tauri/api";

/** Разбор маркеров PLX-SLOT из файла: nodeId → код (two-way Phase 1). */
function parseSlots(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /\/\* PLX-SLOT:([\w-]+) \*\/([\s\S]*?)\/\* \/PLX-SLOT \*\//g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out[m[1]] = m[2].split("\n").map((l) => l.replace(/^ {4,6}/, "")).join("\n").trim();
  }
  return out;
}

export function CodeView({ path }: { path: string }) {
  // подписка на rev: код обновляется вживую при правках на холсте
  useStore((s) => s.rev);
  const content = useStore.getState().getFileContent(path);
  const lines = content.split("\n");

  const canSyncSlots = path === "site/script.js" && host.isTauri();
  const syncSlots = async (): Promise<void> => {
    const s = useStore.getState();
    const root = await host.projectRoot();
    if (!root) {
      s.log("err", "Сначала сохрани и экспортируй проект на диск");
      return;
    }
    try {
      const fileText = await host.readTextFile(`${root}/site/script.js`);
      s.syncSlotsFromCode(parseSlots(fileText));
    } catch {
      s.log("err", "site/script.js не найден на диске — сначала «Экспорт кода»");
    }
  };

  return (
    <div className="code-view">
      <div className="code-head">
        <span>{path}</span>
        <span className="code-note">
          {canSyncSlots && (
            <button className="mini-btn" style={{ marginRight: 10 }} onClick={() => void syncSlots()}>
              ⇄ Слоты ← файл
            </button>
          )}
          только чтение · генерируется из модели
        </span>
      </div>
      <div className="code-body">
        <pre className="code-gutter">{lines.map((_, i) => `${i + 1}\n`).join("")}</pre>
        <pre className="code-text">{content}</pre>
      </div>
    </div>
  );
}

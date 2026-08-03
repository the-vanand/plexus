/**
 * Нижняя панель: Логи · Терминал · Git.
 *
 * Логи: события редактора; ошибки из предпросмотра несут id элемента —
 * кнопка «Показать» выделяет и центрирует его на холсте (маппинг ошибок).
 * Терминал: стриминговый вывод построчно (Rust start_command + события),
 * кнопка «Стоп»; интерактивный ввод (PTY) — в дорожной карте.
 * Git: статус, init, commit, push через системный git (учётки — из
 * Git Credential Manager пользователя).
 */
import { useEffect, useRef, useState } from "react";
import { useStore } from "../core/store";
import * as host from "../tauri/api";
import { GitPanel } from "./GitPanel";

type TermLine = { kind: "cmd" | "out" | "err"; text: string };

export function ConsolePanel() {
  const [tab, setTab] = useState<"logs" | "term" | "git">("logs");
  const logs = useStore((s) => s.logs);

  const [lines, setLines] = useState<TermLine[]>([
    { kind: "out", text: "Терминал Plexus: живой вывод. Команды выполняются в папке проекта." },
  ]);
  const [cmd, setCmd] = useState("");
  const [runningId, setRunningId] = useState<number | null>(null);
  const runningRef = useRef<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  /* один глобальный подписчик на события стриминга */
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void host.onTermChunk((chunk) => {
      if (chunk.id !== runningRef.current) return;
      if (chunk.kind === "exit") {
        setLines((l) => [...l, { kind: "out", text: `— код выхода: ${chunk.line}` }]);
        runningRef.current = null;
        setRunningId(null);
      } else {
        setLines((l) => [...l, { kind: chunk.kind === "err" ? "err" : "out", text: chunk.line }]);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [logs, lines, tab]);

  const run = async (): Promise<void> => {
    const command = cmd.trim();
    if (!command || runningRef.current !== null) return;
    setCmd("");
    setLines((l) => [...l, { kind: "cmd", text: `$ ${command}` }]);

    if (!host.isTauri()) {
      const out = await host.runCommand(command);
      setLines((l) => [...l, { kind: "err", text: out.stderr }]);
      return;
    }
    try {
      const root = await host.projectRoot();
      const id = await host.startCommand(command, root ?? undefined);
      runningRef.current = id;
      setRunningId(id);
    } catch (e) {
      setLines((l) => [...l, { kind: "err", text: String(e) }]);
    }
  };

  const stop = async (): Promise<void> => {
    if (runningRef.current === null) return;
    await host.killCommand(runningRef.current);
    setLines((l) => [...l, { kind: "err", text: "— остановлено" }]);
    runningRef.current = null;
    setRunningId(null);
  };

  const time = (ts: number): string =>
    new Date(ts).toLocaleTimeString("ru-RU", { hour12: false });

  const showNode = (nodeId: string): void => {
    const s = useStore.getState();
    if (!s.doc.nodes[nodeId]) {
      s.log("info", "Элемент уже удалён");
      return;
    }
    s.select([nodeId]);
    s.setActiveTab("canvas");
    s.requestFocus(nodeId);
  };

  return (
    <section className="console">
      <div className="console-tabs">
        <button className={tab === "logs" ? "active" : ""} onClick={() => setTab("logs")}>
          Логи
        </button>
        <button className={tab === "term" ? "active" : ""} onClick={() => setTab("term")}>
          Терминал
        </button>
        <button className={tab === "git" ? "active" : ""} onClick={() => setTab("git")}>
          Git
        </button>
      </div>

      {tab === "git" ? (
        <GitPanel />
      ) : (
        <>
          <div className="console-body" ref={bodyRef}>
            {tab === "logs" ? (
              logs.length === 0 ? (
                <div className="console-line muted">Пока пусто — действия редактора появятся здесь.</div>
              ) : (
                logs.map((l, i) => (
                  <div key={i} className={`console-line ${l.level}`}>
                    <span className="console-ts">{time(l.ts)}</span> {l.msg}
                    {l.nodeId && (
                      <button className="log-show" onClick={() => showNode(l.nodeId!)}>
                        Показать
                      </button>
                    )}
                  </div>
                ))
              )
            ) : (
              lines.map((l, i) => (
                <div key={i} className={`console-line ${l.kind === "err" ? "err" : l.kind === "cmd" ? "cmd" : ""}`}>
                  {l.text}
                </div>
              ))
            )}
          </div>

          {tab === "term" && (
            <div className="console-input">
              <span className="prompt">$</span>
              <input
                type="text"
                value={cmd}
                disabled={runningId !== null}
                placeholder={runningId !== null ? "выполняется… (можно остановить)" : "например: npm run build"}
                onChange={(e) => setCmd(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void run();
                }}
              />
              {runningId !== null && (
                <button className="mini-btn" onClick={() => void stop()}>
                  ■ Стоп
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Git-панель: статус, init, commit, push — через системный git в папке проекта.
 * Аутентификация пуша — учётки пользователя (Git Credential Manager),
 * OAuth-поток внутри приложения — следующая итерация.
 */
import { useEffect, useState } from "react";
import { useStore } from "../core/store";
import * as host from "../tauri/api";

interface GitState {
  isRepo: boolean;
  branch: string;
  changes: number;
  hasRemote: boolean;
}

export function GitPanel() {
  const projectPath = useStore((s) => s.projectPath);
  const [git, setGit] = useState<GitState | null>(null);
  const [message, setMessage] = useState("");
  const [remote, setRemote] = useState("");
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);

  const sh = async (command: string): Promise<host.CmdOutput> => {
    const root = await host.projectRoot();
    return host.runCommand(command, root ?? undefined);
  };

  const refresh = async (): Promise<void> => {
    if (!host.isTauri()) return;
    const status = await sh("git status --porcelain=v1 --branch");
    if (status.code !== 0) {
      setGit({ isRepo: false, branch: "", changes: 0, hasRemote: false });
      return;
    }
    const lines = status.stdout.split("\n").filter(Boolean);
    const head = lines[0] ?? "";
    const branch = head.replace("## ", "").split("...")[0].trim() || "main";
    const remotes = await sh("git remote");
    setGit({
      isRepo: true,
      branch,
      changes: Math.max(0, lines.length - 1),
      hasRemote: remotes.stdout.trim().length > 0,
    });
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  const act = async (command: string, then?: () => void): Promise<void> => {
    setBusy(true);
    try {
      const out = await sh(command);
      setOutput([out.stdout, out.stderr].filter(Boolean).join("\n").trim() || "— готово");
      await refresh();
      then?.();
    } finally {
      setBusy(false);
    }
  };

  if (!host.isTauri()) {
    return <div className="git-panel side-note">Git доступен в десктоп-версии (npm run tauri dev).</div>;
  }
  if (!projectPath) {
    return <div className="git-panel side-note">Сначала создай или открой проект (меню «Файл»).</div>;
  }

  return (
    <div className="git-panel">
      {git && !git.isRepo ? (
        <div className="git-row">
          <span className="side-note">Папка проекта ещё не под git.</span>
          <button className="mini-btn" disabled={busy} onClick={() => void act("git init -b main && git add -A && git commit -m \"init: plexus project\"")}>
            Создать репозиторий
          </button>
        </div>
      ) : (
        <>
          <div className="git-row">
            <span className="git-branch">⎇ {git?.branch ?? "…"}</span>
            <span className="side-note">изменений: {git?.changes ?? "…"}</span>
            <button className="mini-btn" disabled={busy} onClick={() => void refresh()}>
              ⟳
            </button>
          </div>
          <div className="git-row">
            <input
              type="text"
              value={message}
              placeholder="сообщение коммита"
              onChange={(e) => setMessage(e.target.value)}
            />
            <button
              className="mini-btn"
              disabled={busy || !message.trim() || (git?.changes ?? 0) === 0}
              onClick={() =>
                void act(`git add -A && git commit -m "${message.trim().replace(/"/g, "'")}"`, () =>
                  setMessage(""),
                )
              }
            >
              Коммит
            </button>
            <button
              className="mini-btn"
              disabled={busy || !git?.hasRemote}
              title={git?.hasRemote ? "git push" : "Сначала привяжи origin"}
              onClick={() => void act("git push -u origin HEAD")}
            >
              Пуш ↑
            </button>
          </div>
          {!git?.hasRemote && (
            <div className="git-row">
              <input
                type="text"
                value={remote}
                placeholder="https://github.com/user/repo.git"
                onChange={(e) => setRemote(e.target.value)}
              />
              <button
                className="mini-btn"
                disabled={busy || !remote.trim()}
                onClick={() => void act(`git remote add origin ${remote.trim()}`)}
              >
                Привязать origin
              </button>
            </div>
          )}
        </>
      )}
      {output && <pre className="git-output">{output}</pre>}
    </div>
  );
}

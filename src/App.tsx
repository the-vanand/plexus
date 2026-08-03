/**
 * Корневая раскладка IDE. Панели — «шторки»: сворачиваются (тумблеры в
 * тайтлбаре) и меняют размер перетаскиванием разделителей, освобождая место.
 * Холст всегда смонтирован (Pixi не перезапускается); код рисуется оверлеем.
 */
import { useEffect, useState } from "react";
import { PixiCanvas } from "./canvas/PixiCanvas";
import { TitleBar } from "./components/TitleBar";
import { FileExplorer } from "./components/FileExplorer";
import { ToolsPanel } from "./components/ToolsPanel";
import { TabBar } from "./components/TabBar";
import { CodeView } from "./components/CodeView";
import { PreviewView } from "./components/PreviewView";
import { DbView } from "./components/DbView";
import { Inspector } from "./components/Inspector";
import { ConsolePanel } from "./components/ConsolePanel";
import { StatusBar } from "./components/StatusBar";
import { Splitter } from "./components/Splitter";
import { useStore } from "./core/store";
import { useUi } from "./core/uiStore";

export default function App() {
  const [zoom, setZoom] = useState(1);
  const activeTab = useStore((s) => s.activeTab);
  const ui = useUi();

  useEffect(() => {
    void useStore.getState().init();
  }, []);

  return (
    <div className="app-grid">
      <TitleBar />
      <div className="app-main">
        {ui.leftOpen && (
          <>
            <div className="panel-slot" style={{ width: ui.leftW }}>
              {/* .panel-slot — flex-СТРОКА, поэтому переключатель и панель
                  обязаны лежать внутри своей колонки: иначе они встают
                  рядом двумя полосами на всю высоту */}
              <div className="left-panel">
              {/* левая панель работает в двух режимах: проект и каталог
                  инструментов — каталог большой, ему нужна вся высота */}
              <div className="left-modes">
                <button
                  className={`left-mode${ui.leftTab === "project" ? " on" : ""}`}
                  onClick={() => ui.setLeftTab("project")}
                >
                  Проект
                </button>
                <button
                  className={`left-mode${ui.leftTab === "tools" ? " on" : ""}`}
                  onClick={() => ui.setLeftTab("tools")}
                >
                  Инструменты
                </button>
              </div>
              {ui.leftTab === "tools" ? <ToolsPanel /> : <FileExplorer />}
              </div>
            </div>
            <Splitter orientation="v" size={ui.leftW} dir={1} onResize={ui.setLeftW} />
          </>
        )}

        <div className="workzone">
          <TabBar />
          <div className="content">
            <PixiCanvas onZoomChange={setZoom} />
            {activeTab === "preview" && <PreviewView />}
            {activeTab === "db" && (
              <div className="overlay-view">
                <DbView />
              </div>
            )}
            {activeTab !== "canvas" && activeTab !== "preview" && activeTab !== "db" && (
              <CodeView path={activeTab} />
            )}
          </div>
          {ui.bottomOpen && (
            <>
              <Splitter orientation="h" size={ui.bottomH} dir={-1} onResize={ui.setBottomH} />
              <div className="panel-slot" style={{ height: ui.bottomH }}>
                <ConsolePanel />
              </div>
            </>
          )}
        </div>

        {ui.rightOpen && (
          <>
            <Splitter orientation="v" size={ui.rightW} dir={-1} onResize={ui.setRightW} />
            <div className="panel-slot" style={{ width: ui.rightW }}>
              <Inspector />
            </div>
          </>
        )}
      </div>
      <StatusBar zoom={zoom} />
    </div>
  );
}

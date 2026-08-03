/** Вкладки: холст (не закрывается) + открытые файлы — как в PyCharm. */
import { useStore } from "../core/store";

export function TabBar() {
  const openTabs = useStore((s) => s.openTabs);
  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const closeTab = useStore((s) => s.closeTab);

  return (
    <div className="tabbar">
      <button
        className={`tab${activeTab === "canvas" ? " active" : ""}`}
        onClick={() => setActiveTab("canvas")}
      >
        ▦ Холст
      </button>
      <button
        className={`tab${activeTab === "preview" ? " active" : ""}`}
        onClick={() => setActiveTab("preview")}
      >
        ▶ Предпросмотр
      </button>
      <button
        className={`tab${activeTab === "db" ? " active" : ""}`}
        onClick={() => setActiveTab("db")}
      >
        ⛁ База данных
      </button>
      {openTabs.map((path) => (
        <div key={path} className={`tab${activeTab === path ? " active" : ""}`}>
          <button className="tab-main" onClick={() => setActiveTab(path)}>
            {path}
          </button>
          <button
            className="tab-close"
            title="Закрыть"
            onClick={(e) => {
              e.stopPropagation();
              closeTab(path);
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

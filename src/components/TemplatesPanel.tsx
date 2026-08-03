/**
 * ПАНЕЛЬ ШАБЛОНОВ СТРАНИЦ.
 *
 * Позволяет развернуть готовую страницу одним кликом: новый фрейм создаётся
 * в свободном месте холста, затем каждая секция шаблона вставляется
 * через `insertSpec`.
 *
 * Категории, поиск и карточки — в том же визуальном языке, что и ToolsPanel
 * (переиспользуем классы `.tools-*`). Дополнительные стили — в templates.css.
 */
import { useState, useMemo, useCallback } from "react";
import { useStore } from "../core/store";
import {
  PAGE_TEMPLATES,
  TEMPLATE_CATEGORIES,
  type PageTemplate,
  type TemplateCategory,
} from "../core/pageTemplates";
import "../styles/templates.css";

export function TemplatesPanel() {
  const addFrameAt = useStore((s) => s.addFrameAt);
  const insertSpec = useStore((s) => s.insertSpec);
  const updateLayout = useStore((s) => s.updateLayout);

  const [category, setCategory] = useState<TemplateCategory | "all">("all");
  const [query, setQuery] = useState("");
  const [insertedId, setInsertedId] = useState<string | null>(null);

  const q = query.trim().toLowerCase();

  const templates = useMemo(
    () =>
      PAGE_TEMPLATES.filter((t) => {
        if (category !== "all" && t.category !== category) return false;
        if (!q) return true;
        return `${t.name} ${t.description} ${t.category}`.toLowerCase().includes(q);
      }),
    [category, q],
  );

  /**
   * Найти свободное место справа от последнего фрейма.
   *
   * Документ читается СВЕЖИМ через `getState()`, а не из значения рендера:
   * каждое действие store кладёт в состояние новый объект документа
   * (`commit` после `structuredClone`), поэтому снимок из замыкания устаревает
   * сразу после первой вставки — два шаблона подряд встали бы друг на друга.
   */
  const findFreePosition = useCallback((): [number, number] => {
    const doc = useStore.getState().doc;
    if (doc.rootFrames.length === 0) return [160, 120];
    let maxRight = 0;
    let topY = 120;
    for (const frameId of doc.rootFrames) {
      const frame = doc.nodes[frameId];
      if (!frame) continue;
      const right = frame.layout.x + (typeof frame.layout.width === "number" ? frame.layout.width : 1440);
      if (right > maxRight) {
        maxRight = right;
        topY = frame.layout.y;
      }
    }
    return [maxRight + 120, topY];
  }, []);

  const insertTemplate = useCallback(
    (template: PageTemplate) => {
      const [wx, wy] = findFreePosition();
      const frameId = addFrameAt(wx, wy);
      /* Ширина фрейма — через действие store, а не правкой узла напрямую.
         Прямая запись в `doc.nodes[...]` не работала: документ из рендера
         устаревает сразу после `addFrameAt`, нового фрейма в нём ещё нет,
         поэтому ширина шаблона молча терялась и страница на 1200px
         разворачивалась в дефолтном фрейме. Плюс правка вне действия
         не попадает в историю и не даёт отменить вставку. */
      updateLayout(frameId, { width: template.pageWidth, height: "hug" });
      for (const spec of template.sections()) {
        insertSpec(spec, frameId);
      }
      setInsertedId(template.id);
      setTimeout(() => setInsertedId(null), 1200);
    },
    [addFrameAt, insertSpec, updateLayout, findFreePosition],
  );

  return (
    <div className="tools-panel">
      <div className="tools-search">
        <input
          type="text"
          value={query}
          placeholder="Поиск шаблона…"
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="tools-clear" title="Очистить" onClick={() => setQuery("")}>
            ✕
          </button>
        )}
      </div>

      <div className="tools-cats">
        <button
          className={`cat-chip${category === "all" ? " on" : ""}`}
          onClick={() => setCategory("all")}
        >
          Все
        </button>
        {TEMPLATE_CATEGORIES.map((c) => (
          <button
            key={c.id}
            className={`cat-chip${category === c.id ? " on" : ""}`}
            title={c.hint}
            onClick={() => setCategory(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="tools-list">
        {category === "all" && !q
          ? TEMPLATE_CATEGORIES.map((c) => {
              const list = PAGE_TEMPLATES.filter((t) => t.category === c.id);
              if (list.length === 0) return null;
              return (
                <div key={c.id} className="tmpl-group">
                  <div className="tools-group-title">{c.label}</div>
                  <div className="tmpl-list">
                    {list.map((t) => (
                      <TemplateCard
                        key={t.id}
                        template={t}
                        inserted={insertedId === t.id}
                        onPick={() => insertTemplate(t)}
                      />
                    ))}
                  </div>
                </div>
              );
            })
          : (
              <div className="tmpl-list">
                {templates.map((t) => (
                  <TemplateCard
                    key={t.id}
                    template={t}
                    inserted={insertedId === t.id}
                    onPick={() => insertTemplate(t)}
                  />
                ))}
                {templates.length === 0 && (
                  <div className="tools-empty">Ничего не нашлось</div>
                )}
              </div>
            )}
      </div>
    </div>
  );
}

function TemplateCard({
  template,
  inserted,
  onPick,
}: {
  template: PageTemplate;
  inserted: boolean;
  onPick: () => void;
}) {
  const sectCount = template.sections().length;
  return (
    <button
      className={`tmpl-card${inserted ? " inserted" : ""}`}
      title={template.description}
      onClick={onPick}
    >
      <span className="tmpl-card-name">{template.name}</span>
      <span className="tmpl-card-desc">{template.description}</span>
      <span className="tmpl-card-meta">{sectCount} секций · {template.pageWidth} px</span>
    </button>
  );
}

/**
 * ПАНЕЛЬ ИНСТРУМЕНТОВ — каталог блоков и элементов.
 *
 * Два уровня, как в самом каталоге типов: БЛОКИ (готовые секции целиком) и
 * ЭЛЕМЕНТЫ (кирпичи внутрь блока). Блоки разложены по пяти категориям,
 * элементы — по шести группам, поверх всего — поиск.
 *
 * Принцип из документа: превью должно показывать РЕЗУЛЬТАТ, а не название.
 * Поэтому у каждой позиции схематичный глиф и подсказка, что она даёт.
 */
import { useMemo, useState } from "react";
import { useStore } from "../core/store";
import {
  BLOCK_CATEGORIES, BLOCKS, ELEMENT_GROUPS, ELEMENTS,
  type BlockCategory, type BlockDefinition, type ElementDefinition,
} from "../core/blocks";
import { NODE_LABELS } from "../core/scene";

type Tab = "blocks" | "elements";

export function ToolsPanel() {
  const insertBlock = useStore((s) => s.insertBlock);
  const insertSpec = useStore((s) => s.insertSpec);
  const addNode = useStore((s) => s.addNode);
  const selection = useStore((s) => s.selection);
  const doc = useStore((s) => s.doc);

  const [tab, setTab] = useState<Tab>("blocks");
  const [category, setCategory] = useState<BlockCategory | "all">("all");
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();

  const blocks = useMemo(
    () =>
      BLOCKS.filter((b) => {
        if (category !== "all" && b.category !== category) return false;
        if (!q) return true;
        return `${b.label} ${b.hint} ${b.type}`.toLowerCase().includes(q);
      }),
    [category, q],
  );

  const elements = useMemo(
    () => ELEMENTS.filter((e) => (!q ? true : `${e.label} ${e.hint}`.toLowerCase().includes(q))),
    [q],
  );

  /** Куда вставится — показываем заранее, чтобы клик не был лотереей. */
  const targetName = useMemo(() => {
    const sel = selection[0] ? doc.nodes[selection[0]] : undefined;
    if (sel) {
      if (sel.type === "container" || sel.type === "frame") return sel.name;
      const parent = sel.parent ? doc.nodes[sel.parent] : undefined;
      if (parent) return parent.name;
    }
    const first = doc.rootFrames[0];
    return first ? doc.nodes[first]?.name : undefined;
  }, [selection, doc]);

  const putElement = (el: ElementDefinition): void => {
    if (el.build) insertSpec(el.build());
    else {
      const sel = selection[0] ? doc.nodes[selection[0]] : undefined;
      const target =
        sel && (sel.type === "container" || sel.type === "frame")
          ? sel.id
          : sel?.parent ?? doc.rootFrames[0];
      if (target) addNode(el.kind, target);
    }
  };

  return (
    <div className="tools-panel">
      <div className="tools-tabs">
        <button className={`tools-tab${tab === "blocks" ? " on" : ""}`} onClick={() => setTab("blocks")}>
          Блоки
        </button>
        <button className={`tools-tab${tab === "elements" ? " on" : ""}`} onClick={() => setTab("elements")}>
          Элементы
        </button>
      </div>

      <div className="tools-search">
        <input
          type="text"
          value={query}
          placeholder="Поиск инструмента…"
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="tools-clear" title="Очистить" onClick={() => setQuery("")}>
            ✕
          </button>
        )}
      </div>

      {targetName && (
        <div className="tools-target" title="Куда вставится выбранный инструмент">
          в «{targetName}»
        </div>
      )}

      {tab === "blocks" ? (
        <>
          <div className="tools-cats">
            <button className={`cat-chip${category === "all" ? " on" : ""}`} onClick={() => setCategory("all")}>
              Все
            </button>
            {BLOCK_CATEGORIES.map((c) => (
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
              ? BLOCK_CATEGORIES.map((c) => (
                  <div key={c.id}>
                    <div className="tools-group-title">{c.label}</div>
                    <div className="tools-grid">
                      {BLOCKS.filter((b) => b.category === c.id).map((b) => (
                        <BlockCard key={b.type} def={b} onPick={() => insertBlock(b.type)} />
                      ))}
                    </div>
                  </div>
                ))
              : (
                  <div className="tools-grid">
                    {blocks.map((b) => (
                      <BlockCard key={b.type} def={b} onPick={() => insertBlock(b.type)} />
                    ))}
                  </div>
                )}
            {blocks.length === 0 && <div className="tools-empty">Ничего не нашлось</div>}
          </div>
        </>
      ) : (
        <div className="tools-list">
          {q ? (
            <div className="tools-elems">
              {elements.map((el, i) => (
                <ElementRow key={`${el.label}-${i}`} def={el} onPick={() => putElement(el)} />
              ))}
              {elements.length === 0 && <div className="tools-empty">Ничего не нашлось</div>}
            </div>
          ) : (
            ELEMENT_GROUPS.map((g) => (
              <div key={g.id}>
                <div className="tools-group-title">{g.label}</div>
                <div className="tools-elems">
                  {ELEMENTS.filter((e) => e.group === g.id).map((el, i) => (
                    <ElementRow key={`${el.label}-${i}`} def={el} onPick={() => putElement(el)} />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function BlockCard({ def, onPick }: { def: BlockDefinition; onPick: () => void }) {
  return (
    <button className="block-card" title={def.hint} onClick={onPick}>
      <span className="block-glyph">{def.glyph}</span>
      <span className="block-label">{def.label}</span>
    </button>
  );
}

function ElementRow({ def, onPick }: { def: ElementDefinition; onPick: () => void }) {
  return (
    <button className="elem-row" title={`${def.hint} · ${NODE_LABELS[def.kind]}`} onClick={onPick}>
      <span className="elem-glyph">{def.glyph}</span>
      <span className="elem-label">{def.label}</span>
    </button>
  );
}

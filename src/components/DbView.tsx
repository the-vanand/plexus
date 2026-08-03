/**
 * Визуальный конструктор схемы БД: таблицы — карточки-узлы, связи — провода.
 * Тот же принцип, что «глазик»: тяни от порта таблицы (1) к другой таблице (N).
 * Всё компилируется в prisma/schema.prisma (вкладка «Файлы»).
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "../core/store";
import type { DbFieldType } from "../core/types";

const FIELD_TYPES: DbFieldType[] = ["String", "Int", "Float", "Boolean", "DateTime"];
const CARD_W = 240;

export function DbView() {
  const doc = useStore((s) => s.doc);
  const {
    addDbTable, removeDbTable, patchDbTable, addDbField, patchDbField, removeDbField,
    addDbRelation, removeDbRelation, setDbProvider, setSiteTarget, openTab,
  } = useStore.getState();

  const boardRef = useRef<HTMLDivElement>(null);
  const [dragTable, setDragTable] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const [wireFrom, setWireFrom] = useState<string | null>(null);
  const [wirePos, setWirePos] = useState<{ x: number; y: number } | null>(null);

  const tables = Object.values(doc.dbTables);

  const boardPoint = (e: ReactPointerEvent): { x: number; y: number } => {
    const r = boardRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left + boardRef.current!.scrollLeft, y: e.clientY - r.top + boardRef.current!.scrollTop };
  };

  const onBoardMove = (e: ReactPointerEvent): void => {
    if (dragTable) {
      const p = boardPoint(e);
      patchDbTable(dragTable.id, { x: Math.max(0, p.x - dragTable.dx), y: Math.max(0, p.y - dragTable.dy) });
    } else if (wireFrom) {
      setWirePos(boardPoint(e));
    }
  };

  const onBoardUp = (e: ReactPointerEvent): void => {
    if (wireFrom) {
      const p = boardPoint(e);
      const target = tables.find(
        (t) => p.x >= t.x && p.x <= t.x + CARD_W && p.y >= t.y && p.y <= t.y + 40 + t.fields.length * 34 + 44,
      );
      if (target && target.id !== wireFrom) addDbRelation(wireFrom, target.id);
      setWireFrom(null);
      setWirePos(null);
    }
    setDragTable(null);
  };

  /** Точки провода между таблицами. */
  const portOut = (t: (typeof tables)[number]): [number, number] => [t.x + CARD_W, t.y + 19];
  const portIn = (t: (typeof tables)[number]): [number, number] => [t.x, t.y + 19];

  return (
    <div className="db-view">
      <div className="db-toolbar">
        <button className="mini-btn" onClick={() => addDbTable()}>+ Таблица</button>
        <label className="db-label">
          Провайдер
          <select value={doc.dbProvider} onChange={(e) => setDbProvider(e.target.value as "sqlite" | "postgres")}>
            <option value="sqlite">SQLite (локально)</option>
            <option value="postgres">PostgreSQL</option>
          </select>
        </label>
        <label className="db-label">
          Генерация
          <select value={doc.siteTarget} onChange={(e) => setSiteTarget(e.target.value as "static" | "next")}>
            <option value="static">Статический сайт</option>
            <option value="next">Next.js + Prisma</option>
          </select>
        </label>
        <button className="mini-btn" onClick={() => openTab("prisma/schema.prisma")}>
          schema.prisma →
        </button>
        <span className="preview-hint">тяни от голубого порта к другой таблице: связь 1 → N</span>
      </div>

      <div
        className="db-board"
        ref={boardRef}
        onPointerMove={onBoardMove}
        onPointerUp={onBoardUp}
      >
        {/* провода-связи */}
        <svg className="db-wires">
          {doc.dbRelations.map((rel) => {
            const a = doc.dbTables[rel.fromTableId];
            const b = doc.dbTables[rel.toTableId];
            if (!a || !b) return null;
            const [x1, y1] = portOut(a);
            const [x2, y2] = portIn(b);
            const dx = Math.max(40, Math.abs(x2 - x1) / 2);
            const mid = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
            return (
              <g key={rel.id}>
                <path
                  d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`}
                  fill="none" stroke="#aa816a" strokeWidth="2.5"
                />
                <circle cx={x1} cy={y1} r="4" fill="#aa816a" />
                <circle cx={x2} cy={y2} r="4" fill="#aa816a" />
                <g className="db-wire-cut" onClick={() => removeDbRelation(rel.id)}>
                  <circle cx={mid.x} cy={mid.y} r="9" fill="#2c333a" stroke="#aa816a" />
                  <text x={mid.x} y={mid.y + 4} textAnchor="middle" fontSize="11" fill="#e0705e">×</text>
                </g>
              </g>
            );
          })}
          {wireFrom && wirePos && (() => {
            const a = doc.dbTables[wireFrom];
            if (!a) return null;
            const [x1, y1] = portOut(a);
            const dx = Math.max(40, Math.abs(wirePos.x - x1) / 2);
            return (
              <path
                d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${wirePos.x - dx} ${wirePos.y}, ${wirePos.x} ${wirePos.y}`}
                fill="none" stroke="#a9c9ea" strokeWidth="2.5" strokeDasharray="6 4"
              />
            );
          })()}
        </svg>

        {tables.length === 0 && (
          <div className="empty-hint" style={{ pointerEvents: "none" }}>
            <div className="empty-hint-title">Схема пуста</div>
            <div>«+ Таблица» — добавить первую таблицу. Связи — тяни за голубой порт.</div>
          </div>
        )}

        {/* карточки таблиц */}
        {tables.map((t) => (
          <div key={t.id} className="db-card" style={{ left: t.x, top: t.y, width: CARD_W }}>
            <div
              className="db-card-head"
              onPointerDown={(e) => {
                e.preventDefault();
                const p = boardPoint(e);
                setDragTable({ id: t.id, dx: p.x - t.x, dy: p.y - t.y });
              }}
            >
              <input
                className="db-name"
                defaultValue={t.name}
                key={`${t.id}-name`}
                onPointerDown={(e) => e.stopPropagation()}
                onBlur={(e) => patchDbTable(t.id, { name: e.target.value.trim() || t.name })}
              />
              <button className="row-x" title="Удалить таблицу" onClick={() => removeDbTable(t.id)}>×</button>
              {/* порт связи (1 → N) */}
              <span
                className="db-port"
                title="Тяни к другой таблице: связь 1 → N"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  setWireFrom(t.id);
                  setWirePos(boardPoint(e));
                }}
              />
            </div>
            <div className="db-fields">
              <div className="db-field static">
                <span className="db-field-name">id</span>
                <span className="db-field-type">Int · pk</span>
              </div>
              {t.fields.map((f) => (
                <div key={f.id} className="db-field">
                  <input
                    defaultValue={f.name}
                    key={`${f.id}-n`}
                    onBlur={(e) => patchDbField(t.id, f.id, { name: e.target.value.trim() || f.name })}
                  />
                  <select
                    value={f.type}
                    onChange={(e) => patchDbField(t.id, f.id, { type: e.target.value as DbFieldType })}
                  >
                    {FIELD_TYPES.map((ft) => (
                      <option key={ft} value={ft}>{ft}</option>
                    ))}
                  </select>
                  <input
                    type="checkbox"
                    title="Обязательное"
                    checked={f.required}
                    onChange={(e) => patchDbField(t.id, f.id, { required: e.target.checked })}
                  />
                  <button className="row-x" onClick={() => removeDbField(t.id, f.id)}>×</button>
                </div>
              ))}
              <button className="db-add-field" onClick={() => addDbField(t.id)}>+ поле</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

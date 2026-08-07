/**
 * Инспектор свойств (правая панель): «правка атрибутов в пару кликов».
 * Показывает секции по типу выбранного узла; каждое изменение — это
 * обычное действие стора, поэтому попадает в undo/redo автоматически.
 */
import { useState } from "react";
import { useStore } from "../core/store";
import { useUi } from "../core/uiStore";
import type { PaddingValue, Rect, SceneNode, Sides, SizeMode } from "../core/types";
import { NODE_LABELS, WIRE_ACTION_LABELS, packPadding, padBox, resolveNodeAt } from "../core/scene";
import {
  COLOR_TOKENS, resolveColor, resolveTheme, SPACE_LABELS, SPACE_SCALE, type ResolvedTheme,
} from "../core/themes";
import {
  axesToLayout, CONTAINER_PRESETS, inferLayoutPreset, LAYOUT_PRESETS, resolveAxes,
} from "../core/layoutPresets";
import { ICON_NAMES, iconGlyph } from "../core/codegen";

/* ---------- маленькие контролы ---------- */

/**
 * Выравнивание узла внутри родителя (как кнопки в тулбаре Figma/Tilda).
 * Absolute-узел двигается точными координатами по фактическим
 * прямоугольникам (`__plxRects` из холста). Flow-узлу доступно
 * горизонтальное центрирование — это `centered` (margin-inline: auto).
 * Особенно удобно сажать иконку по центру кнопки-обводки.
 */
function AlignButtons({ node }: { node: SceneNode }) {
  const updateLayout = useStore((s) => s.updateLayout);
  /* Подписка на документ держит кнопки в такте с холстом: __plxRects
     обновляется в цикле отрисовки, и без подписки компонент мог бы
     читать прямоугольники, посчитанные до последней правки раскладки. */
  useStore((s) => s.doc);
  const rects = (window as unknown as { __plxRects?: Map<string, Rect> }).__plxRects;
  const r = rects?.get(node.id);
  const p = node.parent ? rects?.get(node.parent) : undefined;
  if (node.layout.position !== "absolute") {
    if (node.type === "frame") return null;
    return (
      <div className="field">
        <label>Выравнивание в контейнере</label>
        <div className="align-btns">
          <button
            type="button"
            className={node.layout.centered ? "on" : ""}
            title="Центрировать по горизонтали (margin: auto)"
            onClick={() => updateLayout(node.id, { centered: !node.layout.centered })}
          >
            ↔ центр
          </button>
        </div>
      </div>
    );
  }
  if (!r || !p) return null;
  const set = (patch: { x?: number; y?: number }) => updateLayout(node.id, patch);
  return (
    <div className="field">
      <label>Выравнивание в контейнере</label>
      <div className="align-rows">
        <div className="align-btns">
          <button type="button" title="К левому краю" onClick={() => set({ x: 0 })}>⇤</button>
          <button type="button" title="Центр по горизонтали" onClick={() => set({ x: Math.round((p.w - r.w) / 2) })}>↔</button>
          <button type="button" title="К правому краю" onClick={() => set({ x: Math.round(p.w - r.w) })}>⇥</button>
        </div>
        <div className="align-btns">
          <button type="button" title="К верхнему краю" onClick={() => set({ y: 0 })}>⤒</button>
          <button type="button" title="Центр по вертикали" onClick={() => set({ y: Math.round((p.h - r.h) / 2) })}>↕</button>
          <button type="button" title="К нижнему краю" onClick={() => set({ y: Math.round(p.h - r.h) })}>⤓</button>
        </div>
      </div>
    </div>
  );
}

function SizeControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: SizeMode;
  onChange: (v: SizeMode) => void;
}) {
  const mode = typeof value === "number" ? "px" : value;
  return (
    <div className="field">
      <label>{label}</label>
      <div className="size-control">
        <select
          value={mode}
          onChange={(e) => {
            const m = e.target.value;
            onChange(m === "px" ? (typeof value === "number" ? value : 200) : (m as SizeMode));
          }}
        >
          <option value="px" title="Фиксированный размер в пикселях">px</option>
          <option value="hug" title="Hug: размер по содержимому (fit-content)">hug</option>
          <option value="fill" title="Fill: заполнить доступное место (flex: 1)">fill</option>
        </select>
        {mode === "px" && (
          <input
            type="number"
            value={typeof value === "number" ? value : 0}
            onChange={(e) => onChange(Number(e.target.value) || 0)}
          />
        )}
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <input type="number" value={value} onChange={(e) => onChange(Number(e.target.value) || 0)} />
    </div>
  );
}

/**
 * Отступы: одно поле, пока стороны равны, и четыре — когда они разные.
 * Импорт реальных сайтов почти всегда даёт разные стороны
 * (`padding: 120px 8vw`), и схлопывать их в одно число нельзя.
 */
function PaddingField({
  value,
  onChange,
}: {
  value: PaddingValue;
  onChange: (v: PaddingValue) => void;
}) {
  const box = padBox(value);
  const uniform = typeof value === "number" || (box.t === box.r && box.r === box.b && box.b === box.l);
  const [expanded, setExpanded] = useState(!uniform);
  const set = (side: keyof Sides, n: number) => onChange(packPadding({ ...box, [side]: n }));

  if (!expanded) {
    return (
      <div className="field">
        <label>
          Отступы
          <button className="linklike" type="button" onClick={() => setExpanded(true)} title="По сторонам">
            ⃞
          </button>
        </label>
        <input
          type="number"
          value={box.t}
          onChange={(e) => onChange(Number(e.target.value) || 0)}
        />
      </div>
    );
  }
  return (
    <div className="field">
      <label>
        Отступы Т/П/Н/Л
        {uniform && (
          <button className="linklike" type="button" onClick={() => setExpanded(false)} title="Одним числом">
            ▢
          </button>
        )}
      </label>
      <div className="row4">
        <input type="number" value={box.t} onChange={(e) => set("t", Number(e.target.value) || 0)} />
        <input type="number" value={box.r} onChange={(e) => set("r", Number(e.target.value) || 0)} />
        <input type="number" value={box.b} onChange={(e) => set("b", Number(e.target.value) || 0)} />
        <input type="number" value={box.l} onChange={(e) => set("l", Number(e.target.value) || 0)} />
      </div>
    </div>
  );
}

/**
 * Отступ токеном шкалы или точным числом.
 *
 * Пресеты идут первыми, точное поле — рядом: при свободных пикселях на
 * странице неизбежно появляются 78, 80 и 82px, и сайт выглядит неаккуратно
 * при формально «настроенных» значениях.
 */
function SpaceField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  const tokens = Object.entries(SPACE_SCALE) as Array<[keyof typeof SPACE_SCALE, number]>;
  return (
    <div className="field">
      <label>{label}</label>
      <div className="space-chips">
        {tokens.map(([token, px]) => (
          <button
            key={token}
            type="button"
            className={`space-chip${value === px ? " on" : ""}`}
            title={`${px}px`}
            onClick={() => onChange(px)}
          >
            {SPACE_LABELS[token]}
          </button>
        ))}
        <input
          type="number"
          value={value}
          style={{ width: 52 }}
          onChange={(e) => onChange(Number(e.target.value) || 0)}
        />
      </div>
    </div>
  );
}

function ColorField({
  label,
  value,
  allowTransparent,
  theme,
  onChange,
}: {
  label: string;
  value: string;
  allowTransparent?: boolean;
  theme: ResolvedTheme;
  onChange: (v: string) => void;
}) {
  const isTransparent = value === "transparent";
  const isToken = value.startsWith("$");
  const shownHex = isTransparent ? "#ffffff" : resolveColor(value, theme);
  return (
    <div className="field">
      <label>{label}</label>
      <div className="color-control">
        {/* токен темы или свой HEX */}
        <select
          className="token-select"
          value={isToken ? value : ""}
          title="Токен темы: цвет меняется вместе со стилем сайта"
          onChange={(e) => onChange(e.target.value || shownHex)}
        >
          <option value="">HEX</option>
          {Object.entries(COLOR_TOKENS).map(([token, t]) => (
            <option key={token} value={token}>
              {t.label}
            </option>
          ))}
        </select>
        {isToken ? (
          <span className="token-swatch" style={{ background: shownHex }} title={shownHex} />
        ) : (
          <input type="color" value={shownHex} onChange={(e) => onChange(e.target.value)} />
        )}
        <span className="color-hex">{value}</span>
        {allowTransparent && (
          <button
            className={`chip${isTransparent ? " on" : ""}`}
            title="Без заливки"
            onClick={() => onChange(isTransparent ? "#ffffff" : "transparent")}
          >
            ∅
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- сам инспектор ---------- */

/* ---------- адаптивность ---------- */

/** Человекочитаемые имена адаптивных свойств — для пометок «переопределено». */
const RESPONSIVE_LABELS: Record<string, string> = {
  width: "ширина", height: "высота", maxWidth: "макс. ширина", centered: "центрирование",
  direction: "направление", gap: "зазор", rowGap: "зазор рядов", padding: "отступы",
  margin: "внешние отступы", align: "выравнивание", justify: "распределение",
  preset: "раскладка", columns: "колонки", autoGrid: "авто-сетка", sidebar: "сайдбар",
  gridTracks: "дорожки", gridSpan: "span", wrap: "перенос", container: "контейнер",
  fontSize: "кегль", fontWeight: "насыщенность", lineHeight: "интерлиньяж",
  letterSpacing: "трекинг", textAlign: "выравнивание текста", uppercase: "заглавные",
};

/**
 * ШАПКА РЕЖИМА БРЕЙКПОИНТА.
 *
 * Главное, что она решает — чтобы правка «не там» была невозможна незаметно:
 * пока брейкпоинт активен, панель явно говорит, что изменения уйдут в
 * переопределения, и перечисляет уже переопределённые свойства. Каждый чип
 * снимает своё переопределение, возвращая значение к более широкой ширине.
 */
function BreakpointBanner({ node }: { node: SceneNode }) {
  const doc = useStore((s) => s.doc);
  const activeBreakpoint = useUi((s) => s.activeBreakpoint);
  const { updateLayout, updateStyle, setNodeHiddenAt, clearOverrides } = useStore.getState();

  const bp = doc.breakpoints.find((b) => b.id === activeBreakpoint);
  if (!bp) return null;

  const ov = node.responsive?.[bp.id];
  const layoutKeys = Object.keys(ov?.layout ?? {});
  const styleKeys = Object.keys(ov?.style ?? {});
  const total = layoutKeys.length + styleKeys.length + (ov?.hidden ? 1 : 0);

  return (
    <div className="insp-bp">
      <div className="insp-bp-head">
        <span className="insp-bp-name">{bp.name} ≤ {bp.maxWidth}px</span>
        {total > 0 && (
          <button className="linklike" onClick={() => clearOverrides(node.id, bp.id)}>
            сбросить всё
          </button>
        )}
      </div>
      <p className="insp-bp-hint">
        Правки уходят в переопределения этого брейкпоинта, база не меняется.
      </p>
      <label className="insp-bp-hide">
        <input
          type="checkbox"
          checked={ov?.hidden ?? false}
          onChange={(e) => setNodeHiddenAt(node.id, bp.id, e.target.checked)}
        />{" "}
        Скрыть на этой ширине
      </label>
      {total > 0 && (
        <div className="space-chips insp-bp-chips">
          {layoutKeys.map((k) => (
            <button
              key={`l-${k}`}
              className="space-chip on"
              title="Снять переопределение этого свойства"
              onClick={() => updateLayout(node.id, { [k]: undefined })}
            >
              {RESPONSIVE_LABELS[k] ?? k} ✕
            </button>
          ))}
          {styleKeys.map((k) => (
            <button
              key={`s-${k}`}
              className="space-chip on"
              title="Снять переопределение этого свойства"
              onClick={() => updateStyle(node.id, { [k]: undefined })}
            >
              {RESPONSIVE_LABELS[k] ?? k} ✕
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Inspector() {
  const selection = useStore((s) => s.selection);
  const doc = useStore((s) => s.doc);
  const { updateLayout, updateStyle, setText, rename, removeWire, setSrc, setTableRef, setCustomCode, log, setSticky, setScrollFill, setHrefValue, setAnchorId, detachSmart, setRole, setReveal, fitFrame, setLayoutPreset, setContainerPreset, setItems, setOrdered, setCite, setIconName, setVideoProvider, setFrameRatio } =
    useStore.getState();

  const node: SceneNode | undefined = selection.length === 1 ? doc.nodes[selection[0]] : undefined;
  const theme = resolveTheme(doc.theme);
  const activeBreakpoint = useUi((s) => s.activeBreakpoint);

  /* Несколько выделенных — не то же самое, что «ничего не выбрано»: рамкой
     выделения набор собирается легко, и молчащий инспектор выглядел бы как
     потеря выделения. Свойств группы пока нет, поэтому честно говорим,
     сколько узлов в наборе и что с ними можно сделать. */
  if (!node && selection.length > 1) {
    return (
      <aside className="inspector">
        <div className="insp-empty">
          <div className="insp-empty-title">Выбрано узлов: {selection.length}</div>
          <p>Свойства правятся у одного элемента — кликни нужный.</p>
          <p>Del — удалить набор.</p>
          <p>Ctrl+D — дублировать набор.</p>
          <p>Shift+клик — добавить, Alt+клик — убрать из набора.</p>
        </div>
      </aside>
    );
  }

  if (!node) {
    return (
      <aside className="inspector">
        <div className="insp-empty">
          <div className="insp-empty-title">Ничего не выбрано</div>
          <p>Клик — выбрать элемент.</p>
          <p>Протяжка по пустому месту — рамка выделения.</p>
          <p>Правый клик — добавить элемент.</p>
          <p>Ctrl+колесо — зум, колесо — панорама.</p>
          <p>Ctrl+Z / Ctrl+Shift+Z — отмена и повтор.</p>
        </div>
      </aside>
    );
  }

  const isBox = node.type === "frame" || node.type === "container";
  const hasText = node.type === "text" || node.type === "button" || node.type === "input";
  /* На активном брейкпоинте контролы показывают РАЗРЕШЁННЫЕ значения (база +
     каскад переопределений), а не базовые: иначе пользователь видел бы одно,
     а страница на этой ширине выглядела бы иначе. Запись при этом уходит в
     переопределения — за это отвечает стор. */
  const resolved = resolveNodeAt(node, doc.breakpoints, activeBreakpoint);
  const L = resolved.layout;
  const S = resolved.style;
  // пресет узла: у импортированных его нет, но структура читается
  const preset = inferLayoutPreset(L);
  const axes = resolveAxes(L);

  return (
    <aside className="inspector">
      <BreakpointBanner node={node} />
      {/* --- Элемент --- */}
      <div className="insp-section">
        <div className="insp-title">
          Элемент <span className="type-badge">{NODE_LABELS[node.type]}</span>
        </div>
        <div className="field">
          <label>Имя</label>
          <input
            type="text"
            defaultValue={node.name}
            key={node.id /* сброс defaultValue при смене выделения */}
            onBlur={(e) => rename(node.id, e.target.value.trim())}
          />
        </div>
        {hasText && (
          <div className="field">
            <label>{node.type === "input" ? "Плейсхолдер" : "Текст"}</label>
            <textarea
              rows={2}
              value={node.text ?? ""}
              onChange={(e) => setText(node.id, e.target.value)}
            />
          </div>
        )}
        {/* ---- содержимое элементов каталога ---- */}
        {node.type === "list" && (
          <>
            <div className="field">
              <label>Пункты (по строке на пункт)</label>
              <textarea
                rows={4}
                value={(node.items ?? []).join("\n")}
                onChange={(e) => setItems(node.id, e.target.value.split("\n"))}
              />
            </div>
            <div className="field">
              <label>
                <input
                  type="checkbox"
                  checked={node.ordered ?? false}
                  onChange={(e) => setOrdered(node.id, e.target.checked)}
                />{" "}
                Нумерованный
              </label>
            </div>
          </>
        )}
        {node.type === "quote" && (
          <>
            <div className="field">
              <label>Текст цитаты</label>
              <textarea rows={3} value={node.text ?? ""} onChange={(e) => setText(node.id, e.target.value)} />
            </div>
            <div className="field">
              <label>Автор</label>
              <input
                type="text"
                key={`cite-${node.id}`}
                defaultValue={node.cite ?? ""}
                placeholder="Имя, должность"
                onBlur={(e) => setCite(node.id, e.target.value)}
              />
            </div>
          </>
        )}
        {node.type === "icon" && (
          <div className="field">
            <label>Иконка</label>
            <div className="space-chips">
              {ICON_NAMES.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`space-chip${node.iconName === name ? " on" : ""}`}
                  title={name}
                  onClick={() => setIconName(node.id, name)}
                >
                  {iconGlyph(name)}
                </button>
              ))}
            </div>
          </div>
        )}
        {(node.type === "video" || node.type === "embed") && (
          <>
            <div className="field">
              <label>{node.type === "video" ? "Ссылка на видео" : "Ссылка виджета"}</label>
              <input
                type="text"
                key={`esrc-${node.id}`}
                defaultValue={node.src ?? ""}
                placeholder={node.type === "video" ? "https://youtu.be/…" : "https://…"}
                onBlur={(e) => setSrc(node.id, e.target.value)}
              />
            </div>
            {node.type === "video" && (
              <div className="field">
                <label>Источник</label>
                <select
                  value={node.videoProvider ?? "youtube"}
                  onChange={(e) => setVideoProvider(node.id, e.target.value as "youtube" | "vimeo" | "file")}
                >
                  <option value="youtube">YouTube</option>
                  <option value="vimeo">Vimeo</option>
                  <option value="file">Файл</option>
                </select>
              </div>
            )}
            <div className="field">
              <label>Пропорции</label>
              <div className="space-chips">
                {([["16:9", 16 / 9], ["4:3", 4 / 3], ["1:1", 1], ["21:9", 21 / 9], ["9:16", 9 / 16]] as Array<[string, number]>).map(
                  ([label, ratio]) => (
                    <button
                      key={label}
                      type="button"
                      className={`space-chip${Math.abs((node.frameRatio ?? 16 / 9) - ratio) < 0.01 ? " on" : ""}`}
                      onClick={() => setFrameRatio(node.id, ratio)}
                    >
                      {label}
                    </button>
                  ),
                )}
              </div>
            </div>
          </>
        )}
        {node.type === "image" && (
          <>
            <div className="field">
              <label>URL картинки</label>
              <input
                type="text"
                key={`src-${node.id}`}
                defaultValue={node.src ?? ""}
                placeholder="https://… (или найди в панели «Картинки»)"
                onBlur={(e) => setSrc(node.id, e.target.value)}
              />
            </div>
            <button
              className="mini-btn"
              onClick={async () => {
                const { pickImageFile, copyIntoAssets, isTauri } = await import("../tauri/api");
                if (!isTauri()) {
                  log("info", "Загрузка с диска — в десктоп-версии");
                  return;
                }
                const file = await pickImageFile();
                if (!file) return;
                const rel = await copyIntoAssets(file);
                if (rel) {
                  setSrc(node.id, rel);
                  log("ok", `Картинка скопирована: ${rel}`);
                } else {
                  log("err", "Сначала сохрани проект на диск (Ctrl+S)");
                }
              }}
            >
              Файл с диска…
            </button>
          </>
        )}
        {(node.type === "text" || node.type === "button") && (
          <div className="field">
            <label>Ссылка (href)</label>
            <input
              type="text"
              key={`href-${node.id}`}
              defaultValue={node.href ?? ""}
              placeholder="#section, page.html или https://…"
              onBlur={(e) => setHrefValue(node.id, e.target.value)}
            />
          </div>
        )}
        {isBox && (
          <div className="field">
            <label>Якорь (id для #ссылок)</label>
            <input
              type="text"
              key={`anchor-${node.id}`}
              defaultValue={node.anchorId ?? ""}
              placeholder="collections — ссылка #collections ведёт сюда"
              onBlur={(e) => setAnchorId(node.id, e.target.value)}
            />
          </div>
        )}
        {(node.type === "autonav" || node.type === "autofooter") && (
          <>
            <div className="side-note" style={{ paddingLeft: 0 }}>
              Умный элемент: сам показывает страницы сайта. Чтобы менять надписи,
              ссылки и порядок — разбери на обычные элементы.
            </div>
            <button className="mini-btn" onClick={() => detachSmart(node.id)}>
              Разобрать для редактирования
            </button>
          </>
        )}
        {node.type === "cmslist" && (
          <div className="field">
            <label>Таблица БД</label>
            <select
              value={node.tableRef ?? ""}
              onChange={(e) => setTableRef(node.id, e.target.value)}
            >
              <option value="">— не выбрана —</option>
              {Object.values(doc.dbTables).map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            {Object.keys(doc.dbTables).length === 0 && (
              <div className="side-note" style={{ paddingLeft: 0 }}>
                Таблицы создаются на вкладке «База данных».
              </div>
            )}
          </div>
        )}
      </div>

      {/* --- Раскладка --- */}
      <div className="insp-section">
        <div className="insp-title">Раскладка</div>

        {node.type !== "frame" && (
          <div className="field">
            <label>Позиция</label>
            <select
              value={L.position}
              onChange={(e) => updateLayout(node.id, { position: e.target.value as "flow" | "absolute" })}
            >
              <option value="flow">В потоке (auto-layout)</option>
              <option value="absolute">Absolute (точные координаты)</option>
            </select>
          </div>
        )}

        {(L.position === "absolute" || node.type === "frame") && (
          <div className="row2">
            <NumberField label="X" value={L.x} onChange={(x) => updateLayout(node.id, { x })} />
            <NumberField label="Y" value={L.y} onChange={(y) => updateLayout(node.id, { y })} />
          </div>
        )}

        {node.type !== "frame" && <AlignButtons node={node} />}

        <div className="row2">
          <SizeControl label="Ширина" value={L.width} onChange={(width) => updateLayout(node.id, { width })} />
          <SizeControl label="Высота" value={L.height} onChange={(height) => updateLayout(node.id, { height })} />
        </div>

        <NumberField
          label="Поворот°"
          value={Math.round(L.rotation || 0)}
          onChange={(rotation) => updateLayout(node.id, { rotation: ((rotation % 360) + 360) % 360 })}
        />

        {isBox && (
          <>
            {/* ТИП РАСКЛАДКИ: пресет вместо ручной сборки свойств */}
            <div className="field">
              <label>Тип раскладки</label>
              <div className="preset-grid">
                {LAYOUT_PRESETS.map((lp) => (
                  <button
                    key={lp.type}
                    type="button"
                    className={`preset-btn${preset === lp.type ? " on" : ""}`}
                    title={lp.hint}
                    onClick={() => setLayoutPreset(node.id, lp.type)}
                  >
                    <span>{lp.glyph}</span>
                    <span>{lp.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* параметры, относящиеся ТОЛЬКО к выбранному типу.
                Нерелевантные контролы скрываем, а не блокируем: серое
                задизейбленное поле читается как «сломалось». */}
            {(preset === "columns" || preset === "masonry") && (
              <div className="field">
                <label>Колонок: {L.columns ?? 3}</label>
                <div className="space-chips">
                  {[2, 3, 4, 5, 6].map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={`space-chip${(L.columns ?? 3) === n ? " on" : ""}`}
                      onClick={() => {
                        updateLayout(node.id, { columns: n });
                        setLayoutPreset(node.id, preset);
                      }}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {preset === "auto-grid" && (
              <div className="field">
                <label>Минимальная ширина карточки: {L.autoGrid?.minColumnWidth ?? 260}px</label>
                <input
                  type="range"
                  min={160}
                  max={480}
                  step={10}
                  value={L.autoGrid?.minColumnWidth ?? 260}
                  onChange={(e) =>
                    updateLayout(node.id, {
                      autoGrid: { minColumnWidth: Number(e.target.value), mode: L.autoGrid?.mode ?? "auto-fit" },
                    })
                  }
                />
                <div className="side-note" style={{ padding: "2px 0 0" }}>
                  Колонки перестроятся сами — без медиазапросов.
                </div>
              </div>
            )}

            {preset === "sidebar" && (
              <div className="row2">
                <NumberField
                  label="Ширина колонки"
                  value={L.sidebar?.width ?? 280}
                  onChange={(width) => {
                    updateLayout(node.id, { sidebar: { width, side: L.sidebar?.side ?? "left" } });
                    setLayoutPreset(node.id, "sidebar");
                  }}
                />
                <div className="field">
                  <label>Сторона</label>
                  <select
                    value={L.sidebar?.side ?? "left"}
                    onChange={(e) => {
                      updateLayout(node.id, {
                        sidebar: { width: L.sidebar?.width ?? 280, side: e.target.value as "left" | "right" },
                      });
                      setLayoutPreset(node.id, "sidebar");
                    }}
                  >
                    <option value="left">Слева</option>
                    <option value="right">Справа</option>
                  </select>
                </div>
              </div>
            )}

            {preset === "row" && (
              <div className="field">
                <label>
                  <input
                    type="checkbox"
                    checked={L.wrap ?? false}
                    onChange={(e) => updateLayout(node.id, { wrap: e.target.checked })}
                  />{" "}
                  Переносить на новую строку
                </label>
              </div>
            )}

            {/* ШИРИНА СОДЕРЖИМОГО */}
            <div className="field">
              <label>Ширина содержимого</label>
              <div className="preset-grid">
                {CONTAINER_PRESETS.map((cp) => (
                  <button
                    key={cp.type}
                    type="button"
                    className={`preset-btn${L.container === cp.type ? " on" : ""}`}
                    title={`${cp.hint}${cp.width ? ` · ${cp.width}px` : ""}`}
                    onClick={() => setContainerPreset(node.id, cp.type)}
                  >
                    <span>{cp.width ? `${Math.round(cp.width / 100)}` : "∞"}</span>
                    <span>{cp.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="row2">
              <SpaceField
                label="Промежуток"
                value={L.gap}
                onChange={(gap) => updateLayout(node.id, { gap })}
              />
              <PaddingField value={L.padding} onChange={(padding) => updateLayout(node.id, { padding })} />
            </div>

            {/* ОСИ: подписи семантические, физику считает layoutPresets */}
            <div className="row2">
              <div className="field">
                <label>По горизонтали</label>
                <select
                  value={String(axes.horizontal)}
                  onChange={(e) => updateLayout(node.id, axesToLayout(L, e.target.value, String(axes.vertical)))}
                >
                  <option value="start">Слева</option>
                  <option value="center">По центру</option>
                  <option value="end">Справа</option>
                  <option value="between">Разнести</option>
                  <option value="stretch">Растянуть</option>
                </select>
              </div>
              <div className="field">
                <label>По вертикали</label>
                <select
                  value={String(axes.vertical)}
                  onChange={(e) => updateLayout(node.id, axesToLayout(L, String(axes.horizontal), e.target.value))}
                >
                  <option value="start">Сверху</option>
                  <option value="center">По центру</option>
                  <option value="end">Снизу</option>
                  <option value="between">Разнести</option>
                  <option value="stretch">Растянуть</option>
                </select>
              </div>
            </div>
          </>
        )}
      </div>

      {/* --- Стиль --- */}
      <div className="insp-section">
        <div className="insp-title">Стиль</div>
        {node.type !== "text" && (
          <ColorField
            label="Заливка"
            value={S.fill}
            allowTransparent={isBox}
            theme={theme}
            onChange={(fill) => updateStyle(node.id, { fill })}
          />
        )}
        {hasText && (
          <>
            <ColorField
              label="Цвет текста"
              value={S.textColor}
              theme={theme}
              onChange={(textColor) => updateStyle(node.id, { textColor })}
            />
            <div className="row2">
              <NumberField
                label="Размер шрифта"
                value={S.fontSize}
                onChange={(fontSize) => updateStyle(node.id, { fontSize })}
              />
              <div className="field">
                <label>Насыщенность</label>
                <select
                  value={S.fontWeight}
                  onChange={(e) => updateStyle(node.id, { fontWeight: Number(e.target.value) as 400 | 500 | 600 | 700 })}
                >
                  <option value={400}>Обычный</option>
                  <option value={500}>Средний</option>
                  <option value={600}>Полужирный</option>
                  <option value={700}>Жирный</option>
                </select>
              </div>
            </div>
          </>
        )}
        {node.type !== "text" && (
          <NumberField label="Скругление" value={S.radius} onChange={(radius) => updateStyle(node.id, { radius })} />
        )}
        {hasText && (
          <>
            <div className="row2">
              <NumberField
                label="Интервал букв"
                value={S.letterSpacing ?? 0}
                onChange={(letterSpacing) => updateStyle(node.id, { letterSpacing })}
              />
              <NumberField
                label="Межстрочный ×"
                value={Math.round((S.lineHeight ?? 1.32) * 100) / 100}
                onChange={(lineHeight) => updateStyle(node.id, { lineHeight: lineHeight || 1.32 })}
              />
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={!!S.uppercase}
                onChange={(e) => updateStyle(node.id, { uppercase: e.target.checked })}
              />
              ЗАГЛАВНЫЕ (uppercase)
            </label>
          </>
        )}
        {isBox && (
          <>
            <div className="row2">
              <NumberField
                label="Рамка, px"
                value={S.borderWidth ?? 0}
                onChange={(borderWidth) => updateStyle(node.id, { borderWidth })}
              />
              <div className="field">
                <label>Только сверху</label>
                <label className="check-row" style={{ marginTop: 4 }}>
                  <input
                    type="checkbox"
                    checked={!!S.borderTop}
                    onChange={(e) => updateStyle(node.id, { borderTop: e.target.checked })}
                  />
                  border-top
                </label>
              </div>
            </div>
            {(S.borderWidth ?? 0) > 0 && (
              <ColorField
                label="Цвет рамки"
                value={S.borderColor ?? "$muted"}
                theme={theme}
                onChange={(borderColor) => updateStyle(node.id, { borderColor })}
              />
            )}
          </>
        )}
      </div>

      {/* --- Роль и анимация --- */}
      {isBox && (
        <div className="insp-section">
          <div className="insp-title">Секция</div>
          <div className="field">
            <label>Роль (семантика в коде)</label>
            <select
              value={node.role ?? ""}
              onChange={(e) => setRole(node.id, e.target.value as "header" | "footer" | "section" | "nav" | "")}
            >
              <option value="">— обычный блок (div)</option>
              <option value="header">Шапка (header)</option>
              <option value="nav">Навигация (nav)</option>
              <option value="section">Секция (section)</option>
              <option value="footer">Подвал (footer)</option>
            </select>
          </div>
          <div className="field">
            <label>Появление при прокрутке</label>
            <select
              value={node.reveal?.kind ?? ""}
              onChange={(e) =>
                setReveal(
                  node.id,
                  e.target.value
                    ? { kind: e.target.value as "fade" | "up" | "down" | "zoom", duration: node.reveal?.duration ?? 700, delay: node.reveal?.delay ?? 0 }
                    : undefined,
                )
              }
            >
              <option value="">— без анимации</option>
              <option value="fade">Проявление</option>
              <option value="up">Снизу вверх</option>
              <option value="down">Сверху вниз</option>
              <option value="zoom">Масштаб</option>
            </select>
          </div>
          {node.reveal && (
            <div className="row2">
              <NumberField
                label="Длительность, мс"
                value={node.reveal.duration}
                onChange={(duration) => setReveal(node.id, { ...node.reveal!, duration })}
              />
              <NumberField
                label="Задержка, мс"
                value={node.reveal.delay}
                onChange={(delay) => setReveal(node.id, { ...node.reveal!, delay })}
              />
            </div>
          )}
          {node.type === "frame" && (
            <button
              className="mini-btn"
              title="Подогнать высоту страницы под содержимое"
              onClick={() => {
                // высоту контента берём из фактической раскладки (rects знает холст)
                const h = (window as unknown as { __plxFrameContentH?: Record<string, number> }).__plxFrameContentH?.[node.id];
                if (h) fitFrame(node.id, h);
                else log("info", "Открой холст, чтобы измерить содержимое, и повтори");
              }}
            >
              Подогнать под содержимое
            </button>
          )}
        </div>
      )}

      {/* --- Шапка (sticky) --- */}
      {isBox && (
        <div className="insp-section">
          <div className="insp-title">Шапка</div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={!!node.sticky}
              onChange={(e) => setSticky(node.id, e.target.checked)}
            />
            Закрепить сверху (sticky)
          </label>
          {node.sticky && (
            <ColorField
              label="Фон при прокрутке"
              value={node.scrollFill ?? "$surface"}
              theme={theme}
              onChange={(v) => setScrollFill(node.id, v)}
            />
          )}
          {node.sticky && (
            <div className="side-note" style={{ paddingLeft: 0 }}>
              Бар прилипает к верху; при прокрутке «затвердевает» этим фоном + blur —
              как верхний бар анализируемого сайта.
            </div>
          )}
        </div>
      )}

      {/* --- Свой код (two-way слот) --- */}
      {node.type !== "frame" && node.type !== "instance" && (
        <div className="insp-section">
          <div className="insp-title">Свой код (JS, по клику)</div>
          <textarea
            rows={3}
            className="code-slot"
            key={`code-${node.id}`}
            defaultValue={node.customCode ?? ""}
            placeholder={`console.log("клик по ${node.name}");`}
            onBlur={(e) => setCustomCode(node.id, e.target.value)}
          />
          <div className="side-note" style={{ paddingLeft: 0 }}>
            Попадает в script.js между маркерами PLX-SLOT — правки в файле можно
            вернуть кнопкой «Слоты ← файл» на вкладке кода.
          </div>
        </div>
      )}

      {/* --- Связи (провода) --- */}
      {(() => {
        const outgoing = doc.wires.filter((w) => w.sourceId === node.id);
        const incoming = doc.wires.filter((w) => w.targetId === node.id);
        if (outgoing.length === 0 && incoming.length === 0) return null;
        return (
          <div className="insp-section">
            <div className="insp-title">Связи</div>
            {outgoing.map((w) => (
              <div key={w.id} className="wire-row">
                <span className="wire-label">
                  → {WIRE_ACTION_LABELS[w.action]?.toLowerCase()} «{doc.nodes[w.targetId]?.name ?? "?"}»
                </span>
                <button className="row-x" title="Удалить связь" onClick={() => removeWire(w.id)}>
                  ×
                </button>
              </div>
            ))}
            {incoming.map((w) => (
              <div key={w.id} className="wire-row">
                <span className="wire-label muted-wire">
                  ← из «{doc.nodes[w.sourceId]?.name ?? "?"}» ({WIRE_ACTION_LABELS[w.action]?.toLowerCase()})
                </span>
                <button className="row-x" title="Удалить связь" onClick={() => removeWire(w.id)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        );
      })()}
    </aside>
  );
}

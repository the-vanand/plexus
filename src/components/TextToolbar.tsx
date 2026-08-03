/**
 * Плавающая панель форматирования текста (появляется над выделенным
 * текстом или кнопкой): цвет · размер · B · I · S · ссылка · выравнивание · провода.
 * Дизайн — по референсу пользователя: тёмная «пилюля» с группами через разделители.
 */
import { useStore } from "../core/store";

const SIZES: Array<{ label: string; value: number }> = [
  { label: "Подпись", value: 13 },
  { label: "Обычный", value: 16 },
  { label: "Средний", value: 20 },
  { label: "Крупный", value: 28 },
  { label: "Заголовок", value: 44 },
];

interface Props {
  nodeId: string;
  x: number;
  y: number;
}

export function TextToolbar({ nodeId, x, y }: Props) {
  const doc = useStore((s) => s.doc);
  const { updateStyle, setHref, toggleEye } = useStore.getState();
  const node = doc.nodes[nodeId];
  if (!node) return null;

  const S = node.style;
  const sizeValue = SIZES.some((s) => s.value === S.fontSize) ? String(S.fontSize) : "custom";

  const askLink = (): void => {
    const url = window.prompt("Ссылка (https://… или страница.html). Пусто — убрать:", node.href ?? "");
    if (url === null) return; // отмена
    setHref(nodeId, url);
  };

  return (
    <div
      className="text-toolbar"
      style={{ left: x, top: y }}
      /* не даём холсту перехватить клик и сбросить выделение */
      onPointerDown={(e) => e.stopPropagation()}
    >
      <label className="tt-swatch" title="Цвет текста" style={{ background: S.textColor }}>
        <input
          type="color"
          value={S.textColor}
          onChange={(e) => updateStyle(nodeId, { textColor: e.target.value })}
        />
      </label>

      <div className="tt-sep" />

      <span className="tt-aa" title="Размер текста">Aa</span>
      <select
        className="tt-size"
        value={sizeValue}
        onChange={(e) => {
          if (e.target.value !== "custom") updateStyle(nodeId, { fontSize: Number(e.target.value) });
        }}
      >
        {SIZES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
        {sizeValue === "custom" && <option value="custom">{S.fontSize}px</option>}
      </select>

      <div className="tt-sep" />

      <button
        className={`tt-btn${S.fontWeight >= 600 ? " on" : ""}`}
        title="Жирный"
        onClick={() => updateStyle(nodeId, { fontWeight: S.fontWeight >= 600 ? 400 : 700 })}
      >
        B
      </button>
      <button
        className={`tt-btn tt-i${S.italic ? " on" : ""}`}
        title="Курсив"
        onClick={() => updateStyle(nodeId, { italic: !S.italic })}
      >
        I
      </button>
      <button
        className={`tt-btn tt-s${S.strike ? " on" : ""}`}
        title="Зачёркнутый"
        onClick={() => updateStyle(nodeId, { strike: !S.strike })}
      >
        S
      </button>
      <button className={`tt-btn${node.href ? " on" : ""}`} title="Ссылка" onClick={askLink}>
        🔗
      </button>

      <div className="tt-sep" />

      <select
        className="tt-size tt-align"
        title="Выравнивание"
        value={S.textAlign ?? "left"}
        onChange={(e) => updateStyle(nodeId, { textAlign: e.target.value as "left" | "center" | "right" })}
      >
        <option value="left">Слева</option>
        <option value="center">Центр</option>
        <option value="right">Справа</option>
      </select>

      <div className="tt-sep" />

      <button className="tt-btn" title="Провода (связи элемента)" onClick={toggleEye}>
        ⧉
      </button>
    </div>
  );
}

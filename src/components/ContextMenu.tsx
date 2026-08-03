/** Контекстное меню холста: фиксированное позиционирование + клик-мимо закрывает. */
import { useEffect, useRef, type CSSProperties } from "react";

export type MenuItem =
  | { label: string; hint?: string; danger?: boolean; action: () => void }
  | "sep";

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  /* не выпадать за край окна */
  const style: CSSProperties = {
    left: Math.min(x, window.innerWidth - 260),
    top: Math.min(y, window.innerHeight - items.length * 30 - 24),
  };

  return (
    <div className="ctx-menu" ref={ref} style={style}>
      {items.map((item, i) =>
        item === "sep" ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <button
            key={i}
            className={`ctx-item${item.danger ? " danger" : ""}`}
            onClick={item.action}
          >
            <span>{item.label}</span>
            {item.hint && <span className="ctx-hint">{item.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}

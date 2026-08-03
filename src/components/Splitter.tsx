/**
 * Разделитель панелей: тянешь — меняешь размер соседней панели.
 * orientation "v" — вертикальная линия (меняет ширину), "h" — горизонтальная (высоту).
 * dir указывает, в какую сторону растёт размер при движении курсора.
 */
import { useRef, type PointerEvent as ReactPointerEvent } from "react";

interface Props {
  orientation: "v" | "h";
  /** Текущий размер панели (px). */
  size: number;
  /** +1: размер растёт по движению курсора; −1: убывает. */
  dir: 1 | -1;
  onResize: (size: number) => void;
}

export function Splitter({ orientation, size, dir, onResize }: Props) {
  const start = useRef({ pos: 0, size: 0 });

  const onPointerDown = (e: ReactPointerEvent): void => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { pos: orientation === "v" ? e.clientX : e.clientY, size };
  };

  const onPointerMove = (e: ReactPointerEvent): void => {
    if (!(e.buttons & 1)) return;
    const cur = orientation === "v" ? e.clientX : e.clientY;
    const delta = (cur - start.current.pos) * dir;
    onResize(start.current.size + delta);
  };

  return (
    <div
      className={`splitter splitter-${orientation}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      role="separator"
      aria-orientation={orientation === "v" ? "vertical" : "horizontal"}
    />
  );
}

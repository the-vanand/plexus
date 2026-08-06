/** Геометрические утилиты для поворота и ручек трансформации. */
import type { Rect } from "./types";

export const deg2rad = (d: number): number => (d * Math.PI) / 180;
export const rad2deg = (r: number): number => (r * 180) / Math.PI;

export interface Pt {
  x: number;
  y: number;
}

/** Повернуть точку (px,py) вокруг центра (cx,cy) на угол a (радианы). */
export function rotateAround(px: number, py: number, cx: number, cy: number, a: number): Pt {
  if (a === 0) return { x: px, y: py };
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = px - cx;
  const dy = py - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

/** Повернуть вектор (vx,vy) вокруг начала координат на угол a. */
export function rotateVec(vx: number, vy: number, a: number): Pt {
  return rotateAround(vx, vy, 0, 0, a);
}

/* ------------------------------------------------------------------ */
/* Прямоугольники: пересечение, накрытие, габарит поворота             */
/* ------------------------------------------------------------------ */

/**
 * Пересекаются ли прямоугольники. Касание границей пересечением НЕ считается:
 * иначе рамка выделения нулевой ширины (клик без протяжки) «задевала» бы всё,
 * что лежит на её линии.
 */
export const rectsIntersect = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Полностью ли `inner` лежит внутри `outer` (границы совпадать могут). */
export const rectContains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h;

/**
 * Осевой габарит повёрнутого прямоугольника (вокруг собственного центра).
 *
 * Нужен там, где сравнивать надо именно с осевой рамкой выделения: точный
 * тест «повёрнутый прямоугольник × прямоугольник» дал бы разницу лишь в узкой
 * зоне у углов, а стоил бы отдельного SAT-кода. Для повёрнутого узла габарит
 * чуть щедрее на попадание и чуть строже на полное накрытие — обе ошибки
 * безопасны.
 */
export function rotatedBounds(rect: Rect, angleRad: number): Rect {
  if (angleRad === 0) return rect;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const corners = [
    rotateAround(rect.x, rect.y, cx, cy, angleRad),
    rotateAround(rect.x + rect.w, rect.y, cx, cy, angleRad),
    rotateAround(rect.x + rect.w, rect.y + rect.h, cx, cy, angleRad),
    rotateAround(rect.x, rect.y + rect.h, cx, cy, angleRad),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

/** Прямоугольник по двум углам (порядок точек не важен). */
export const rectFromPoints = (ax: number, ay: number, bx: number, by: number): Rect => ({
  x: Math.min(ax, bx),
  y: Math.min(ay, by),
  w: Math.abs(bx - ax),
  h: Math.abs(by - ay),
});

export type HandleKey = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** Направление каждой ручки в локальных осях (−1|0|1 по каждой оси). */
export const HANDLE_DIRS: Record<HandleKey, [number, number]> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};

export const HANDLE_KEYS = Object.keys(HANDLE_DIRS) as HandleKey[];

/** CSS-курсор ресайза для ручки (без учёта поворота — приближение). */
export const HANDLE_CURSOR: Record<HandleKey, string> = {
  nw: "nwse-resize",
  n: "ns-resize",
  ne: "nesw-resize",
  e: "ew-resize",
  se: "nwse-resize",
  s: "ns-resize",
  sw: "nesw-resize",
  w: "ew-resize",
};

export interface HandleGeometry {
  center: Pt;
  points: Record<HandleKey, Pt>;
  /** Точка ручки поворота (над верхним центром). */
  rotate: Pt;
}

/**
 * Мировые координаты всех ручек прямоугольника с учётом поворота.
 * rotOffset — вынос ручки поворота в мировых единицах (обычно 24 / zoom).
 */
export function computeHandles(rect: Rect, angleRad: number, rotOffset: number): HandleGeometry {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const points = {} as Record<HandleKey, Pt>;
  for (const key of HANDLE_KEYS) {
    const [hx, hy] = HANDLE_DIRS[key];
    points[key] = rotateAround(cx + (hx * rect.w) / 2, cy + (hy * rect.h) / 2, cx, cy, angleRad);
  }
  const rotate = rotateAround(cx, cy - rect.h / 2 - rotOffset, cx, cy, angleRad);
  return { center: { x: cx, y: cy }, points, rotate };
}

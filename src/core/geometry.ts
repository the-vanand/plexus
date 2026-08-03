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

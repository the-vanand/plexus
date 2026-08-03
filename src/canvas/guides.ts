/**
 * Умные направляющие (как в PowerPoint/Figma):
 *  - снап к краям и центрам соседей (порог в экранных пикселях);
 *  - бейджи «N px» до ближайших соседей по каждой оси.
 *
 * Работает в мировых координатах; порог делится на zoom,
 * чтобы «прилипание» ощущалось одинаково на любом масштабе.
 */
import type { GapBadge, Guide, Rect } from "../core/types";

const SNAP_SCREEN_PX = 6;

export interface SnapResult {
  x: number;
  y: number;
  guides: Guide[];
  badges: GapBadge[];
}

const edgesX = (r: Rect): number[] => [r.x, r.x + r.w / 2, r.x + r.w];
const edgesY = (r: Rect): number[] => [r.y, r.y + r.h / 2, r.y + r.h];

export function computeSnap(drag: Rect, others: Rect[], zoom: number): SnapResult {
  const threshold = SNAP_SCREEN_PX / Math.max(zoom, 0.05);
  const guides: Guide[] = [];
  let bestDx: { delta: number; at: number; other: Rect } | null = null;
  let bestDy: { delta: number; at: number; other: Rect } | null = null;

  for (const other of others) {
    for (const oe of edgesX(other)) {
      for (const de of edgesX(drag)) {
        const delta = oe - de;
        if (Math.abs(delta) <= threshold && (!bestDx || Math.abs(delta) < Math.abs(bestDx.delta))) {
          bestDx = { delta, at: oe, other };
        }
      }
    }
    for (const oe of edgesY(other)) {
      for (const de of edgesY(drag)) {
        const delta = oe - de;
        if (Math.abs(delta) <= threshold && (!bestDy || Math.abs(delta) < Math.abs(bestDy.delta))) {
          bestDy = { delta, at: oe, other };
        }
      }
    }
  }

  const x = drag.x + (bestDx?.delta ?? 0);
  const y = drag.y + (bestDy?.delta ?? 0);
  const snapped: Rect = { ...drag, x, y };

  if (bestDx) {
    const o = bestDx.other;
    guides.push({
      axis: "v",
      at: bestDx.at,
      from: Math.min(snapped.y, o.y) - 8,
      to: Math.max(snapped.y + snapped.h, o.y + o.h) + 8,
    });
  }
  if (bestDy) {
    const o = bestDy.other;
    guides.push({
      axis: "h",
      at: bestDy.at,
      from: Math.min(snapped.x, o.x) - 8,
      to: Math.max(snapped.x + snapped.w, o.x + o.w) + 8,
    });
  }

  return { x, y, guides, badges: computeGapBadges(snapped, others) };
}

/** Бейджи расстояний до ближайшего соседа по горизонтали и вертикали. */
function computeGapBadges(rect: Rect, others: Rect[]): GapBadge[] {
  const badges: GapBadge[] = [];

  const overlapV = (a: Rect, b: Rect): boolean => a.y < b.y + b.h && b.y < a.y + a.h;
  const overlapH = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w;

  let bestH: { gap: number; x: number; y: number } | null = null;
  let bestV: { gap: number; x: number; y: number } | null = null;

  for (const o of others) {
    if (overlapV(rect, o)) {
      // сосед слева или справа
      const gapRight = o.x - (rect.x + rect.w);
      const gapLeft = rect.x - (o.x + o.w);
      const midY = (Math.max(rect.y, o.y) + Math.min(rect.y + rect.h, o.y + o.h)) / 2;
      if (gapRight > 0 && (!bestH || gapRight < bestH.gap)) {
        bestH = { gap: gapRight, x: rect.x + rect.w + gapRight / 2, y: midY };
      }
      if (gapLeft > 0 && (!bestH || gapLeft < bestH.gap)) {
        bestH = { gap: gapLeft, x: rect.x - gapLeft / 2, y: midY };
      }
    }
    if (overlapH(rect, o)) {
      // сосед сверху или снизу
      const gapDown = o.y - (rect.y + rect.h);
      const gapUp = rect.y - (o.y + o.h);
      const midX = (Math.max(rect.x, o.x) + Math.min(rect.x + rect.w, o.x + o.w)) / 2;
      if (gapDown > 0 && (!bestV || gapDown < bestV.gap)) {
        bestV = { gap: gapDown, x: midX, y: rect.y + rect.h + gapDown / 2 };
      }
      if (gapUp > 0 && (!bestV || gapUp < bestV.gap)) {
        bestV = { gap: gapUp, x: midX, y: rect.y - gapUp / 2 };
      }
    }
  }

  if (bestH) badges.push({ x: bestH.x, y: bestH.y, label: `${Math.round(bestH.gap)}` });
  if (bestV) badges.push({ x: bestV.x, y: bestV.y, label: `${Math.round(bestV.gap)}` });
  return badges;
}

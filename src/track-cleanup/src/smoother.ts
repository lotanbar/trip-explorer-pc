/**
 * Light 3-point Gaussian smoother for the off-road parts of a matched track.
 *
 * Three guards keep it from distorting the shape:
 *  - On-road guard: snapped points already lie on the road centreline; averaging would pull them
 *    off on bends. Only off-road points are blended.
 *  - Gap guard: never blends across a time gap larger than [maxGapMs].
 *  - Curvature guard: skips points where the bearing change exceeds [maxTurnDeg], so switchbacks
 *    and sharp turns stay as recorded.
 */

import { bearingDeg, bearingDiffDeg } from './geo';
import type { MatchedPoint } from './matcher';

export interface SmootherOptions {
  maxGapMs: number;
  maxTurnDeg: number;
}

export const DEFAULT_SMOOTHER_OPTIONS: SmootherOptions = {
  maxGapMs: 30_000,
  maxTurnDeg: 45,
};

const KERNEL = [0.25, 0.5, 0.25];

export function smoothOffRoad(points: MatchedPoint[], options: Partial<SmootherOptions> = {}): MatchedPoint[] {
  const opt = { ...DEFAULT_SMOOTHER_OPTIONS, ...options };
  if (points.length < 3) return points.slice();
  const out = points.map((p) => ({ ...p }));
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1], cur = points[i], next = points[i + 1];
    if (cur.onRoad) continue;
    if (cur.timeMs - prev.timeMs > opt.maxGapMs || next.timeMs - cur.timeMs > opt.maxGapMs) continue;
    const inB = bearingDeg(prev.lat, prev.lon, cur.lat, cur.lon);
    const outB = bearingDeg(cur.lat, cur.lon, next.lat, next.lon);
    if (bearingDiffDeg(inB, outB) > opt.maxTurnDeg) continue;
    out[i].lat = KERNEL[0] * prev.lat + KERNEL[1] * cur.lat + KERNEL[2] * next.lat;
    out[i].lon = KERNEL[0] * prev.lon + KERNEL[1] * cur.lon + KERNEL[2] * next.lon;
  }
  return out;
}

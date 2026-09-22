/**
 * The cleanup pipeline, run on the PC when a recording is loaded. Display only: the GPX file is
 * never touched.
 *
 *   raw points (per GPX segment)
 *     → accuracy filter      drop fixes the phone itself rated worse than [maxAccuracyM]
 *     → stationary filter    drop fixes that moved less than [minMovementM] since the last kept one,
 *                            so standing still does not draw a cloud (the resulting time gap
 *                            becomes a break in the matcher, not a fake line)
 *     → Kalman filter        remove high-frequency jitter; trust each fix by its accuracy
 *     → jump guard           drop a fix that lands impossibly far from the previous smoothed one
 *     → derive heading/speed from neighbouring smoothed points (the GPX stores neither)
 *     → map matcher          snap to roads/paths where the track follows them; leave off-road
 *                            stretches where they are (see matcher.ts)
 *     → smoother             de-jitter the off-road stretches only
 */

import { GpsKalmanFilter, type KalmanOptions } from './kalman';
import { MapMatcher, type MatchedPoint, type MatcherOptions, type Observation } from './matcher';
import { RoadGraph, type OsmWay } from './roadGraph';
import { smoothOffRoad, type SmootherOptions } from './smoother';
import { bearingDeg, haversineMeters } from './geo';
import type { RawPoint, RawSegment } from './gpx';

export interface CleanupOptions {
  /** Fixes with a worse accuracy estimate than this (metres) are dropped. */
  maxAccuracyM: number;
  /** Fixes closer than this (metres) to the last kept fix are dropped. */
  minMovementM: number;
  /** Jump guard: base allowed jump (metres) at rest between consecutive smoothed fixes. */
  maxJumpBaseM: number;
  /** Jump guard: allowed jump grows with speed × interval × this factor. */
  jumpSafetyFactor: number;
  kalman: Partial<KalmanOptions>;
  matcher: Partial<MatcherOptions>;
  smoother: Partial<SmootherOptions>;
}

export const DEFAULT_CLEANUP_OPTIONS: CleanupOptions = {
  maxAccuracyM: 50,
  minMovementM: 5,
  maxJumpBaseM: 120,
  jumpSafetyFactor: 2.0,
  kalman: {},
  matcher: {},
  smoother: {},
};

/** Cleans every segment of a recording against the given roads. */
export function cleanTrack(
  segments: RawSegment[],
  roads: OsmWay[],
  options: Partial<CleanupOptions> = {},
): MatchedPoint[][] {
  const opt = { ...DEFAULT_CLEANUP_OPTIONS, ...options };
  const graph = new RoadGraph(roads);
  const matcher = new MapMatcher(graph, opt.matcher);
  return segments
    .map((seg) => prepare(seg, opt))
    .filter((obs) => obs.length > 0)
    .map((obs) => smoothOffRoad(matcher.match(obs), opt.smoother));
}

/** Filters, Kalman-smooths and annotates one segment. Exported for tests. */
export function prepare(segment: RawSegment, opt: CleanupOptions): Observation[] {
  const sorted = segment
    .filter((p) => !(p.accuracyM > opt.maxAccuracyM))
    .slice()
    .sort((a, b) => a.timeMs - b.timeMs);

  const kalman = new GpsKalmanFilter(opt.kalman);
  const smoothed: RawPoint[] = [];
  let lastKept: RawPoint | null = null;
  let lastTime = -Infinity;

  for (const p of sorted) {
    if (p.timeMs <= lastTime) continue; // duplicate or out of order
    if (lastKept && haversineMeters(lastKept.lat, lastKept.lon, p.lat, p.lon) < opt.minMovementM) continue;

    const speedBefore = kalman.speedMps;
    const s = kalman.process(p.lat, p.lon, p.accuracyM, p.timeMs, speedBefore);

    const prev = smoothed[smoothed.length - 1];
    if (prev) {
      const dt = (p.timeMs - prev.timeMs) / 1000;
      const allowed = Math.max(opt.maxJumpBaseM, speedBefore * dt * opt.jumpSafetyFactor);
      if (haversineMeters(prev.lat, prev.lon, s.lat, s.lon) > allowed) {
        kalman.reset();
        continue;
      }
    }

    lastKept = p;
    lastTime = p.timeMs;
    smoothed.push({ lat: s.lat, lon: s.lon, timeMs: p.timeMs, accuracyM: p.accuracyM });
  }

  return annotate(smoothed);
}

/** Derives heading and speed from neighbouring points (central difference where possible). */
function annotate(points: RawPoint[]): Observation[] {
  const n = points.length;
  return points.map((p, i) => {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(n - 1, i + 1)];
    const dt = (b.timeMs - a.timeMs) / 1000;
    const dist = haversineMeters(a.lat, a.lon, b.lat, b.lon);
    const speedMps = dt > 0 ? dist / dt : 0;
    const bearing = dist >= 1 ? bearingDeg(a.lat, a.lon, b.lat, b.lon) : null;
    return { timeMs: p.timeMs, lat: p.lat, lon: p.lon, accuracyM: p.accuracyM, bearingDeg: bearing, speedMps };
  });
}

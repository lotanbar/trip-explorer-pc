import type { OsmWay } from '../src/roadGraph';
import type { Observation } from '../src/matcher';
import type { RawPoint } from '../src/gpx';

export const LAT0 = 32.0;
export const LON0 = 34.8;
/** Metres per degree at LAT0. */
export const M_LAT = 111_320;
export const M_LON = 111_320 * Math.cos((LAT0 * Math.PI) / 180);

/** Offset from the origin in metres → lat/lon. */
export function at(xM: number, yM: number): { lat: number; lon: number } {
  return { lat: LAT0 + yM / M_LAT, lon: LON0 + xM / M_LON };
}

let nodeSeq = 1;

/** A straight way through the given metre offsets. */
export function way(id: number, highway: string, xy: [number, number][], oneway: 0 | 1 | -1 = 0, nodeIds?: number[]): OsmWay {
  return {
    id, highway, oneway,
    points: xy.map(([x, y]) => at(x, y)),
    nodeIds: nodeIds ?? xy.map(() => nodeSeq++),
  };
}

/** A deterministic pseudo-random generator so tests are repeatable. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export interface TrackSpec {
  /** Start and end in metres. */
  from: [number, number];
  to: [number, number];
  speedMps: number;
  /** 1σ lateral noise, metres. */
  noiseM: number;
  accuracyM?: number;
  startMs?: number;
  seed?: number;
}

/** Straight synthetic track at 1 Hz with Gaussian-ish noise. */
export function track(spec: TrackSpec): Observation[] {
  const rand = rng(spec.seed ?? 1);
  const gauss = () => { // Box–Muller
    const u = Math.max(rand(), 1e-9), v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const [x0, y0] = spec.from, [x1, y1] = spec.to;
  const len = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(2, Math.round(len / spec.speedMps));
  const bearing = ((Math.atan2(x1 - x0, y1 - y0) * 180) / Math.PI + 360) % 360;
  const out: Observation[] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const p = at(x0 + f * (x1 - x0) + gauss() * spec.noiseM, y0 + f * (y1 - y0) + gauss() * spec.noiseM);
    out.push({
      timeMs: (spec.startMs ?? 0) + i * 1000,
      lat: p.lat, lon: p.lon,
      accuracyM: spec.accuracyM ?? 10,
      bearingDeg: bearing,
      speedMps: spec.speedMps,
    });
  }
  return out;
}

export function toRaw(obs: Observation[]): RawPoint[] {
  return obs.map((o) => ({ lat: o.lat, lon: o.lon, timeMs: o.timeMs, accuracyM: o.accuracyM }));
}

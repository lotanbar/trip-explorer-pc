/**
 * Recordings: reads a GPX file, runs the display-only track cleanup and builds the line geometry.
 * The GPX file is never changed.
 */

import type { Feature, MultiLineString } from 'geojson';
import { readText, CACHE_TTL_MS, cacheGet, cachePut } from './backend';
import type { RecordingInfo, TripInfo } from './backend';
import { OVERPASS_ENDPOINTS } from './overpass';
import { parseGpx } from './track-cleanup/src/gpx';
import { cleanTrack } from './track-cleanup/src/pipeline';
import { fetchRoadsForTrack, type RoadCache } from './track-cleanup/src/overpass';
import type { OsmWay } from './track-cleanup/src/roadGraph';

/** Roads for track cleanup share the 30-day on-disk cache; one entry per ~1 km tile. */
const ROAD_REQUEST_TIMEOUT_MS = 90_000;

const roadCache: RoadCache = {
  async get(tileKey) {
    try {
      const data = await cacheGet('roads', tileKey, CACHE_TTL_MS);
      return data ? (JSON.parse(data) as OsmWay[]) : null;
    } catch {
      return null;
    }
  },
  async set(tileKey, ways) {
    await cachePut('roads', tileKey, JSON.stringify({ fetchedAt: Date.now() }), JSON.stringify(ways)).catch(() => undefined);
  },
};

export interface LoadedRecording {
  info: RecordingInfo;
  trip: TripInfo;
  /** Cleaned segments, one per <trkseg>. */
  segments: [number, number][][];
  /** True when the roads could not be fetched and the raw points are shown instead. */
  raw: boolean;
  pointCount: number;
}

const loaded = new Map<string, Promise<LoadedRecording>>();

export function loadRecording(info: RecordingInfo, trip: TripInfo, onStatus: (s: string | null) => void): Promise<LoadedRecording> {
  let p = loaded.get(info.path);
  if (!p) {
    p = load(info, trip, onStatus);
    loaded.set(info.path, p);
    p.catch(() => loaded.delete(info.path));
  }
  return p;
}

/** Forgets every cleaned track so a Refresh re-reads the files. */
export function forgetRecordings(): void {
  loaded.clear();
}

async function load(info: RecordingInfo, trip: TripInfo, onStatus: (s: string | null) => void): Promise<LoadedRecording> {
  const xml = await readText(info.path);
  const segments = parseGpx(xml);
  const pointCount = segments.reduce((n, s) => n + s.length, 0);
  if (pointCount === 0) return { info, trip, segments: [], raw: true, pointCount };

  try {
    onStatus(`Cleaning ${info.name}…`);
    const roads = await fetchRoadsForTrack(segments.flat(), {
      endpoints: OVERPASS_ENDPOINTS,
      cache: roadCache,
      // The module calls its fetchFn as a method (a bare `fetch` would lose its binding), and a
      // busy Overpass server may otherwise keep a request hanging for minutes.
      fetchFn: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(ROAD_REQUEST_TIMEOUT_MS) }),
      onProgress: (done, total) => onStatus(`Roads for ${info.name}: ${done}/${total}`),
    });
    const cleaned = cleanTrack(segments, roads);
    onStatus(null);
    return {
      info,
      trip,
      segments: cleaned.map((seg) => seg.map((p) => [p.lon, p.lat] as [number, number])),
      raw: false,
      pointCount,
    };
  } catch (e) {
    console.warn(`Track cleanup unavailable for ${info.name}; showing raw points`, e);
    onStatus(`Roads unavailable, showing ${info.name} raw`);
    return {
      info,
      trip,
      segments: segments.map((seg) => seg.map((p) => [p.lon, p.lat] as [number, number])),
      raw: true,
      pointCount,
    };
  }
}

// ── Names and colours ─────────────────────────────────────────────────────────────────────────

const NAME_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2})-(\d{2})-(\d{2}) - (?:(\d{4}-\d{2}-\d{2}) )?(?:(\d{2})-(\d{2})-(\d{2})|recording)\.gpx$/i;

/** "2026-09-14 08:10 – 17:45", "2026-09-14 22:10 – 2026-09-15 01:30", or "… – (incomplete)". */
export function recordingDateRange(name: string): string {
  const m = NAME_RE.exec(name);
  if (!m) return name.replace(/\.gpx$/i, '');
  const [, date, h1, m1, , endDate, h2, m2] = m;
  const start = `${date} ${h1}:${m1}`;
  if (!h2) return `${start} – (incomplete)`;
  return endDate ? `${start} – ${endDate} ${h2}:${m2}` : `${start} – ${h2}:${m2}`;
}

/** One colour per trip, derived from its name; saturated so it can never be the trail grey. */
export function tripColor(tripName: string): string {
  let hash = 2166136261;
  for (const ch of tripName) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const hue = (hash >>> 0) % 360;
  return `hsl(${hue}, 80%, 58%)`;
}

export function recordingFeature(rec: LoadedRecording): Feature<MultiLineString> {
  return {
    type: 'Feature',
    geometry: { type: 'MultiLineString', coordinates: rec.segments },
    properties: {
      id: rec.info.path,
      color: tripColor(rec.trip.name),
      incomplete: rec.info.incomplete,
      hover: `${recordingDateRange(rec.info.name)}\n${rec.trip.name}${rec.raw ? '\n(raw, roads unavailable)' : ''}`,
    },
  };
}

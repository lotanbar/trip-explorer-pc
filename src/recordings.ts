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

/**
 * Cleaned tracks, in the same on-disk cache on this PC (never in the trips folder), keyed by the
 * SHA-256 of the GPX text: a file is cleaned again only when its content changes (a rename keeps it).
 * Bump the version when the cleanup changes, so old results are not reused.
 */
export const TRACK_CACHE = 'tracks-v1';

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

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
  /** True for the raw points drawn while the cleanup still runs. */
  cleaning: boolean;
  pointCount: number;
}

/** A recording on its way: the raw points (drawn at once), then the cleaned line that replaces them. */
export interface RecordingLoad {
  raw: Promise<LoadedRecording>;
  cleaned: Promise<LoadedRecording>;
}

const loaded = new Map<string, RecordingLoad>();

export function loadRecording(info: RecordingInfo, trip: TripInfo, onStatus: (s: string | null) => void): RecordingLoad {
  let l = loaded.get(info.path);
  if (!l) {
    const xml = readText(info.path);
    const raw = xml.then((text): LoadedRecording => {
      const segments = parseGpx(text);
      return {
        info,
        trip,
        segments: segments.map((seg) => seg.map((p) => [p.lon, p.lat] as [number, number])),
        raw: true,
        cleaning: true,
        pointCount: segments.reduce((n, s) => n + s.length, 0),
      };
    });
    const cleaned = xml.then((text) => load(info, trip, text, onStatus));
    l = { raw, cleaned };
    loaded.set(info.path, l);
    cleaned.catch(() => loaded.delete(info.path));
  }
  return l;
}

/** Forgets every cleaned track so a Refresh re-reads the files. */
export function forgetRecordings(): void {
  loaded.clear();
}

async function load(info: RecordingInfo, trip: TripInfo, xml: string, onStatus: (s: string | null) => void): Promise<LoadedRecording> {
  // An incomplete recording is still growing: cleaned each time, not cached.
  const key = info.incomplete ? null : await sha256(xml);
  if (key) {
    const hit = await cacheGet(TRACK_CACHE, key, CACHE_TTL_MS).catch(() => null);
    if (hit) {
      const saved = JSON.parse(hit) as { segments: [number, number][][]; pointCount: number };
      return { info, trip, segments: saved.segments, raw: false, cleaning: false, pointCount: saved.pointCount };
    }
  }
  const segments = parseGpx(xml);
  const pointCount = segments.reduce((n, s) => n + s.length, 0);
  if (pointCount === 0) return { info, trip, segments: [], raw: true, cleaning: false, pointCount };

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
    const lines = cleaned.map((seg) => seg.map((p) => [p.lon, p.lat] as [number, number]));
    if (key) {
      const meta = JSON.stringify({ fetchedAt: Date.now(), file: info.name });
      await cachePut(TRACK_CACHE, key, meta, JSON.stringify({ segments: lines, pointCount })).catch(() => undefined);
    }
    return { info, trip, segments: lines, raw: false, cleaning: false, pointCount };
  } catch (e) {
    console.warn(`Track cleanup unavailable for ${info.name}; showing raw points`, e);
    onStatus(`Roads unavailable, showing ${info.name} raw`);
    return {
      info,
      trip,
      segments: segments.map((seg) => seg.map((p) => [p.lon, p.lat] as [number, number])),
      raw: true,
      cleaning: false,
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
      hover: `${recordingDateRange(rec.info.name)}\n${rec.trip.name}${rec.cleaning ? '\n(raw, cleaning…)' : rec.raw ? '\n(raw, roads unavailable)' : ''}`,
    },
  };
}

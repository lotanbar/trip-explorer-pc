/**
 * Fetches the roads and paths around a track from OpenStreetMap through the Overpass API.
 *
 * The area is covered with 0.01° tiles (~1.1 km); each tile is fetched with a 0.005° margin so
 * roads near tile edges are included. Tiles are cached by key (the app supplies the cache, e.g.
 * on disk with a 30-day expiry). Three public endpoints are tried in turn; an endpoint that
 * answers 429 or 5xx is put on cooldown.
 */

import type { OsmWay } from './roadGraph';

export const HIGHWAY_TYPES = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'unclassified', 'residential', 'service',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
  'living_street', 'pedestrian', 'track', 'path', 'footway', 'cycleway', 'steps', 'road',
];

export const DEFAULT_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export const TILE_DEG = 0.01;
export const MARGIN_DEG = 0.005;
const TILES_PER_REQUEST = 40;
const COOLDOWN_MS = 5 * 60_000;

export interface RoadCache {
  get(tileKey: string): Promise<OsmWay[] | null>;
  set(tileKey: string, ways: OsmWay[]): Promise<void>;
}

export interface OverpassOptions {
  endpoints?: string[];
  cache?: RoadCache;
  /** Injected for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  onProgress?: (done: number, total: number) => void;
}

export function tileKey(lat: number, lon: number): string {
  return `${Math.floor(lat / TILE_DEG)},${Math.floor(lon / TILE_DEG)}`;
}

/** Roads for every tile a track touches (deduplicated by way id). */
export async function fetchRoadsForTrack(
  points: { lat: number; lon: number }[],
  options: OverpassOptions = {},
): Promise<OsmWay[]> {
  const keys = new Set<string>();
  for (const p of points) keys.add(tileKey(p.lat, p.lon));
  return fetchRoadsForTiles([...keys], options);
}

export async function fetchRoadsForTiles(tileKeys: string[], options: OverpassOptions = {}): Promise<OsmWay[]> {
  const client = new OverpassClient(options);
  const byId = new Map<number, OsmWay>();
  const missing: string[] = [];
  let done = 0;
  for (const key of tileKeys) {
    const cached = await options.cache?.get(key);
    if (cached) {
      for (const w of cached) byId.set(w.id, w);
      options.onProgress?.(++done, tileKeys.length);
    } else {
      missing.push(key);
    }
  }
  for (let i = 0; i < missing.length; i += TILES_PER_REQUEST) {
    const chunk = missing.slice(i, i + TILES_PER_REQUEST);
    const ways = await client.query(buildQuery(chunk));
    for (const w of ways) byId.set(w.id, w);
    if (options.cache) {
      for (const key of chunk) {
        const box = tileBox(key);
        await options.cache.set(key, ways.filter((w) => wayTouchesBox(w, box)));
      }
    }
    done += chunk.length;
    options.onProgress?.(done, tileKeys.length);
  }
  return [...byId.values()];
}

// ── Query ─────────────────────────────────────────────────────────────────────────────────────

interface Box { s: number; w: number; n: number; e: number }

function tileBox(key: string): Box {
  const [la, lo] = key.split(',').map(Number);
  return {
    s: la * TILE_DEG - MARGIN_DEG, n: (la + 1) * TILE_DEG + MARGIN_DEG,
    w: lo * TILE_DEG - MARGIN_DEG, e: (lo + 1) * TILE_DEG + MARGIN_DEG,
  };
}

function wayTouchesBox(w: OsmWay, b: Box): boolean {
  return w.points.some((p) => p.lat >= b.s && p.lat <= b.n && p.lon >= b.w && p.lon <= b.e);
}

export function buildQuery(tileKeys: string[]): string {
  const filter = `way[highway~"^(${HIGHWAY_TYPES.join('|')})$"]`;
  const parts = tileKeys.map((k) => {
    const b = tileBox(k);
    return `${filter}(${b.s.toFixed(4)},${b.w.toFixed(4)},${b.n.toFixed(4)},${b.e.toFixed(4)});`;
  });
  return `[out:json][timeout:60];(${parts.join('')});out geom;`;
}

// ── Response ──────────────────────────────────────────────────────────────────────────────────

interface OverpassElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  nodes?: number[];
  geometry?: { lat: number; lon: number }[];
}

export function parseWays(json: { elements?: OverpassElement[] }): OsmWay[] {
  const out: OsmWay[] = [];
  for (const el of json.elements ?? []) {
    if (el.type !== 'way' || !el.geometry || !el.tags?.highway) continue;
    out.push({
      id: el.id,
      highway: el.tags.highway,
      points: el.geometry.map((g) => ({ lat: g.lat, lon: g.lon })),
      nodeIds: el.nodes ?? [],
      oneway: parseOneway(el.tags),
    });
  }
  return out;
}

function parseOneway(tags: Record<string, string>): 0 | 1 | -1 {
  const v = tags.oneway;
  if (v === 'yes' || v === '1' || v === 'true') return 1;
  if (v === '-1' || v === 'reverse') return -1;
  if (v === 'no' || v === '0' || v === 'false') return 0;
  if (tags.junction === 'roundabout' || tags.junction === 'circular') return 1;
  if (tags.highway === 'motorway' || tags.highway === 'motorway_link') return 1;
  return 0;
}

// ── Client ────────────────────────────────────────────────────────────────────────────────────

export class OverpassClient {
  private readonly endpoints: string[];
  private readonly fetchFn: typeof fetch;
  private readonly cooldownUntil = new Map<string, number>();

  constructor(options: OverpassOptions = {}) {
    this.endpoints = options.endpoints ?? DEFAULT_ENDPOINTS;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async query(ql: string): Promise<OsmWay[]> {
    let lastError: unknown = new Error('No Overpass endpoint available');
    for (const url of this.endpoints) {
      if ((this.cooldownUntil.get(url) ?? 0) > Date.now()) continue;
      try {
        const res = await this.fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(ql)}`,
        });
        if (res.status === 429 || res.status >= 500) {
          this.cooldownUntil.set(url, Date.now() + COOLDOWN_MS);
          lastError = new Error(`Overpass ${url} answered ${res.status}`);
          continue;
        }
        if (!res.ok) throw new Error(`Overpass ${url} answered ${res.status}`);
        return parseWays(await res.json());
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError;
  }
}

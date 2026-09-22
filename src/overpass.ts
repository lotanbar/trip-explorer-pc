/**
 * Overpass access shared by OSM POIs, trails and track cleanup, copied from the reference app:
 * three endpoints with a cooldown on 429/5xx, fetching only the strips of the viewport not fetched
 * yet, and a 30-day on-disk cache (kept by the backend).
 */

import { CACHE_TTL_MS, cacheGet, cacheIndex, cachePut } from './backend';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const ENDPOINT_COOLDOWN_MS = 5 * 60_000;
/** A little above the longest [timeout:] in our queries, so a hung connection cannot stall a fetch. */
const REQUEST_TIMEOUT_MS = 200_000;
const LAST_HEALTHY_MAX_AGE_MS = 10 * 60_000;

export class OverpassClient {
  private readonly cooldownUntil = new Map<string, number>();
  private lastHealthy: string | null = null;
  private lastHealthyAt = 0;

  constructor(private readonly endpoints: string[] = OVERPASS_ENDPOINTS) {}

  /** The endpoints to try, healthiest first; those cooling down are skipped. */
  private candidates(): string[] {
    const now = Date.now();
    const available = this.endpoints.filter((e) => (this.cooldownUntil.get(e) ?? 0) <= now);
    const preferred = this.lastHealthy && available.includes(this.lastHealthy) && now - this.lastHealthyAt <= LAST_HEALTHY_MAX_AGE_MS
      ? this.lastHealthy
      : null;
    return preferred ? [preferred, ...available.filter((e) => e !== preferred)] : available;
  }

  private coolDown(endpoint: string, retryAfterMs = 0): void {
    const until = Date.now() + Math.max(ENDPOINT_COOLDOWN_MS, retryAfterMs);
    this.cooldownUntil.set(endpoint, Math.max(this.cooldownUntil.get(endpoint) ?? 0, until));
    if (this.lastHealthy === endpoint) this.lastHealthy = null;
  }

  /** Runs `ql` and returns the parsed JSON, or throws when every endpoint failed or is cooling down. */
  async query(ql: string, signal?: AbortSignal): Promise<{ elements?: unknown[] }> {
    const endpoints = this.candidates();
    if (endpoints.length === 0) throw new Error('All Overpass servers are cooling down; try again in a few minutes');
    let lastError: unknown = null;
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(ql)}`,
          signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (res.status === 429 || res.status >= 500) {
          const retryAfter = Number(res.headers.get('Retry-After')) * 1000;
          this.coolDown(endpoint, Number.isFinite(retryAfter) ? retryAfter : 0);
          lastError = new Error(`Overpass ${new URL(endpoint).host} answered ${res.status}`);
          continue;
        }
        if (!res.ok) throw new Error(`Overpass ${new URL(endpoint).host} answered ${res.status}`);
        const json = await res.json();
        this.lastHealthy = endpoint;
        this.lastHealthyAt = Date.now();
        return json;
      } catch (e) {
        if ((e as Error).name === 'AbortError' && signal?.aborted) throw e;
        if (e instanceof TypeError || (e as Error).name === 'TimeoutError') this.coolDown(endpoint); // network failure / timeout
        lastError = e;
      }
    }
    throw lastError ?? new Error('Overpass request failed');
  }
}

export const overpass = new OverpassClient();

// ── Bounds ────────────────────────────────────────────────────────────────────────────────────

export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export function expanded(b: Bounds, fraction: number): Bounds {
  const latPad = (b.north - b.south) * fraction;
  const lngPad = (b.east - b.west) * fraction;
  return {
    north: Math.min(90, b.north + latPad),
    south: Math.max(-90, b.south - latPad),
    east: Math.min(180, b.east + lngPad),
    west: Math.max(-180, b.west - lngPad),
  };
}

/** Grows the bounds so they span at least `km` kilometres in both directions. */
export function atLeastKm(b: Bounds, km: number): Bounds {
  const latSpan = km / 111;
  const centerLat = (b.north + b.south) / 2;
  const lngSpan = km / (111 * Math.max(0.1, Math.cos((centerLat * Math.PI) / 180)));
  const out = { ...b };
  if (out.north - out.south < latSpan) {
    out.north = centerLat + latSpan / 2;
    out.south = centerLat - latSpan / 2;
  }
  if (out.east - out.west < lngSpan) {
    const centerLng = (b.east + b.west) / 2;
    out.east = centerLng + lngSpan / 2;
    out.west = centerLng - lngSpan / 2;
  }
  return out;
}

export function intersects(a: Bounds, b: Bounds): boolean {
  return a.south < b.north && a.north > b.south && a.west < b.east && a.east > b.west;
}

export function contains(b: Bounds, lat: number, lon: number): boolean {
  return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
}

const SLIVER_DEG = 0.0005;

function subtractOne(r: Bounds, c: Bounds): Bounds[] {
  if (!intersects(r, c)) return [r];
  const out: Bounds[] = [];
  if (c.north < r.north) out.push({ north: r.north, south: c.north, east: r.east, west: r.west });
  if (c.south > r.south) out.push({ north: c.south, south: r.south, east: r.east, west: r.west });
  const n = Math.min(r.north, c.north);
  const s = Math.max(r.south, c.south);
  if (c.west > r.west) out.push({ north: n, south: s, east: c.west, west: r.west });
  if (c.east < r.east) out.push({ north: n, south: s, east: r.east, west: c.east });
  return out;
}

/** The parts of `target` not covered by any of `covered`, as non-overlapping rectangles. */
export function uncovered(target: Bounds, covered: Bounds[]): Bounds[] {
  let pieces = [target];
  for (const c of covered) {
    pieces = pieces.flatMap((p) => subtractOne(p, c));
  }
  return pieces.filter((p) => p.north - p.south > SLIVER_DEG && p.east - p.west > SLIVER_DEG);
}

export function bboxString(b: Bounds): string {
  return `${b.south.toFixed(5)},${b.west.toFixed(5)},${b.north.toFixed(5)},${b.east.toFixed(5)}`;
}

// ── Strip store: fetch-by-strips with coverage tracking and the on-disk cache ─────────────────

interface StripMeta {
  bounds: Bounds;
  fetchedAt: number;
}

export interface StripStoreOptions<T> {
  namespace: string;
  buildQuery: (bbox: string) => string;
  parse: (json: { elements?: unknown[] }) => T[];
  keyOf: (item: T) => string;
  onStatus?: (message: string | null) => void;
}

/**
 * Keeps every element fetched so far (this session plus the cache) and fetches only what the
 * viewport still lacks. Elements are merged by key so an object that spans two strips is kept once.
 */
/** After a failed fetch the area is left alone for this long instead of being retried on every pan. */
const RETRY_AFTER_MS = 60_000;

export class StripStore<T> {
  readonly items = new Map<string, T>();
  private covered: Bounds[] = [];
  private inFlight: Bounds[] = [];
  private failed: { bounds: Bounds; until: number }[] = [];
  private cached: { key: string; meta: StripMeta; loaded: boolean }[] = [];
  private ready: Promise<void>;
  private generation = 0;

  constructor(private readonly opt: StripStoreOptions<T>) {
    this.ready = this.loadIndex();
  }

  private async loadIndex(): Promise<void> {
    try {
      const entries = await cacheIndex(this.opt.namespace, CACHE_TTL_MS);
      this.cached = entries.flatMap((e) => {
        try {
          return [{ key: e.key, meta: JSON.parse(e.meta) as StripMeta, loaded: false }];
        } catch {
          return [];
        }
      });
    } catch (e) {
      console.warn(`${this.opt.namespace}: cache index unavailable`, e);
    }
  }

  private merge(items: T[]): void {
    for (const item of items) this.items.set(this.opt.keyOf(item), item);
  }

  /** Makes sure everything inside `target` is loaded. Returns true when the area is now covered. */
  async ensure(target: Bounds): Promise<boolean> {
    await this.ready;
    const gen = ++this.generation;

    // Cached strips that touch the area: load them from disk first.
    for (const entry of this.cached) {
      if (entry.loaded || !intersects(entry.meta.bounds, target)) continue;
      entry.loaded = true;
      try {
        const data = await cacheGet(this.opt.namespace, entry.key, CACHE_TTL_MS);
        if (data) {
          this.merge(JSON.parse(data) as T[]);
          this.covered.push(entry.meta.bounds);
        }
      } catch (e) {
        console.warn(`${this.opt.namespace}: cache entry ${entry.key} unreadable`, e);
      }
    }

    const now = Date.now();
    this.failed = this.failed.filter((f) => f.until > now);
    const strips = uncovered(target, [...this.covered, ...this.inFlight, ...this.failed.map((f) => f.bounds)]);
    if (strips.length === 0) return this.failed.length === 0;

    this.inFlight.push(...strips);
    this.opt.onStatus?.(`Loading ${this.opt.namespace}…`);
    let allOk = true;
    await Promise.all(
      strips.map(async (strip) => {
        try {
          const json = await overpass.query(this.opt.buildQuery(bboxString(strip)));
          const items = this.opt.parse(json);
          this.merge(items);
          this.covered.push(strip);
          const key = `${strip.south.toFixed(4)}_${strip.west.toFixed(4)}_${strip.north.toFixed(4)}_${strip.east.toFixed(4)}`;
          const meta: StripMeta = { bounds: strip, fetchedAt: Date.now() };
          this.cached.push({ key, meta, loaded: true });
          cachePut(this.opt.namespace, key, JSON.stringify(meta), JSON.stringify(items)).catch((e) =>
            console.warn(`${this.opt.namespace}: cache write failed`, e),
          );
        } catch (e) {
          allOk = false;
          this.failed.push({ bounds: strip, until: Date.now() + RETRY_AFTER_MS });
          console.warn(`${this.opt.namespace}: fetch failed`, e);
          this.opt.onStatus?.(`${this.opt.namespace}: ${(e as Error).message}`);
        } finally {
          this.inFlight = this.inFlight.filter((b) => b !== strip);
        }
      }),
    );
    if (allOk && gen === this.generation) this.opt.onStatus?.(null);
    return allOk;
  }
}

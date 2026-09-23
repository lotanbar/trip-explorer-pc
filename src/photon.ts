/**
 * Place search with Photon (photon.komoot.io): OSM data, made for search-as-you-type. Results are
 * biased towards the map centre. Nominatim is not used here: its policy forbids autocomplete.
 * My own POIs (from the trips folder) are matched locally by name and listed first.
 */

export interface SearchResult {
  /** Photon's OSM id (e.g. "W123"), or the POI folder for one of my POIs. */
  id: string;
  name: string;
  /** Town / region / country (the trip name for my POIs), for the list and the web search. */
  place: string;
  /** What kind of thing it is, from the OSM tag (e.g. "castle"); "my POI" for my own. */
  kind: string;
  lat: number;
  lon: number;
  /** One of my POIs: `id` is its folder path. */
  mine?: boolean;
}

/** The plan key of a result: the same key a right-click on the map gives the POI, so both toggle the same stop. */
export function resultKey(r: SearchResult): string {
  return r.mine ? `mine:${r.id}` : `search:${r.id}`;
}

export interface MyPoi {
  name: string;
  path: string;
  lat: number;
  lon: number;
  trip: string;
}

/** My POIs whose name contains the query (case-insensitive), in folder order. */
export function matchMyPois(query: string, pois: readonly MyPoi[]): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return pois
    .filter((p) => p.name.toLowerCase().includes(q))
    .map((p) => ({ id: p.path, name: p.name, place: p.trip, kind: 'my POI', lat: p.lat, lon: p.lon, mine: true }));
}

export const SEARCH_DEBOUNCE_MS = 300;
const ENDPOINT = 'https://photon.komoot.io/api/';

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string | number | undefined>;
}

/** The list entry's second line: the finer parts of the address first, the country last, without repeats. */
export function placeOf(p: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const k of ['city', 'town', 'village', 'locality', 'district', 'county', 'state', 'country']) {
    const v = p[k];
    if (typeof v === 'string' && v && v !== p.name && !parts.includes(v)) parts.push(v);
  }
  return parts.slice(0, 3).join(', ');
}

export function parsePhoton(json: { features?: unknown[] }): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const raw of json.features ?? []) {
    const f = raw as PhotonFeature;
    const p = f.properties ?? {};
    const [lon, lat] = f.geometry?.coordinates ?? [];
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    const name = String(p.name ?? p.street ?? '').trim();
    if (!name) continue;
    const id = `${String(p.osm_type ?? '?')[0]}${p.osm_id ?? `${lat},${lon}`}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const kind = String(p.osm_value ?? p.osm_key ?? '');
    out.push({ id, name, place: placeOf(p), kind: kind === 'yes' ? String(p.osm_key ?? '') : kind.replace(/_/g, ' '), lat, lon });
  }
  return out;
}

export async function searchPlaces(query: string, near: { lat: number; lon: number } | null, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = new URL(ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '12');
  url.searchParams.set('lang', 'en');
  if (near) {
    url.searchParams.set('lat', near.lat.toFixed(4));
    url.searchParams.set('lon', near.lon.toFixed(4));
  }
  const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Photon: HTTP ${res.status}`);
  return parsePhoton(await res.json());
}

/** Runs `search` 300 ms after the last keystroke; a newer query cancels the one in flight. */
export class LiveSearch {
  private timer: number | undefined;
  private controller: AbortController | null = null;

  constructor(private readonly onResults: (query: string, results: SearchResult[] | Error) => void) {}

  update(query: string, near: () => { lat: number; lon: number } | null): void {
    window.clearTimeout(this.timer);
    this.controller?.abort();
    this.controller = null;
    const q = query.trim();
    if (!q) {
      this.onResults('', []);
      return;
    }
    this.timer = window.setTimeout(() => {
      const controller = new AbortController();
      this.controller = controller;
      const timeout = window.setTimeout(() => controller.abort(), 10_000);
      searchPlaces(q, near(), controller.signal)
        .then((results) => { if (!controller.signal.aborted) this.onResults(q, results); })
        .catch((e) => { if (!controller.signal.aborted) this.onResults(q, e as Error); })
        .finally(() => window.clearTimeout(timeout));
    }, SEARCH_DEBOUNCE_MS);
  }

  cancel(): void {
    window.clearTimeout(this.timer);
    this.controller?.abort();
    this.controller = null;
  }
}

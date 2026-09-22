/**
 * Trails and historic ways: marked routes plus historic and abandoned lines from OSM, drawn in
 * light grey with a pattern per category. Ways sharing an endpoint with the same tags are joined
 * across everything fetched so far before the 500 m rule is applied.
 */

import type { FeatureCollection, LineString } from 'geojson';
import { StripStore } from './overpass';
import { haversineMeters } from './track-cleanup/src/geo';
import type { Tags } from './groups';

export type TrailCategory = 'hiking' | 'cycling' | 'riding' | 'winter' | 'via_ferrata' | 'cable' | 'rail' | 'historic';

export interface TrailCategoryInfo {
  id: TrailCategory;
  name: string;
  /** All lines look the same (dotted, light grey); the icon repeated along the line tells them apart. */
  icon: string;
  /** Categories whose joined lines must be at least 500 m long to show. */
  minLengthM: number;
}

export const TRAIL_CATEGORIES: TrailCategoryInfo[] = [
  { id: 'hiking', name: 'Hiking', icon: 'hiker', minLengthM: 0 },
  { id: 'cycling', name: 'Cycling', icon: 'bicycle', minLengthM: 0 },
  { id: 'riding', name: 'Riding', icon: 'horseshoe', minLengthM: 0 },
  { id: 'winter', name: 'Winter', icon: 'snow', minLengthM: 0 },
  { id: 'via_ferrata', name: 'Via ferratas', icon: 'carabiner', minLengthM: 0 },
  { id: 'cable', name: 'Cable cars and lifts', icon: 'gondola', minLengthM: 500 },
  { id: 'rail', name: 'Old railways and canals', icon: 'rail', minLengthM: 500 },
  { id: 'historic', name: 'Historic', icon: 'column', minLengthM: 500 },
];

export const TRAILS_MIN_ZOOM = 11;
export const TRAILS_MIN_AREA_KM = 5;

export interface TrailLine {
  /** Unique per piece: "w123" or "r45:7" (relation member index within the fetched strip). */
  id: string;
  category: TrailCategory;
  name: string | null;
  type: string;
  from: string | null;
  to: string | null;
  distance: string | null;
  website: string | null;
  /** Tag signature used to join way pieces into one line. */
  signature: string;
  coords: [number, number][];
}

function buildQuery(bbox: string): string {
  return `[out:json][timeout:180];
(
  way["railway"~"^(abandoned|disused|razed|preserved)$"](${bbox});
  way["abandoned:railway"](${bbox});
  way["razed:railway"](${bbox});
  way["abandoned:waterway"="canal"](${bbox});
  way["disused:waterway"="canal"](${bbox});
  way["historic"~"^(road|hollow_way|aqueduct)$"](${bbox});
  way["military"="trench"](${bbox});
  way["aerialway"]["aerialway"!~"^(station|pylon|goods)$"](${bbox});
)->.w;
(
  relation["route"~"^(hiking|foot|bicycle|mtb|horse|piste|ski|inline_skates)$"](${bbox});
  way["highway"="via_ferrata"](${bbox});
  .w;
);
out geom(${bbox});`;
}

function humanize(s: string): string {
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function classify(tags: Tags): { category: TrailCategory; type: string } | null {
  const route = tags.route;
  if (route === 'hiking' || route === 'foot') return { category: 'hiking', type: 'Hiking route' };
  if (route === 'bicycle') return { category: 'cycling', type: 'Cycling route' };
  if (route === 'mtb') return { category: 'cycling', type: 'Mountain bike route' };
  if (route === 'horse') return { category: 'riding', type: 'Riding route' };
  if (route === 'piste') return { category: 'winter', type: tags['piste:type'] ? `Piste (${tags['piste:type']})` : 'Piste' };
  if (route === 'ski') return { category: 'winter', type: 'Ski route' };
  if (route === 'inline_skates') return { category: 'winter', type: 'Inline skating route' };
  if (tags.highway === 'via_ferrata') return { category: 'via_ferrata', type: 'Via ferrata' };
  if (tags.aerialway && !['station', 'pylon', 'goods'].includes(tags.aerialway)) {
    return { category: 'cable', type: humanize(tags.aerialway) };
  }
  if (tags.railway && ['abandoned', 'disused', 'razed', 'preserved'].includes(tags.railway)) {
    return { category: 'rail', type: `${humanize(tags.railway)} railway` };
  }
  if (tags['abandoned:railway']) return { category: 'rail', type: 'Abandoned railway' };
  if (tags['razed:railway']) return { category: 'rail', type: 'Razed railway' };
  if (tags['abandoned:waterway'] === 'canal') return { category: 'rail', type: 'Abandoned canal' };
  if (tags['disused:waterway'] === 'canal') return { category: 'rail', type: 'Disused canal' };
  if (tags.historic === 'road') return { category: 'historic', type: 'Historic road' };
  if (tags.historic === 'hollow_way') return { category: 'historic', type: 'Hollow way' };
  if (tags.historic === 'aqueduct') return { category: 'historic', type: 'Aqueduct' };
  if (tags.military === 'trench') return { category: 'historic', type: 'Trench' };
  return null;
}

interface Element {
  type: string;
  id: number;
  tags?: Tags;
  geometry?: ({ lat: number; lon: number } | null)[];
  members?: { type: string; ref: number; role: string; geometry?: ({ lat: number; lon: number } | null)[] }[];
}

/** Splits a geometry at points clipped away by the strip, so no fake line crosses the gap. */
function runs(geometry: ({ lat: number; lon: number } | null)[] | undefined): [number, number][][] {
  const out: [number, number][][] = [];
  let current: [number, number][] = [];
  for (const g of geometry ?? []) {
    if (g) {
      current.push([g.lon, g.lat]);
    } else if (current.length > 1) {
      out.push(current);
      current = [];
    } else {
      current = [];
    }
  }
  if (current.length > 1) out.push(current);
  return out;
}

const SIGNATURE_KEYS = ['railway', 'abandoned:railway', 'razed:railway', 'abandoned:waterway', 'disused:waterway', 'historic', 'military', 'aerialway', 'name', 'ref'];

function makeLine(id: string, tags: Tags, cls: { category: TrailCategory; type: string }, coords: [number, number][]): TrailLine {
  const name = tags.name || tags['name:en'] || tags.ref || null;
  return {
    id,
    category: cls.category,
    name,
    type: cls.type,
    from: tags.from ?? null,
    to: tags.to ?? null,
    distance: tags.distance ?? null,
    website: tags.website || tags['contact:website'] || tags.url || null,
    signature: `${cls.category}|${SIGNATURE_KEYS.map((k) => tags[k] ?? '').join('|')}`,
    coords,
  };
}

function parse(json: { elements?: unknown[] }): TrailLine[] {
  const out: TrailLine[] = [];
  for (const raw of json.elements ?? []) {
    const el = raw as Element;
    const tags = el.tags ?? {};
    const cls = classify(tags);
    if (!cls) continue;
    if (el.type === 'way') {
      runs(el.geometry).forEach((coords, i) => out.push(makeLine(`w${el.id}:${i}`, tags, cls, coords)));
    } else if (el.type === 'relation') {
      // Only the ways: guideposts and other point members are ignored.
      el.members?.forEach((m, i) => {
        if (m.type !== 'way') return;
        runs(m.geometry).forEach((coords, j) => out.push(makeLine(`r${el.id}:${i}:${j}`, tags, cls, coords)));
      });
    }
  }
  return out;
}

export const trailStore = new StripStore<TrailLine>({
  namespace: 'trails',
  buildQuery,
  parse,
  keyOf: (l) => l.id,
});

// ── Joining and the 500 m rule ────────────────────────────────────────────────────────────────

function lengthM(coords: [number, number][]): number {
  let m = 0;
  for (let i = 1; i < coords.length; i++) {
    m += haversineMeters(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  }
  return m;
}

function endpointKey(c: [number, number]): string {
  return `${c[1].toFixed(6)},${c[0].toFixed(6)}`;
}

/** Union-find over pieces that share an endpoint and have the same tags; returns the joined length per piece. */
function joinedLengths(lines: TrailLine[]): Map<string, number> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const byEndpoint = new Map<string, string>();
  for (const line of lines) {
    parent.set(line.id, line.id);
    for (const end of [line.coords[0], line.coords[line.coords.length - 1]]) {
      const key = `${line.signature}@${endpointKey(end)}`;
      const other = byEndpoint.get(key);
      if (other) union(line.id, other);
      else byEndpoint.set(key, line.id);
    }
  }
  const total = new Map<string, number>();
  for (const line of lines) {
    const root = find(line.id);
    total.set(root, (total.get(root) ?? 0) + lengthM(line.coords));
  }
  const out = new Map<string, number>();
  for (const line of lines) out.set(line.id, total.get(find(line.id))!);
  return out;
}

export function trailHover(line: TrailLine): string {
  const parts = [line.name ?? `${line.type} (unnamed)`];
  if (line.from || line.to) parts.push(`${line.from ?? '?'} → ${line.to ?? '?'}`);
  if (line.distance) parts.push(line.distance.match(/[a-z]/i) ? line.distance : `${line.distance} km`);
  return parts.join('\n');
}

/** Drops pieces whose joined line is shorter than the category's minimum (500 m rule). */
export function applyLengthRule(lines: TrailLine[]): TrailLine[] {
  const lengths = joinedLengths(lines.filter((l) => TRAIL_CATEGORIES.find((c) => c.id === l.category)!.minLengthM > 0));
  return lines.filter((line) => {
    const info = TRAIL_CATEGORIES.find((c) => c.id === line.category)!;
    return info.minLengthM === 0 || (lengths.get(line.id) ?? 0) >= info.minLengthM;
  });
}

/** Parses an Overpass answer into trail pieces. Exported for tests. */
export const parseTrails = parse;

export function trailsGeoJson(visibleCategories: Set<string>): FeatureCollection<LineString> {
  const features: FeatureCollection<LineString>['features'] = [];
  for (const line of applyLengthRule([...trailStore.items.values()])) {
    if (!visibleCategories.has(line.category)) continue;
    const info = TRAIL_CATEGORIES.find((c) => c.id === line.category)!;
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: line.coords },
      properties: {
        id: line.id,
        category: line.category,
        icon: `trail|${info.icon}`,
        hover: trailHover(line),
        name: line.name,
        website: line.website,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

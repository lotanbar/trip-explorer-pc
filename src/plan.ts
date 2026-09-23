/**
 * A plan: an ordered list of stops, saved as `trips/plans/<name>.txt`, one stop per line:
 * `lat, lon, name`. The plan being built lives in the settings file until Save.
 */

export interface PlanStop {
  /** Where the stop came from: `osm:<id>`, `mine:<path>` or `search:<photon id>`; used to toggle it. */
  key: string;
  lat: number;
  lon: number;
  /** Shown in the list and written to the file. */
  name: string;
  /** Used for the web search (the local name for OSM POIs); the display name when absent. */
  searchName?: string;
}

export interface PlanDraft {
  /** The file the plan was loaded from (Save overwrites it), or null for a new plan. */
  file: string | null;
  name: string;
  stops: PlanStop[];
}

/** A plan file in trips/plans/, read. */
export interface SavedPlan {
  name: string;
  path: string;
  stops: PlanStop[];
}

/** The key a saved plan's stop is ticked by in the Plans section (its place in the file). */
export const planStopKey = (path: string, index: number) => `${path}#${index}`;

export const EMPTY_PLAN: PlanDraft = { file: null, name: '', stops: [] };

/** Coordinates to five decimals (about a metre), like the example in the spec. */
export function planFileText(stops: readonly PlanStop[]): string {
  return stops.map((s) => `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}, ${s.name.replace(/[\r\n]+/g, ' ').trim()}`).join('\n') + (stops.length ? '\n' : '');
}

/** Reads a plan file back. Lines that do not start with two numbers are skipped; names may hold commas. */
export function parsePlanFile(text: string): PlanStop[] {
  const stops: PlanStop[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*(?:,\s*(.*))?$/.exec(line);
    if (!m) continue;
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) continue;
    const name = (m[3] ?? '').trim() || `${lat}, ${lon}`;
    stops.push({ key: `file:${stops.length}:${lat},${lon}`, lat, lon, name });
  }
  return stops;
}

/** Moves the stop at `from` to sit at `to` (indices in the list before the move). */
export function moveStop(stops: readonly PlanStop[], from: number, to: number): PlanStop[] {
  if (from < 0 || from >= stops.length || to < 0 || to >= stops.length) return [...stops];
  const out = [...stops];
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

/** Adds the stop when it is not in the plan, removes it when it is. */
export function toggleStop(stops: readonly PlanStop[], stop: PlanStop): PlanStop[] {
  const i = stops.findIndex((s) => s.key === stop.key);
  return i >= 0 ? stops.filter((_, j) => j !== i) : [...stops, stop];
}

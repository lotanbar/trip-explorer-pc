/**
 * A plan: an ordered list of stops, saved as `trips/plans/<name>.txt`, one stop per line:
 * `lat, lon, name`, with `, visited` at the end once the stop is ticked as visited (in the Plans
 * section here, or on the phone). The plan being built lives in the settings file until Save.
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
  /** Ticked as visited: the name is struck through. */
  visited?: boolean;
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
  return stops.map((s) => `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}, ${s.name.replace(/[\r\n]+/g, ' ').trim()}${s.visited ? VISITED_SUFFIX : ''}`).join('\n') + (stops.length ? '\n' : '');
}

const VISITED_SUFFIX = ', visited';
const VISITED_RE = /\s*,\s*visited\s*$/i;
const STOP_RE = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*(?:,\s*(.*))?$/;

/** Reads a plan file back. Lines that do not start with two numbers are skipped; names may hold commas. */
export function parsePlanFile(text: string): PlanStop[] {
  const stops: PlanStop[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = stopLine(line);
    if (!m) continue;
    const { lat, lon } = m;
    const visited = VISITED_RE.test(m.rest);
    const name = m.rest.replace(VISITED_RE, '').trim() || `${lat}, ${lon}`;
    stops.push({ key: `file:${stops.length}:${lat},${lon}`, lat, lon, name, ...(visited ? { visited } : {}) });
  }
  return stops;
}

/** A stop line's coordinates and the rest (the name, maybe with `, visited`); null when it is not a stop. */
function stopLine(line: string): { lat: number; lon: number; rest: string } | null {
  const m = STOP_RE.exec(line);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return null;
  return { lat, lon, rest: (m[3] ?? '').trim() };
}

/**
 * The plan file's text with the `index`-th stop (as parsePlanFile counts them) marked visited or not.
 * Only that line changes; everything else in the file is kept as it is.
 */
export function setVisitedInText(text: string, index: number, visited: boolean): string {
  const lines = text.split(/(?<=\n)/);
  let n = -1;
  for (let i = 0; i < lines.length; i++) {
    const body = lines[i].replace(/\r?\n$/, '');
    if (!body.trim() || !stopLine(body.trim())) continue;
    if (++n !== index) continue;
    const bare = body.replace(/\s+$/, '').replace(VISITED_RE, '');
    lines[i] = (visited ? bare + VISITED_SUFFIX : bare) + lines[i].slice(body.length);
    break;
  }
  return lines.join('');
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

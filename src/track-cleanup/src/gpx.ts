/**
 * Reads the Trip Explorer recording format: GPX 1.1, one <trk>, one <trkseg> per un-paused
 * stretch, each <trkpt> carrying lat, lon, <time> (UTC) and <extensions><accuracy> in metres.
 *
 * Deliberately not a full GPX parser: it scans for complete <trkpt>…</trkpt> elements with a
 * regular expression, so a half-written last point (the phone crashed mid-save) is simply not
 * matched and therefore ignored, and an unfinished file with no closing tags still reads.
 */

export interface RawPoint {
  lat: number;
  lon: number;
  /** Epoch milliseconds (UTC). */
  timeMs: number;
  /** Location-service accuracy estimate, metres. NaN when the point has none. */
  accuracyM: number;
}

/** One un-paused stretch of a recording. */
export type RawSegment = RawPoint[];

const TRKSEG_RE = /<trkseg\b[^>]*>([\s\S]*?)(?:<\/trkseg>|$)/g;
const TRKPT_RE = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g;
const ATTR_RE = /\b(lat|lon)\s*=\s*"([^"]+)"/g;
const TIME_RE = /<time>\s*([^<\s]+)\s*<\/time>/;
const ACC_RE = /<accuracy>\s*([^<\s]+)\s*<\/accuracy>/;

export function parseGpx(xml: string): RawSegment[] {
  const segments: RawSegment[] = [];
  for (const seg of xml.matchAll(TRKSEG_RE)) {
    const points = parsePoints(seg[1]);
    if (points.length > 0) segments.push(points);
  }
  // A file with points but no <trkseg> at all (not ours, but harmless to accept).
  if (segments.length === 0) {
    const points = parsePoints(xml);
    if (points.length > 0) segments.push(points);
  }
  return segments;
}

function parsePoints(chunk: string): RawSegment {
  const out: RawSegment = [];
  for (const m of chunk.matchAll(TRKPT_RE)) {
    let lat = NaN, lon = NaN;
    for (const a of m[1].matchAll(ATTR_RE)) {
      if (a[1] === 'lat') lat = Number(a[2]);
      else lon = Number(a[2]);
    }
    const timeMs = Date.parse(TIME_RE.exec(m[2])?.[1] ?? '');
    const accuracyM = Number(ACC_RE.exec(m[2])?.[1] ?? NaN);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(timeMs)) continue;
    out.push({ lat, lon, timeMs, accuracyM });
  }
  return out;
}

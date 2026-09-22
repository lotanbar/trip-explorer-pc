/** Geometry on a spherical Earth. All distances in metres, bearings in compass degrees. */

export const EARTH_RADIUS_M = 6_371_000;
const DEG = Math.PI / 180;

export interface LatLon {
  lat: number;
  lon: number;
}

export function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (bLat - aLat) * DEG;
  const dLon = (bLon - aLon) * DEG;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const h = s1 * s1 + Math.cos(aLat * DEG) * Math.cos(bLat * DEG) * s2 * s2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Initial compass bearing from a to b, in [0, 360). */
export function bearingDeg(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const φ1 = aLat * DEG;
  const φ2 = bLat * DEG;
  const dλ = (bLon - aLon) * DEG;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

/** Smallest absolute difference between two bearings, in [0, 180]. */
export function bearingDiffDeg(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * How far a travel bearing is from being parallel to a segment, in [0, 90].
 * 0 = travelling along the segment (either direction), 90 = crossing it.
 */
export function bearingPerpendicularity(travel: number, segment: number): number {
  const d = bearingDiffDeg(travel, segment);
  return d > 90 ? 180 - d : d;
}

export interface Projection {
  lat: number;
  lon: number;
  /** Fraction along the segment A→B, clamped to [0, 1]. */
  t: number;
  distMeters: number;
}

/**
 * Projects a point onto the segment A→B using a local flat approximation, which is accurate to
 * well under a centimetre for segments of a few hundred metres.
 */
export function projectOnSegment(
  pLat: number, pLon: number,
  aLat: number, aLon: number,
  bLat: number, bLon: number,
): Projection {
  const kx = Math.cos(aLat * DEG); // metres per degree of longitude, relative to latitude
  const ax = 0, ay = 0;
  const bx = (bLon - aLon) * kx, by = bLat - aLat;
  const px = (pLon - aLon) * kx, py = pLat - aLat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const fLat = aLat + t * (bLat - aLat);
  const fLon = aLon + t * (bLon - aLon);
  return { lat: fLat, lon: fLon, t, distMeters: haversineMeters(pLat, pLon, fLat, fLon) };
}

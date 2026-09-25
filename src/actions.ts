/**
 * What a click opens: the file manager for my POIs; the embedded browser (over the side panel)
 * for OSM POI searches and trail websites.
 */

import { openPath } from '@tauri-apps/plugin-opener';
import { openInBrowser } from './browser';

/** Google, in English; "<name> <place> info english short answer" gives the best (and briefest) AI overview. */
export function searchUrl(query: string): string {
  return `https://www.google.com/search?hl=en&q=${encodeURIComponent(query.trim())}`;
}

export const QUERY_SUFFIX = 'info english short answer';

export function poiSearchQuery(name: string, place: string): string {
  return `${name} ${place} ${QUERY_SUFFIX}`.replace(/\s+/g, ' ').trim();
}

const placeCache = new Map<string, string>();

/** The town of a point, from Nominatim (within its usage limits: only on click, cached). */
export async function lookupPlace(lat: number, lon: number): Promise<string> {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = placeCache.get(key);
  if (cached !== undefined) return cached;
  let place = '';
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&accept-language=en`,
      { signal: AbortSignal.timeout(10_000) },
    );
    const json = await res.json();
    place = placeFromAddress(json.address ?? {});
  } catch (e) {
    console.warn('Nominatim lookup failed', e);
  }
  placeCache.set(key, place);
  return place;
}

/** The town (or island / county) a POI belongs to, e.g. "Naxos"; the country is left out on purpose. */
export function placeFromAddress(a: Record<string, string>): string {
  const place = a.city || a.town || a.village || a.county || a.municipality || a.state || '';
  return place
    .replace(/^(municipality|municipal unit|district|regional unit) of\s+/i, '')
    .replace(/\s+(regional unit|municipality|municipal unit|district)$/i, '')
    .trim();
}

export async function openMyPoi(folder: string): Promise<void> {
  await openPath(folder);
}

/** Google search for the POI name plus its town (no country). Unnamed POIs do nothing. */
export async function openOsmPoi(name: string | null, lat: number, lon: number): Promise<void> {
  if (!name) return;
  const place = await lookupPlace(lat, lon);
  await openInBrowser(searchUrl(poiSearchQuery(name, place)), { lat, lon });
}

/** A place label on the base map (city, village, island ...): searched like a POI, by its local name. */
export async function openPlace(name: string | null, lat: number, lon: number): Promise<void> {
  if (!name) return;
  const place = await lookupPlace(lat, lon);
  const query = place && place.toLowerCase() !== name.toLowerCase() ? poiSearchQuery(name, place) : `${name} ${QUERY_SUFFIX}`;
  await openInBrowser(searchUrl(query), { lat, lon });
}

/** The route's website if it has one, otherwise a search for the name. Unnamed lines do nothing. */
export async function openTrail(name: string | null, website: string | null): Promise<void> {
  if (website) await openInBrowser(website);
  else if (name) await openInBrowser(searchUrl(`${name} ${QUERY_SUFFIX}`));
}

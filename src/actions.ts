/** What a click opens: file manager for my POIs, a web search for OSM POIs and trails. */

import { openPath, openUrl } from '@tauri-apps/plugin-opener';

export function searchUrl(query: string): string {
  return `https://duckduckgo.com/?q=${encodeURIComponent(query.trim())}`;
}

const placeCache = new Map<string, string>();

/** Town and country of a point, from Nominatim (within its usage limits: only on click, cached). */
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

export function placeFromAddress(a: Record<string, string>): string {
  const town = a.city || a.town || a.village || a.municipality || a.county || '';
  return [town, a.country || ''].filter(Boolean).join(' ');
}

export async function openMyPoi(folder: string): Promise<void> {
  await openPath(folder);
}

/** DuckDuckGo search for the POI name plus its town and country. Unnamed POIs do nothing. */
export async function openOsmPoi(name: string | null, lat: number, lon: number): Promise<void> {
  if (!name) return;
  const place = await lookupPlace(lat, lon);
  await openUrl(searchUrl(`${name} ${place}`));
}

/** The route's website if it has one, otherwise a search for the name. Unnamed lines do nothing. */
export async function openTrail(name: string | null, website: string | null): Promise<void> {
  if (website) await openUrl(website);
  else if (name) await openUrl(searchUrl(name));
}

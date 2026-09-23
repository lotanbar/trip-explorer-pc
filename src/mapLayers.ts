/**
 * The overlay sources and layers: recordings, my POIs, OSM POIs and trail lines, plus the marker
 * and line-pattern images they use. Layer order, bottom to top: trails, recordings, OSM POIs, my POIs,
 * ticked plan stops, search results.
 */

import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { ALL_GROUPS } from './groups';
import { buildLineIcon, buildMarker, POI_OUTLINE, TRAIL_COLOR } from './icons';
import { OSM_POI_MIN_ZOOM } from './osmPois';
import { TRAIL_CATEGORIES, TRAILS_MIN_ZOOM } from './trails';

export const SRC_TRAILS = 'trails';
export const SRC_RECORDINGS = 'recordings';
export const SRC_OSM_POIS = 'osm-pois';
export const SRC_MY_POIS = 'my-pois';
export const SRC_SEARCH = 'search-results';
export const SRC_PLANS = 'plans';
/** The search-result pin: the app's blue, a plain dot in the head. */
export const SEARCH_COLOR = '#2196F3';
export const SEARCH_ICON = 'search|result';

export const LAYERS = {
  trails: 'trails-lines',
  trailsIcons: 'trails-icons',
  recordings: 'recordings-lines',
  recordingsIncomplete: 'recordings-incomplete',
  osmPois: 'osm-poi-symbols',
  myPois: 'my-poi-symbols',
  myPoiLabels: 'my-poi-labels',
  plans: 'plan-stops',
  planLabels: 'plan-labels',
  search: 'search-symbols',
  searchLabels: 'search-labels',
};

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

export async function addMarkerImages(map: MapLibreMap): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const group of ALL_GROUPS) {
    jobs.push(buildMarker(group.icon, group.color, POI_OUTLINE, 'squircle').then((img) => { map.addImage(`mine|${group.id}`, img.data, { pixelRatio: img.pixelRatio }); }));
    jobs.push(buildMarker(group.icon, group.color, POI_OUTLINE, 'circle').then((img) => { map.addImage(`osm|${group.id}`, img.data, { pixelRatio: img.pixelRatio }); }));
  }
  jobs.push(buildMarker('marker', SEARCH_COLOR, POI_OUTLINE, 'circle').then((img) => { map.addImage(SEARCH_ICON, img.data, { pixelRatio: img.pixelRatio }); }));
  for (const cat of TRAIL_CATEGORIES) {
    jobs.push(buildLineIcon(cat.icon).then((img) => { map.addImage(`trail|${cat.icon}`, img.data, { pixelRatio: img.pixelRatio }); }));
  }
  await Promise.all(jobs);
}

export function addOverlayLayers(map: MapLibreMap): void {
  for (const id of [SRC_TRAILS, SRC_RECORDINGS, SRC_OSM_POIS, SRC_MY_POIS, SRC_PLANS, SRC_SEARCH]) {
    map.addSource(id, { type: 'geojson', data: EMPTY });
  }
  // Route lines sit under the base map's labels (place names stay readable); icons and markers on top.
  const underLabels = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;

  // ── Trails: plain light grey lines, told apart only by the icon repeated along them ──
  map.addLayer({
    id: LAYERS.trails,
    type: 'line',
    source: SRC_TRAILS,
    minzoom: TRAILS_MIN_ZOOM,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': TRAIL_COLOR, 'line-width': 2, 'line-opacity': 0.9 },
  }, underLabels);
  map.addLayer({
    id: LAYERS.trailsIcons,
    type: 'symbol',
    source: SRC_TRAILS,
    minzoom: TRAILS_MIN_ZOOM,
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 250,
      'icon-image': ['get', 'icon'],
      'icon-rotation-alignment': 'viewport',
      'icon-padding': 40,
      'icon-allow-overlap': false,
      'icon-ignore-placement': false,
    },
  });

  // ── Recordings: one colour per trip; dashed when incomplete ──
  map.addLayer({
    id: LAYERS.recordings,
    type: 'line',
    source: SRC_RECORDINGS,
    filter: ['!', ['get', 'incomplete']],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 4 },
  }, underLabels);
  map.addLayer({
    id: LAYERS.recordingsIncomplete,
    type: 'line',
    source: SRC_RECORDINGS,
    filter: ['get', 'incomplete'],
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 4, 'line-dasharray': [2, 2] },
  }, underLabels);

  // ── Markers ──
  map.addLayer({
    id: LAYERS.osmPois,
    type: 'symbol',
    source: SRC_OSM_POIS,
    minzoom: OSM_POI_MIN_ZOOM,
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-anchor': 'bottom',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
  map.addLayer({
    id: LAYERS.myPois,
    type: 'symbol',
    source: SRC_MY_POIS,
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-anchor': 'bottom',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
  map.addLayer({
    id: LAYERS.myPoiLabels,
    type: 'symbol',
    source: SRC_MY_POIS,
    minzoom: 11,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 13,
      'text-anchor': 'top',
      'text-offset': [0, 0.4],
    },
    paint: { 'text-color': '#FFFFFF', 'text-halo-color': '#000000', 'text-halo-width': 1 },
  });

  // ── Ticked plan stops: dots in the plan's colour ──
  map.addLayer({
    id: LAYERS.plans,
    type: 'circle',
    source: SRC_PLANS,
    paint: {
      'circle-radius': 7,
      'circle-color': ['get', 'color'],
      'circle-stroke-color': '#FFFFFF',
      'circle-stroke-width': 1.5,
    },
  });
  map.addLayer({
    id: LAYERS.planLabels,
    type: 'symbol',
    source: SRC_PLANS,
    minzoom: 11,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 13,
      'text-anchor': 'top',
      'text-offset': [0, 0.8],
    },
    paint: { 'text-color': '#FFFFFF', 'text-halo-color': '#000000', 'text-halo-width': 1 },
  });

  // ── Search results: blue pins, on top of everything, while the search window is open ──
  map.addLayer({
    id: LAYERS.search,
    type: 'symbol',
    source: SRC_SEARCH,
    layout: {
      'icon-image': SEARCH_ICON,
      'icon-anchor': 'bottom',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
  map.addLayer({
    id: LAYERS.searchLabels,
    type: 'symbol',
    source: SRC_SEARCH,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 13,
      'text-anchor': 'top',
      'text-offset': [0, 0.4],
    },
    paint: { 'text-color': '#FFFFFF', 'text-halo-color': '#000000', 'text-halo-width': 1 },
  });
}

/** The data last given to each source (for the dev hook and tests). */
export const lastData = new Map<string, FeatureCollection>();

export function setData(map: MapLibreMap, sourceId: string, data: FeatureCollection): void {
  lastData.set(sourceId, data);
  const source = map.getSource(sourceId) as GeoJSONSource | undefined;
  source?.setData(data);
}

/**
 * The overlay sources and layers: recordings and my POIs, plus the marker images they use.
 * Layer order, bottom to top: base map, hillshade, recordings, base-map labels, my POIs.
 */

import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { CATEGORIES } from './categories';
import { buildMarker, POI_OUTLINE } from './icons';

export const SRC_RECORDINGS = 'recordings';
export const SRC_MY_POIS = 'my-pois';

export const LAYERS = {
  recordings: 'recordings-lines',
  recordingsIncomplete: 'recordings-incomplete',
  myPois: 'my-poi-symbols',
};

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

/** One marker image per category, named `poi|<key>`. */
export async function addMarkerImages(map: MapLibreMap): Promise<void> {
  await Promise.all(CATEGORIES.map((cat) =>
    buildMarker(cat.icon, cat.color, POI_OUTLINE).then((img) => { map.addImage(`poi|${cat.key}`, img.data, { pixelRatio: img.pixelRatio }); })));
}

export function addOverlayLayers(map: MapLibreMap): void {
  for (const id of [SRC_RECORDINGS, SRC_MY_POIS]) {
    map.addSource(id, { type: 'geojson', data: EMPTY });
  }
  // Route lines sit under the base map's labels (place names stay readable); markers on top.
  const underLabels = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;

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

  // ── My POIs ──
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
}

/** The data last given to each source (for the dev hook and tests). */
export const lastData = new Map<string, FeatureCollection>();

export function setData(map: MapLibreMap, sourceId: string, data: FeatureCollection): void {
  lastData.set(sourceId, data);
  const source = map.getSource(sourceId) as GeoJSONSource | undefined;
  source?.setData(data);
}

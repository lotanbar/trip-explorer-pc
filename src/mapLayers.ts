/**
 * The overlay sources and layers: recordings, my POIs, OSM POIs and trail lines, plus the marker
 * and line-pattern images they use. Layer order, bottom to top: trails, recordings, OSM POIs, my POIs.
 */

import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { ALL_GROUPS } from './groups';
import { buildBar, buildLineIcon, buildMarker, MY_POI_OUTLINE, OSM_POI_OUTLINE, TRAIL_COLOR } from './icons';
import { OSM_POI_MIN_ZOOM } from './osmPois';
import { TRAIL_CATEGORIES, TRAILS_MIN_ZOOM } from './trails';

export const SRC_TRAILS = 'trails';
export const SRC_RECORDINGS = 'recordings';
export const SRC_OSM_POIS = 'osm-pois';
export const SRC_MY_POIS = 'my-pois';

export const LAYERS = {
  trailsDotted: 'trails-dotted',
  trailsIcons: 'trails-icons',
  trailsCable: 'trails-cable',
  trailsCableBars: 'trails-cable-bars',
  trailsRail: 'trails-rail',
  trailsRailTicks: 'trails-rail-ticks',
  recordings: 'recordings-lines',
  recordingsIncomplete: 'recordings-incomplete',
  osmPois: 'osm-poi-symbols',
  myPois: 'my-poi-symbols',
  myPoiLabels: 'my-poi-labels',
};

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

export async function addMarkerImages(map: MapLibreMap): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const group of ALL_GROUPS) {
    jobs.push(buildMarker(group.icon, group.color, MY_POI_OUTLINE).then((img) => { map.addImage(`mine|${group.id}`, img.data, { pixelRatio: img.pixelRatio }); }));
    jobs.push(buildMarker(group.icon, group.color, OSM_POI_OUTLINE).then((img) => { map.addImage(`osm|${group.id}`, img.data, { pixelRatio: img.pixelRatio }); }));
  }
  for (const cat of TRAIL_CATEGORIES) {
    if (cat.icon) jobs.push(buildLineIcon(cat.icon).then((img) => { map.addImage(`trail|${cat.icon}`, img.data, { pixelRatio: img.pixelRatio }); }));
  }
  const bar = buildBar(12);
  map.addImage('trail|crossbar', bar.data, { pixelRatio: bar.pixelRatio });
  const tick = buildBar(6);
  map.addImage('trail|tick', tick.data, { pixelRatio: tick.pixelRatio });
  await Promise.all(jobs);
}

export function addOverlayLayers(map: MapLibreMap): void {
  for (const id of [SRC_TRAILS, SRC_RECORDINGS, SRC_OSM_POIS, SRC_MY_POIS]) {
    map.addSource(id, { type: 'geojson', data: EMPTY });
  }

  // ── Trails: light grey, pattern per category ──
  map.addLayer({
    id: LAYERS.trailsDotted,
    type: 'line',
    source: SRC_TRAILS,
    minzoom: TRAILS_MIN_ZOOM,
    filter: ['==', ['get', 'pattern'], 'dotted'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': TRAIL_COLOR, 'line-width': 3, 'line-dasharray': [0, 2.4] },
  });
  map.addLayer({
    id: LAYERS.trailsIcons,
    type: 'symbol',
    source: SRC_TRAILS,
    minzoom: TRAILS_MIN_ZOOM,
    filter: ['==', ['get', 'pattern'], 'dotted'],
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 200,
      'icon-image': ['get', 'icon'],
      'icon-rotation-alignment': 'viewport',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
  map.addLayer({
    id: LAYERS.trailsCable,
    type: 'line',
    source: SRC_TRAILS,
    minzoom: TRAILS_MIN_ZOOM,
    filter: ['==', ['get', 'pattern'], 'cable'],
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-color': TRAIL_COLOR, 'line-width': 1.2 },
  });
  map.addLayer({
    id: LAYERS.trailsCableBars,
    type: 'symbol',
    source: SRC_TRAILS,
    minzoom: TRAILS_MIN_ZOOM,
    filter: ['==', ['get', 'pattern'], 'cable'],
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 24,
      'icon-image': 'trail|crossbar',
      'icon-rotation-alignment': 'map',
      'icon-pitch-alignment': 'map',
      'icon-keep-upright': false,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
  map.addLayer({
    id: LAYERS.trailsRail,
    type: 'line',
    source: SRC_TRAILS,
    minzoom: TRAILS_MIN_ZOOM,
    filter: ['==', ['get', 'pattern'], 'rail'],
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-color': TRAIL_COLOR, 'line-width': 2 },
  });
  map.addLayer({
    id: LAYERS.trailsRailTicks,
    type: 'symbol',
    source: SRC_TRAILS,
    minzoom: TRAILS_MIN_ZOOM,
    filter: ['==', ['get', 'pattern'], 'rail'],
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 9,
      'icon-image': 'trail|tick',
      'icon-rotation-alignment': 'map',
      'icon-pitch-alignment': 'map',
      'icon-keep-upright': false,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
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
  });
  map.addLayer({
    id: LAYERS.recordingsIncomplete,
    type: 'line',
    source: SRC_RECORDINGS,
    filter: ['get', 'incomplete'],
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 4, 'line-dasharray': [2, 2] },
  });

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
}

export function setData(map: MapLibreMap, sourceId: string, data: FeatureCollection): void {
  const source = map.getSource(sourceId) as GeoJSONSource | undefined;
  source?.setData(data);
}

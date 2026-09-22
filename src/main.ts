import { Map as MapLibreMap, NavigationControl, ScaleControl, type MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { openPath, openUrl } from '@tauri-apps/plugin-opener';
import type { FeatureCollection, Point } from 'geojson';
import { scanTrips, cacheEvict, CACHE_TTL_MS, type TripInfo, type PoiInfo } from './backend';
import { groupForFile } from './groups';
import { addMarkerImages, addOverlayLayers, LAYERS, setData, SRC_MY_POIS, SRC_OSM_POIS, SRC_RECORDINGS, SRC_TRAILS } from './mapLayers';
import { loadMapStyle } from './mapStyle';
import { osmPoiStore, osmPoisGeoJson, OSM_POI_MIN_ZOOM } from './osmPois';
import { atLeastKm, expanded, type Bounds } from './overpass';
import { forgetRecordings, loadRecording, recordingFeature } from './recordings';
import { loadSettings, saveSettings, settings } from './settings';
import { Sidebar } from './sidebar';
import { Tooltip } from './tooltip';
import { GROUPS, NO_GROUP } from './groups';
import { TRAIL_CATEGORIES, TRAILS_MIN_AREA_KM, TRAILS_MIN_ZOOM, trailStore, trailsGeoJson } from './trails';
import './styles.css';

const DEFAULT_CENTER: [number, number] = [25.0, 37.3];
const DEFAULT_ZOOM = 7;

async function main(): Promise<void> {
  await loadSettings();
  const statusMessages = new Map<string, string>();
  const sidebar = new Sidebar(document.getElementById('sidebar')!, {
    onRootChanged: () => rescan(),
    onRefresh: () => rescan(),
    onCheckedChanged: () => renderChecked(),
    onGroupsChanged: () => renderOsmPois(),
    onTrailsChanged: () => renderTrails(),
  });
  const setStatus = (key: string, message: string | null) => {
    if (message) statusMessages.set(key, message);
    else statusMessages.delete(key);
    sidebar.setStatus([...statusMessages.values()].join(' · ') || null);
  };

  for (const ns of ['osm-pois', 'trails', 'roads']) cacheEvict(ns, CACHE_TTL_MS).catch(() => undefined);

  let style;
  try {
    style = await loadMapStyle();
  } catch (e) {
    setStatus('map', `Map style unavailable: ${(e as Error).message}`);
    style = { version: 8 as const, sources: {}, layers: [{ id: 'bg', type: 'background' as const, paint: { 'background-color': '#0c0c0c' } }] };
  }

  const mapEl = document.getElementById('map')!;
  const map = new MapLibreMap({
    container: mapEl,
    style,
    center: settings.camera ? [settings.camera.lng, settings.camera.lat] : DEFAULT_CENTER,
    zoom: settings.camera?.zoom ?? DEFAULT_ZOOM,
    pitch: 0,
    maxPitch: 0,
    dragRotate: false,
    attributionControl: { compact: true },
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-right');
  const tooltip = new Tooltip(mapEl);

  // The base style references a few sprite images it does not ship; blank them instead of warning.
  map.on('styleimagemissing', (e: { id: string }) => {
    if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
  });
  await new Promise<void>((resolve) => map.once('load', () => resolve()));
  await addMarkerImages(map);
  addOverlayLayers(map);

  // ── Trips and the checked items ──

  let trips: TripInfo[] = [];

  async function rescan(): Promise<void> {
    if (!settings.root) {
      sidebar.setTrips([]);
      return;
    }
    try {
      trips = await scanTrips(settings.root);
      setStatus('scan', null);
    } catch (e) {
      trips = [];
      setStatus('scan', (e as Error).toString());
    }
    forgetRecordings();
    sidebar.setTrips(trips);
    renderChecked();
  }

  let checkedGeneration = 0;

  function renderChecked(): void {
    const gen = ++checkedGeneration;
    const checked = new Set(settings.checked);

    const poiFeatures: FeatureCollection<Point>['features'] = [];
    for (const trip of trips) {
      for (const poi of trip.pois) {
        if (!checked.has(poi.path)) continue;
        const group = groupForFile(poi.group);
        poiFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [poi.lon, poi.lat] },
          properties: {
            path: poi.path,
            name: poi.name,
            icon: `mine|${group.id}`,
            hover: `${poi.name}\n${poi.datetime}\n${trip.name}`,
          },
        });
      }
    }
    setData(map, SRC_MY_POIS, { type: 'FeatureCollection', features: poiFeatures });

    const wanted = trips.flatMap((trip) => trip.recordings.filter((r) => checked.has(r.path)).map((r) => ({ r, trip })));
    const recordingsData: FeatureCollection = { type: 'FeatureCollection', features: [] };
    setData(map, SRC_RECORDINGS, recordingsData);
    for (const { r, trip } of wanted) {
      loadRecording(r, trip, (s) => setStatus(`rec:${r.path}`, s))
        .then((loaded) => {
          if (gen !== checkedGeneration) return;
          recordingsData.features.push(recordingFeature(loaded));
          setData(map, SRC_RECORDINGS, recordingsData);
        })
        .catch((e) => setStatus(`rec:${r.path}`, `${r.name}: ${(e as Error).message}`));
    }
  }

  // ── OSM POIs and trails for the viewport ──

  function viewport(): Bounds {
    const b = map.getBounds();
    return { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
  }

  function visibleGroups(): Set<string> {
    const hidden = new Set(settings.groupsHidden);
    return new Set([...GROUPS, NO_GROUP].filter((g) => !hidden.has(g.id)).map((g) => g.id));
  }

  function renderOsmPois(): void {
    if (!settings.osmPois || map.getZoom() < OSM_POI_MIN_ZOOM) {
      setData(map, SRC_OSM_POIS, { type: 'FeatureCollection', features: [] });
      return;
    }
    setData(map, SRC_OSM_POIS, osmPoisGeoJson(visibleGroups()));
  }

  function visibleTrailCategories(): Set<string> {
    const hidden = new Set(settings.trailsHidden);
    return new Set(TRAIL_CATEGORIES.filter((c) => !hidden.has(c.id)).map((c) => c.id));
  }

  function renderTrails(): void {
    if (!settings.trails || map.getZoom() < TRAILS_MIN_ZOOM) {
      setData(map, SRC_TRAILS, { type: 'FeatureCollection', features: [] });
      return;
    }
    setData(map, SRC_TRAILS, trailsGeoJson(visibleTrailCategories()));
  }

  let fetchTimer: number | undefined;

  function scheduleFetch(): void {
    window.clearTimeout(fetchTimer);
    fetchTimer = window.setTimeout(() => void fetchViewport(), 300);
  }

  async function fetchViewport(): Promise<void> {
    const zoom = map.getZoom();
    const view = viewport();
    const jobs: Promise<void>[] = [];
    if (settings.osmPois && zoom >= OSM_POI_MIN_ZOOM) {
      jobs.push(osmPoiStore.ensure(expanded(view, 0.2)).then(() => renderOsmPois()));
    }
    if (settings.trails && zoom >= TRAILS_MIN_ZOOM) {
      jobs.push(trailStore.ensure(atLeastKm(expanded(view, 0.2), TRAILS_MIN_AREA_KM)).then(() => renderTrails()));
    }
    await Promise.all(jobs);
  }

  osmPoiStore['opt'].onStatus = (m) => setStatus('osm-pois', m);
  trailStore['opt'].onStatus = (m) => setStatus('trails', m);

  map.on('moveend', () => {
    const c = map.getCenter();
    settings.camera = { lng: c.lng, lat: c.lat, zoom: map.getZoom() };
    saveSettings();
    renderOsmPois();
    renderTrails();
    scheduleFetch();
  });

  // ── Hover and click ──

  const hoverLayers = [LAYERS.myPois, LAYERS.osmPois, LAYERS.recordings, LAYERS.recordingsIncomplete, LAYERS.trailsDotted, LAYERS.trailsCable, LAYERS.trailsRail];

  map.on('mousemove', (e: MapMouseEvent) => {
    const features = map.queryRenderedFeatures(
      [[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]],
      { layers: hoverLayers },
    );
    const top = features[0];
    if (!top) {
      tooltip.hide();
      map.getCanvas().style.cursor = '';
      return;
    }
    let text = String(top.properties?.hover ?? '');
    if (top.layer.id === LAYERS.recordingsIncomplete) text = text.replace('\n', ' (incomplete)\n');
    tooltip.show(text, e.point.x, e.point.y);
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseout', () => tooltip.hide());

  map.on('click', (e: MapMouseEvent) => {
    const features = map.queryRenderedFeatures(
      [[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]],
      { layers: hoverLayers },
    );
    const top = features[0];
    if (!top) return;
    const props = top.properties ?? {};
    switch (top.layer.id) {
      case LAYERS.myPois:
        openPath(String(props.path)).catch((err) => setStatus('open', `Could not open folder: ${err}`));
        break;
      case LAYERS.osmPois:
        if (props.name) void searchOsmPoi(String(props.name), (top.geometry as Point).coordinates);
        break;
      case LAYERS.trailsDotted:
      case LAYERS.trailsCable:
      case LAYERS.trailsRail:
        if (props.website) openUrl(String(props.website)).catch(() => undefined);
        else if (props.name) openUrl(`https://duckduckgo.com/?q=${encodeURIComponent(String(props.name))}`).catch(() => undefined);
        break;
    }
  });

  const townCache = new Map<string, string>();

  /** DuckDuckGo search for the POI name plus its town and country (Nominatim reverse lookup). */
  async function searchOsmPoi(name: string, [lon, lat]: number[]): Promise<void> {
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    let place = townCache.get(key);
    if (place === undefined) {
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&accept-language=en`);
        const json = await res.json();
        const a = json.address ?? {};
        place = [a.city || a.town || a.village || a.municipality || a.county || '', a.country || ''].filter(Boolean).join(' ');
      } catch {
        place = '';
      }
      townCache.set(key, place);
    }
    await openUrl(`https://duckduckgo.com/?q=${encodeURIComponent(`${name} ${place}`.trim())}`).catch(() => undefined);
  }

  await rescan();
  scheduleFetch();
}

void main().catch((e) => {
  console.error(e);
  document.getElementById('sidebar')!.insertAdjacentHTML('beforeend', `<div class="status error">${String(e)}</div>`);
});

export type { PoiInfo };

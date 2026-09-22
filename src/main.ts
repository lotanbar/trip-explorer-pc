import { Map as MapLibreMap, type MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { openMyPoi, openOsmPoi, openTrail } from './actions';
import { closeBrowser } from './browser';
import type { FeatureCollection, Point } from 'geojson';
import { scanTrips, cacheEvict, CACHE_TTL_MS, type TripInfo } from './backend';
import { groupForFile } from './groups';
import { addMarkerImages, addOverlayLayers, LAYERS, lastData, setData, SRC_MY_POIS, SRC_OSM_POIS, SRC_RECORDINGS, SRC_TRAILS } from './mapLayers';
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

  for (const ns of ['osm-pois-v2', 'trails', 'roads']) cacheEvict(ns, CACHE_TTL_MS).catch(() => undefined);

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
    attributionControl: false, // credited in the sidebar footer instead
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  const tooltip = new Tooltip(mapEl);
  if (import.meta.env.DEV) (window as unknown as { __te: unknown }).__te = { map, settings, lastData, actions: { openMyPoi, openOsmPoi, openTrail } };

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
    setData(map, SRC_OSM_POIS, osmPoisGeoJson(visibleGroups(), map.getZoom()));
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
    tooltip.show(String(top.properties?.hover ?? ''), e.point.x, e.point.y);
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseout', () => tooltip.hide());

  map.on('click', (e: MapMouseEvent) => {
    const features = map.queryRenderedFeatures(
      [[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]],
      { layers: hoverLayers },
    );
    const top = features[0];
    const report = (err: unknown) => setStatus('open', `Could not open: ${err}`);
    if (!top) {
      // An empty spot on the map: the embedded browser gives the panel back.
      closeBrowser().catch(report);
      return;
    }
    const props = top.properties ?? {};
    switch (top.layer.id) {
      case LAYERS.myPois:
        openMyPoi(String(props.path)).catch(report);
        break;
      case LAYERS.osmPois: {
        const [lon, lat] = (top.geometry as Point).coordinates;
        openOsmPoi(props.name ? String(props.name) : null, lat, lon).catch(report);
        break;
      }
      case LAYERS.trailsDotted:
      case LAYERS.trailsCable:
      case LAYERS.trailsRail:
        openTrail(props.name ? String(props.name) : null, props.website ? String(props.website) : null).catch(report);
        break;
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeBrowser().catch((err) => setStatus('open', `Could not close: ${err}`));
    // WebView2 zoom control is on so touchpad pinch reaches the map; keep the page itself unscaled.
    if (e.ctrlKey && ['+', '-', '=', '0'].includes(e.key)) e.preventDefault();
  });
  // A touchpad pinch arrives as ctrl+wheel at whatever sits under the mouse pointer. Wherever it
  // lands, it zooms the map (around the map centre when the pointer is off the map), never the page.
  window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || mapEl.contains(e.target as Node)) return;
    e.preventDefault();
    const r = mapEl.getBoundingClientRect();
    map.getCanvas().dispatchEvent(new WheelEvent('wheel', {
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      ctrlKey: true,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      bubbles: true,
      cancelable: true,
    }));
  }, { passive: false });
  // Pinch and mouse wheel both zoom more per gesture than MapLibre's defaults.
  map.scrollZoom.setZoomRate(1 / 40);
  map.scrollZoom.setWheelZoomRate(1 / 200);

  await rescan();
  scheduleFetch();
}

void main().catch((e) => {
  console.error(e);
  document.getElementById('sidebar')!.insertAdjacentHTML('beforeend', `<div class="status error">${String(e)}</div>`);
});


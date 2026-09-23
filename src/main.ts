import { Map as MapLibreMap, setWorkerUrl, type MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre 6 loads its worker from a file next to its own bundle. Vite does not emit that file in
// a production build (the map then never loads), so Vite bundles the worker here and its URL is handed over.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { openMyPoi, openOsmPoi, openPlace, openTrail } from './actions';
import { invoke } from '@tauri-apps/api/core';
import { browserPage, closeBrowser, onBrowserChange, openInBrowser } from './browser';
import { closePanel, initPanel } from './panel';
import { installMapGestures } from './gestures';
import type { FeatureCollection, Point } from 'geojson';
import { scanTrips, cacheEvict, listPlans, readText, CACHE_TTL_MS, type TripInfo } from './backend';
import { groupForFile } from './groups';
import { addMarkerImages, addOverlayLayers, LAYERS, lastData, setData, SRC_MY_POIS, SRC_OSM_POIS, SRC_PLANS, SRC_RECORDINGS, SRC_SEARCH, SRC_TRAILS } from './mapLayers';
import { loadMapStyle, placeLabelLayerIds } from './mapStyle';
import { osmPoiStore, osmPoisGeoJson, OSM_POI_MIN_ZOOM } from './osmPois';
import { atLeastKm, expanded, type Bounds } from './overpass';
import { forgetRecordings, loadRecording, recordingFeature, tripColor } from './recordings';
import { ScreenHistory, type Screen } from './screens';
import { loadSettings, saveSettings, settings } from './settings';
import { Sidebar } from './sidebar';
import { resultStop, SearchWindow } from './searchWindow';
import { resultKey, type SearchResult } from './photon';
import { parsePlanFile, planStopKey, type PlanStop, type SavedPlan } from './plan';
import { Tooltip } from './tooltip';
import { GROUPS, NO_GROUP } from './groups';
import { TRAIL_CATEGORIES, TRAILS_MIN_AREA_KM, TRAILS_MIN_ZOOM, trailStore, trailsGeoJson } from './trails';
import './styles.css';

const DEFAULT_CENTER: [number, number] = [25.0, 37.3];
const DEFAULT_ZOOM = 7;

async function main(): Promise<void> {
  setWorkerUrl(maplibreWorkerUrl);
  await loadSettings();
  const statusMessages = new Map<string, string>();
  initPanel();
  const sidebar = new Sidebar(document.getElementById('sidebar')!, {
    onClose: () => {
      closeBrowser().catch(() => undefined);
      closePanel();
    },
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

  for (const ns of ['osm-pois-v7', 'trails-v2', 'roads']) cacheEvict(ns, CACHE_TTL_MS).catch(() => undefined);

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
    attributionControl: false, // a personal app: no credit line
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  const tooltip = new Tooltip(mapEl);
  if (import.meta.env.DEV) (window as unknown as { __te: unknown }).__te = { map, settings, lastData, actions: { openMyPoi, openOsmPoi, openPlace, openTrail }, search: () => search };

  // The base style references a few sprite images it does not ship; blank them instead of warning.
  map.on('styleimagemissing', (e: { id: string }) => {
    if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
  });
  await new Promise<void>((resolve) => map.once('load', () => resolve()));
  // A page reload (dev) leaves the embedded browser shown over a panel that no longer knows about it.
  invoke('browser_close').catch(() => undefined);
  await addMarkerImages(map);
  addOverlayLayers(map);

  // ── Search and plan ──

  /** A brief zoom-out / zoom-in move to the point (MapLibre's flyTo arc). */
  const flyTo = (lat: number, lon: number) => map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 14), speed: 1.6 });

  // ── The side panel's screen history (Alt+Left / Alt+Right) ──

  const screens = new ScreenHistory();
  const currentScreen = (): Screen => {
    const page = browserPage();
    if (page) return { kind: 'browser', ...page };
    return search.isOpen ? { kind: 'search', plan: search.shownFile } : { kind: 'controls' };
  };
  let noteTimer: number | undefined;
  /** The panel may show another screen now: recorded once the change has settled (a browser closing as the window opens is one step). */
  const noteScreen = () => {
    window.clearTimeout(noteTimer);
    noteTimer = window.setTimeout(() => screens.record(currentScreen()), 0);
  };
  onBrowserChange(noteScreen);

  /** Brings a screen back; false when that was refused (unsaved edits kept) or failed. */
  async function showScreen(screen: Screen): Promise<boolean> {
    switch (screen.kind) {
      case 'controls':
        await closeBrowser();
        return search.requestClose();
      case 'search':
        await closeBrowser();
        return search.showPlan(screen.plan);
      case 'browser': {
        const at = screen.lat !== undefined && screen.lon !== undefined ? { lat: screen.lat, lon: screen.lon } : undefined;
        await openInBrowser(screen.url, at, false);
        if (at) flyTo(at.lat, at.lon);
        return true;
      }
    }
  }

  const search = new SearchWindow(document.getElementById('sidebar')!, {
    near: () => {
      const c = map.getCenter();
      return { lat: c.lat, lon: c.lng };
    },
    myPois: () => trips.flatMap((t) => t.pois.map((p) => ({ name: p.name, path: p.path, lat: p.lat, lon: p.lon, trip: t.name }))),
    flyTo,
    openStop: (stop: PlanStop) => {
      flyTo(stop.lat, stop.lon);
      const report = (err: unknown) => setStatus('open', `Could not open: ${err}`);
      // One of my POIs opens as a click on its marker would; anything else gets the web search.
      if (stop.key.startsWith('mine:')) openMyPoi(stop.key.slice('mine:'.length)).catch(report);
      else openOsmPoi(stop.searchName ?? stop.name, stop.lat, stop.lon).catch(report);
    },
    onResults: (results: SearchResult[]) => {
      // My POIs already on the map (ticked) keep their own marker; the rest get a search marker.
      const checked = new Set(settings.checked);
      setData(map, SRC_SEARCH, {
        type: 'FeatureCollection',
        features: results.filter((r) => !(r.mine && checked.has(r.id))).map((r) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
          properties: { key: resultKey(r), name: r.name, searchName: r.mine ? '' : r.name, path: r.mine ? r.id : '', hover: `${r.name}\n${[r.kind, r.place].filter(Boolean).join(' · ')}` },
        })),
      });
    },
    onPlanChanged: () => undefined,
    onScreenChanged: noteScreen,
    onPlanSaved: () => void loadPlans(),
    // The window takes the panel over: the embedded browser, which sits on top of the panel, goes
    // (a stop pressed in the plan opens it again, see openStop).
    reveal: () => closeBrowser().catch(() => undefined),
    setStatus: (m) => setStatus('search', m),
  });

  noteScreen();

  // ── Trips, plans and the checked items ──

  let trips: TripInfo[] = [];
  let plans: SavedPlan[] = [];

  async function loadPlans(): Promise<void> {
    plans = [];
    if (settings.root) {
      try {
        const files = await listPlans(settings.root);
        plans = await Promise.all(files.map(async (f) => ({ name: f.name, path: f.path, stops: parsePlanFile(await readText(f.path)) })));
        setStatus('plans', null);
      } catch (e) {
        setStatus('plans', String(e));
      }
    }
    sidebar.setPlans(plans);
    renderPlans();
  }

  /** The ticked stops of the saved plans: dots in the plan's colour (a plan is a group of places, not a route: no numbers). */
  function renderPlans(): void {
    const checked = new Set(settings.checked);
    const features: FeatureCollection<Point>['features'] = [];
    for (const plan of plans) {
      const color = tripColor(plan.name);
      plan.stops.forEach((stop, i) => {
        if (!checked.has(planStopKey(plan.path, i))) return;
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
          properties: { color, name: stop.name, hover: `${stop.name}\n${plan.name}` },
        });
      });
    }
    setData(map, SRC_PLANS, { type: 'FeatureCollection', features });
  }

  async function rescan(): Promise<void> {
    void loadPlans();
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
    renderPlans();

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

  const placeLayers = placeLabelLayerIds(map.getStyle());
  const hoverLayers = [LAYERS.search, LAYERS.plans, LAYERS.myPois, LAYERS.osmPois, LAYERS.recordings, LAYERS.recordingsIncomplete, LAYERS.trails, ...placeLayers];
  const isPlace = (layerId: string) => placeLayers.includes(layerId);
  /** Local name of a base-map place label (what the search uses); English shown on hover. */
  const placeLocalName = (props: Record<string, unknown>) => (props.name ?? props['name:latin'] ?? null) as string | null;
  const placeHover = (props: Record<string, unknown>) =>
    String(props['name:en'] ?? props['name:latin'] ?? props.name ?? '');

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
    const props = top.properties ?? {};
    tooltip.show(isPlace(top.layer.id) ? placeHover(props) : String(props.hover ?? ''), e.point.x, e.point.y);
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
      // An empty spot on the map: back to the panel's controls (the browser and the search window go).
      closeBrowser().catch(report);
      void search.requestClose();
      return;
    }
    const props = top.properties ?? {};
    switch (top.layer.id) {
      case LAYERS.myPois:
        openMyPoi(String(props.path)).catch(report);
        break;
      case LAYERS.search:
      case LAYERS.osmPois: {
        const [lon, lat] = (top.geometry as Point).coordinates;
        if (props.path) openMyPoi(String(props.path)).catch(report);
        else openOsmPoi(props.searchName ? String(props.searchName) : null, lat, lon).catch(report);
        break;
      }
      case LAYERS.plans: {
        const [lon, lat] = (top.geometry as Point).coordinates;
        openOsmPoi(String(props.name), lat, lon).catch(report);
        break;
      }
      case LAYERS.trails:
        openTrail(props.searchName ? String(props.searchName) : null, props.website ? String(props.website) : null).catch(report);
        break;
      default:
        if (isPlace(top.layer.id)) openPlace(placeLocalName(props), e.lngLat.lat, e.lngLat.lng).catch(report);
    }
  });

  // Right-click on a POI or a search result, whether or not the window is open: it opens the window and
  // adds the POI to the end of the plan, or removes it again.
  map.on('contextmenu', (e: MapMouseEvent) => {
    e.preventDefault();
    const features = map.queryRenderedFeatures(
      [[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]],
      { layers: [LAYERS.search, LAYERS.myPois, LAYERS.osmPois] },
    );
    const top = features[0];
    if (!top) return;
    const props = top.properties ?? {};
    const [lon, lat] = (top.geometry as Point).coordinates;
    const name = String(props.name ?? '');
    let stop: PlanStop | null = null;
    if (top.layer.id === LAYERS.myPois) stop = { key: `mine:${props.path}`, lat, lon, name };
    else if (top.layer.id === LAYERS.osmPois && name) stop = { key: `osm:${props.id}`, lat, lon, name, searchName: String(props.searchName ?? name) };
    else if (top.layer.id === LAYERS.search) {
      const r = search.resultByKey(String(props.key));
      stop = r ? resultStop(r) : { key: String(props.key), lat, lon, name };
    }
    if (!stop) return;
    // Right-click works from any screen: the search window replaces whatever the panel showed.
    search.toggle(stop);
    tooltip.hide();
  });
  mapEl.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeBrowser().catch((err) => setStatus('open', `Could not close: ${err}`));
    // Alt+Left / Alt+Right step through the panel's screens. (When the embedded browser has the
    // keyboard the keys never reach this page: there they are the browser's own back/forward.)
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      screens.step(e.key === 'ArrowLeft' ? -1 : 1, showScreen).catch((err) => setStatus('open', `Could not open: ${err}`));
    }
    // WebView2 zoom control is on so touchpad pinch reaches the map; keep the page itself unscaled.
    if (e.ctrlKey && ['+', '-', '=', '0'].includes(e.key)) e.preventDefault();
  });
  installMapGestures(map, mapEl);
  // A touchpad pinch arrives as ctrl+wheel at whatever sits under the mouse pointer. Wherever it
  // lands, it zooms the map (around the map centre when the pointer is off the map), never the page.
  window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || mapEl.contains(e.target as Node)) return;
    e.preventDefault();
    const r = mapEl.getBoundingClientRect();
    mapEl.dispatchEvent(new WheelEvent('wheel', {
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      ctrlKey: true,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      bubbles: false,
      cancelable: true,
    }));
  }, { passive: false });

  await rescan();
  scheduleFetch();
}

void main().catch((e) => {
  console.error(e);
  document.getElementById('sidebar')!.insertAdjacentHTML('beforeend', `<div class="status error">${String(e)}</div>`);
});


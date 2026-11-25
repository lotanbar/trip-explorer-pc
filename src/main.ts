import { Map as MapLibreMap, setWorkerUrl, type MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre 6 loads its worker from a file next to its own bundle. Vite does not emit that file in
// a production build (the map then never loads), so Vite bundles the worker here and its URL is handed over.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { listen } from '@tauri-apps/api/event';
import { closePanel, initPanel } from './panel';
import { installMapGestures } from './gestures';
import type { Feature, FeatureCollection, Point } from 'geojson';
import { openPath } from '@tauri-apps/plugin-opener';
import { scanTrips, cacheEvict, driveSetRoot, driveStatus, driveSync, CACHE_TTL_MS, type SyncStatus, type TripInfo } from './backend';
import { ask } from './dialog';
import { openDriveSetup } from './drivePicker';
import { categoryByKey } from './categories';
import { addMarkerImages, addOverlayLayers, LAYERS, lastData, setData, SRC_MY_POIS, SRC_RECORDINGS } from './mapLayers';
import { loadMapStyle } from './mapStyle';
import { forgetRecordings, loadRecording, recordingFeature, TRACK_CACHE } from './recordings';
import { loadSettings, saveSettings, settings } from './settings';
import { Sidebar } from './sidebar';
import { Tooltip } from './tooltip';
import './styles.css';

const DEFAULT_CENTER: [number, number] = [25.0, 37.3];
const DEFAULT_ZOOM = 7;

async function main(): Promise<void> {
  setWorkerUrl(maplibreWorkerUrl);
  await loadSettings();
  const statusMessages = new Map<string, string>();
  initPanel();
  const sidebar = new Sidebar(document.getElementById('sidebar')!, {
    onRootChanged: (root) => {
      void driveSetRoot(root);
      void rescan();
    },
    onRefresh: () => rescan(),
    onDrive: () => void setUpDrive(),
    onSync: () => void driveSync(),
    onSyncDetails: () => void showSyncDetails(),
    onCheckedChanged: () => renderChecked(),
    onClose: () => closePanel(),
  });
  const setStatus = (key: string, message: string | null) => {
    if (message) statusMessages.set(key, message);
    else statusMessages.delete(key);
    sidebar.setStatus([...statusMessages.values()].join(' · ') || null);
  };

  for (const ns of ['roads', TRACK_CACHE]) cacheEvict(ns, CACHE_TTL_MS).catch(() => undefined);
  // Caches of the removed OSM POIs and trails: emptied.
  for (const ns of ['osm-pois-v7', 'trails-v2']) cacheEvict(ns, 0).catch(() => undefined);

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
  if (import.meta.env.DEV) (window as unknown as { __te: unknown }).__te = { map, settings, lastData };

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
        const cat = categoryByKey(poi.category);
        poiFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [poi.lon, poi.lat] },
          properties: {
            path: poi.path,
            icon: `poi|${cat.key}`,
            hover: `${cat.name}\n${poi.datetime}\n${trip.name}`,
          },
        });
      }
    }
    setData(map, SRC_MY_POIS, { type: 'FeatureCollection', features: poiFeatures });

    const wanted = trips.flatMap((trip) => trip.recordings.filter((r) => checked.has(r.path)).map((r) => ({ r, trip })));
    // Each recording shows at once as its raw points; the cleaned line replaces them when its roads are in.
    const lines = new Map<string, Feature>();
    const drawLines = () => setData(map, SRC_RECORDINGS, { type: 'FeatureCollection', features: [...lines.values()] });
    drawLines();
    for (const { r, trip } of wanted) {
      const load = loadRecording(r, trip, (s) => setStatus(`rec:${r.path}`, s));
      load.raw
        .then((raw) => {
          if (gen !== checkedGeneration || lines.has(r.path)) return;
          lines.set(r.path, recordingFeature(raw));
          drawLines();
        })
        .catch(() => undefined);
      load.cleaned
        .then((cleaned) => {
          if (gen !== checkedGeneration) return;
          lines.set(r.path, recordingFeature(cleaned));
          drawLines();
        })
        .catch((e) => setStatus(`rec:${r.path}`, `${r.name}: ${(e as Error).message}`));
    }
  }

  map.on('moveend', () => {
    const c = map.getCenter();
    settings.camera = { lng: c.lng, lat: c.lat, zoom: map.getZoom() };
    saveSettings();
  });

  // ── Hover and click ──

  const hoverLayers = [LAYERS.myPois, LAYERS.recordings, LAYERS.recordingsIncomplete];

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
    tooltip.show(String(props.hover ?? ''), e.point.x, e.point.y);
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseout', () => tooltip.hide());

  map.on('click', (e: MapMouseEvent) => {
    const features = map.queryRenderedFeatures(
      [[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]],
      { layers: hoverLayers },
    );
    // Only my POIs do something: their folder opens in the file manager.
    const top = features.find((f) => f.layer.id === LAYERS.myPois);
    if (!top) return;
    openPath(String(top.properties?.path)).catch((err) => setStatus('open', `Could not open: ${err}`));
  });
  mapEl.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
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

  // ── Google Drive sync ──

  let syncStatus: SyncStatus | null = null;
  let syncRescan: number | undefined;
  const showSync = (s: SyncStatus) => {
    syncStatus = s;
    sidebar.setSync(s);
  };
  async function setUpDrive(): Promise<void> {
    if (!settings.root) {
      await ask('Choose the trips folder first (Folder…): that is the folder kept in sync with Drive.', [{ label: 'OK', value: null, primary: true }], null);
      return;
    }
    await openDriveSetup(syncStatus ?? (await driveStatus()));
  }
  await listen<SyncStatus>('sync-status', (e) => showSync(e.payload));
  // Files came down from Drive (or went): read the folders again, once things settle.
  await listen('sync-changed', () => {
    window.clearTimeout(syncRescan);
    syncRescan = window.setTimeout(() => void rescan(), 1000);
  });
  /** What the last sync did (or why it failed), in a dialog. */
  async function showSyncDetails(): Promise<void> {
    const s = syncStatus ?? (await driveStatus());
    const when = s.last_sync ? new Date(s.last_sync).toLocaleString() : 'never';
    const lines = s.error ? [`Error: ${s.error}`] : s.last_changes.length ? s.last_changes : ['Nothing changed.'];
    await ask(`Last sync: ${when}\n\n${lines.join('\n')}`, [{ label: 'OK', value: null, primary: true }], null);
  }
  await driveSetRoot(settings.root);
  showSync(await driveStatus());

  await rescan();
}

void main().catch((e) => {
  console.error(e);
  document.getElementById('sidebar')!.insertAdjacentHTML('beforeend', `<div class="status error">${String(e)}</div>`);
});


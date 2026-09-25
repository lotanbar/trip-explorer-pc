# Trip Explorer – PC app

A small viewer that shows a `trips/` folder on a map, with a place search and plan builder.
Tauri 2 + MapLibre GL JS, online only. The only thing it writes into the trips folder is a plan file
(`trips/plans/<name>.txt`) on Save; browsing and editing files is done in the file manager.

## Run

```
npm install
npm run tauri dev        # development window with hot reload
npm run tauri build      # installer under src-tauri/target/release/bundle
```

Needs Node, Rust (MSVC toolchain on Windows) and the WebView2 runtime (Windows) or WebKitGTK (Linux).

## Layout

| Path | Purpose |
| --- | --- |
| `src-tauri/src/lib.rs` | Rust commands: scan the trips folder, read a file, list/save plans, settings, the Overpass cache |
| `src/main.ts` | Wires the map, sidebar, hover/click and the viewport fetches |
| `src/groups.ts` | The fixed group list and the OSM tag → group mapping |
| `src/mapStyle.ts` | OpenFreeMap dark style plus Terrarium hillshade |
| `src/mapLayers.ts` | Sources, layers and marker/pattern images |
| `src/overpass.ts` | Endpoints with cooldown, strip fetching, 30-day cache |
| `src/osmPois.ts`, `src/trails.ts` | The two Overpass features |
| `src/recordings.ts` | GPX loading and the display-only track cleanup |
| `src/searchWindow.ts`, `src/photon.ts`, `src/plan.ts`, `src/gpx.ts`, `src/names.ts` | Search and plan: the window in the side panel, Photon search-as-you-type plus my own POIs by name, the plan model and file format, GPX import/export, name rules |
| `src/screens.ts`, `src/dialog.ts` | The side panel's screen history (Alt+Left / Alt+Right); the in-app question box |
| `src/track-cleanup/` | The display-only track cleanup module, standalone with its own tests (`npm test` inside it) |
| `src/icons/` | Bundled SVG icons (Maki, Temaki or hand-drawn) |

Deviations from the spec (agreed on 2026-09-22):

- Only named OSM POIs are fetched, and places of worship / cemeteries additionally need a notable tag (`wikidata`, `wikipedia`, `heritage`, `website`, `image`, `wikimedia_commons`, `description` or `name:en`); every countryside chapel is tagged and they swamped the map.
- Clicking an OSM POI or a trail opens the search / website in an embedded browser laid over the side panel
  (a Tauri child webview, `src/browser.ts` + `browser_open` in Rust) instead of the system browser. Clicking an
  empty spot on the map brings the panel's controls back (the browser and the search window both go).
- The side panel keeps an in-memory history of its screens (the controls, the search/plan window with the temp
  or a saved plan, a browser page), gone when the app closes: Alt+Left / Alt+Right with the map or panel focused
  step through it (`src/screens.ts`). When the embedded browser has the keyboard the keys are its own back /
  forward instead (the page's init script calls `history.back()` / `history.forward()`). A screen brought back
  from the history does not give the browser the keyboard, so the keys keep walking the history.
- Place labels on the base map (cities, villages, islands ...) are drawn near-white and are clickable: they open the same search as a POI. Group colours are muted versions of the spec palette.
- All trail categories use the same plain grey line; only the repeated icon differs (no dots, crossbars or ticks).
- No zoom buttons, scale bar or attribution control on the map: pinch / ctrl+scroll zoom.

Settings live in `%APPDATA%\com.lotanbar.tripexplorer\settings.json` (Windows) or
`$XDG_CONFIG_HOME/com.lotanbar.tripexplorer` (Linux); the Overpass cache in the matching cache folder.

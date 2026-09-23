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
| `src/searchWindow.ts`, `src/photon.ts`, `src/plan.ts`, `src/names.ts` | Search and plan: the window in the side panel, Photon search-as-you-type plus my own POIs by name, the plan model and file format, name rules |
| `src/track-cleanup/` | The cleanup module, copied as-is from the reference repo's `track-cleanup` branch (`npm test` inside it) |
| `src/icons/` | Bundled SVG icons (Maki, Temaki or hand-drawn) |

Deviations from the spec (agreed on 2026-09-22):

- Only named OSM POIs are fetched, and places of worship / cemeteries additionally need a notable tag (`wikidata`, `wikipedia`, `heritage`, `website`, `image`, `wikimedia_commons`, `description` or `name:en`); every countryside chapel is tagged and they swamped the map.
- Clicking an OSM POI or a trail opens the search / website in an embedded browser laid over the side panel
  (a Tauri child webview, `src/browser.ts` + `browser_open` in Rust) instead of the system browser. Clicking an
  empty spot on the map, or opening the search window (right-click a POI), brings the panel back.
- Every page opened in the browser is a visit in an in-memory history (gone when the app closes); Alt+Left /
  Alt+Right step through it, reopening the page and flying to its POI. Inside the browser the keys are reported
  by navigating to `https://history.trip-explorer.invalid/<step>`, which the backend cancels and turns into the
  `browser-history` event.
- Place labels on the base map (cities, villages, islands ...) are drawn near-white and are clickable: they open the same search as a POI. Group colours are muted versions of the spec palette.
- All trail categories use the same plain grey line; only the repeated icon differs (no dots, crossbars or ticks).
- No zoom buttons, scale bar or attribution control on the map: pinch / ctrl+scroll zoom.

Settings live in `%APPDATA%\com.lotanbar.tripexplorer\settings.json` (Windows) or
`$XDG_CONFIG_HOME/com.lotanbar.tripexplorer` (Linux); the Overpass cache in the matching cache folder.

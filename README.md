# Trip Explorer – PC app

A small viewer that shows a `trips/` folder on a map. Tauri 2 + MapLibre GL JS, online only.
It never writes to the trips folder; browsing and editing files is done in the file manager.

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
| `src-tauri/src/lib.rs` | Rust commands: scan the trips folder, read a file, settings, the Overpass cache |
| `src/main.ts` | Wires the map, sidebar, hover/click and the viewport fetches |
| `src/groups.ts` | The fixed group list and the OSM tag → group mapping |
| `src/mapStyle.ts` | OpenFreeMap dark style plus Terrarium hillshade |
| `src/mapLayers.ts` | Sources, layers and marker/pattern images |
| `src/overpass.ts` | Endpoints with cooldown, strip fetching, 30-day cache |
| `src/osmPois.ts`, `src/trails.ts` | The two Overpass features |
| `src/recordings.ts` | GPX loading and the display-only track cleanup |
| `src/track-cleanup/` | The cleanup module, copied as-is from the reference repo's `track-cleanup` branch (`npm test` inside it) |
| `src/icons/` | Bundled SVG icons (Maki, Temaki or hand-drawn) |

Deviations from the spec (agreed on 2026-09-22):

- Only named OSM POIs are fetched (`["name"]` in every query clause); places of worship appear only from zoom 13. Unnamed objects swamped the map.
- Clicking an OSM POI or a trail opens the search / website in an embedded browser laid over the side panel
  (a Tauri child webview, `src/browser.ts` + `browser_open` in Rust) instead of the system browser. Clicking an
  empty spot on the map brings the panel back.
- All trail categories use the same plain grey line; only the repeated icon differs (no dots, crossbars or ticks).
- No zoom buttons, scale bar or attribution control on the map: pinch / ctrl+scroll zoom, credit line in the panel footer.

Settings live in `%APPDATA%\com.lotanbar.tripexplorer\settings.json` (Windows) or
`$XDG_CONFIG_HOME/com.lotanbar.tripexplorer` (Linux); the Overpass cache in the matching cache folder.

# Trip Explorer – PC app

A small viewer that shows a `trips/` folder on a map: where I rode (the recordings) and what I noted
(my POIs). Tauri 2 + MapLibre GL JS, online only. It writes nothing into the trips folder itself; only
Google Drive sync changes files there. Browsing and editing files is done in the file manager.

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
| `src-tauri/src/lib.rs` | Rust commands: scan the trips folder, read a file, settings, the on-disk cache |
| `src-tauri/src/sync.rs`, `drive.rs` | Google Drive sync |
| `src/main.ts` | Wires the map, the side panel, hover and click |
| `src/sidebar.ts` | The side panel: trips folder, Drive row, folder tree |
| `src/categories.ts` | The six categories, shared with the phone app by copy |
| `src/mapStyle.ts` | OpenFreeMap dark style plus Terrarium hillshade |
| `src/mapLayers.ts`, `src/icons.ts` | Sources, layers and marker images |
| `src/recordings.ts` | GPX loading and the display-only track cleanup |
| `src/drivePicker.ts`, `src/dialog.ts` | The Drive folder picker; the in-app question box |
| `src/track-cleanup/` | The display-only track cleanup module, standalone with its own tests (`npm test` inside it) |
| `src/icons/` | Bundled SVG icons (the same shapes as the phone's) |

Settings live in `%APPDATA%\com.lotanbar.tripexplorer\settings.json` (Windows) or
`$XDG_CONFIG_HOME/com.lotanbar.tripexplorer` (Linux); the roads and cleaned tracks in the matching cache folder.

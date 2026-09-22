//! Trip Explorer PC backend: reads the trips folder tree, persists settings and keeps the
//! on-disk Overpass cache. Nothing here ever deletes or changes a file inside the trips folder.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use std::sync::Mutex;
use tauri::{LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl, WindowEvent};

#[derive(Serialize)]
struct Recording {
    name: String,
    path: String,
    incomplete: bool,
}

#[derive(Serialize)]
struct Poi {
    name: String,
    path: String,
    lat: f64,
    lon: f64,
    datetime: String,
    description: String,
    group: Option<String>,
    media: Vec<String>,
}

#[derive(Serialize)]
struct Trip {
    name: String,
    path: String,
    recordings_path: String,
    recordings: Vec<Recording>,
    pois: Vec<Poi>,
}

fn read_trimmed(path: &Path) -> String {
    fs::read_to_string(path).map(|s| s.trim().to_string()).unwrap_or_default()
}

fn parse_coordinates(text: &str) -> Option<(f64, f64)> {
    let mut parts = text.split(|c: char| c == ',' || c.is_whitespace()).filter(|s| !s.is_empty());
    let lat = parts.next()?.parse::<f64>().ok()?;
    let lon = parts.next()?.parse::<f64>().ok()?;
    if (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon) {
        Some((lat, lon))
    } else {
        None
    }
}

fn scan_poi(dir: &Path) -> Option<Poi> {
    let coords = read_trimmed(&dir.join("coordinates.txt"));
    let (lat, lon) = parse_coordinates(&coords)?;
    let mut group = None;
    let mut media = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(rest) = name.strip_prefix("group-") {
                if let Some(g) = rest.strip_suffix(".txt") {
                    group = Some(g.to_string());
                }
            }
        }
    }
    if let Ok(entries) = fs::read_dir(dir.join("media")) {
        for entry in entries.flatten() {
            if entry.path().is_file() {
                media.push(entry.file_name().to_string_lossy().to_string());
            }
        }
    }
    media.sort();
    Some(Poi {
        name: dir.file_name()?.to_string_lossy().to_string(),
        path: dir.to_string_lossy().to_string(),
        lat,
        lon,
        datetime: read_trimmed(&dir.join("datetime.txt")),
        description: read_trimmed(&dir.join("description.txt")),
        group,
        media,
    })
}

fn scan_trip(dir: &Path) -> Trip {
    let mut recordings = Vec::new();
    let mut pois = Vec::new();
    let recordings_dir = dir.join("recordings");
    if let Ok(entries) = fs::read_dir(&recordings_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_file() && name.to_lowercase().ends_with(".gpx") {
                let incomplete = name.to_lowercase().ends_with(" - recording.gpx");
                recordings.push(Recording { name, path: path.to_string_lossy().to_string(), incomplete });
            }
        }
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() || entry.file_name() == "recordings" {
                continue;
            }
            if let Some(poi) = scan_poi(&path) {
                pois.push(poi);
            }
        }
    }
    recordings.sort_by(|a, b| a.name.cmp(&b.name));
    pois.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Trip {
        name: dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        path: dir.to_string_lossy().to_string(),
        recordings_path: recordings_dir.to_string_lossy().to_string(),
        recordings,
        pois,
    }
}

/// Lists every trip folder directly under `root` (the `trips/` folder).
#[tauri::command]
fn scan_trips(root: String) -> Result<Vec<Trip>, String> {
    let root = PathBuf::from(&root);
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let mut trips = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            trips.push(scan_trip(&path));
        }
    }
    trips.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(trips)
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("{}: {}", path, e))
}

fn settings_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let file = settings_file(&app)?;
    match fs::read_to_string(&file) {
        Ok(s) => Ok(Some(s)),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let file = settings_file(&app)?;
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

// ── Overpass cache: one folder per namespace, one .meta.json + .data.json pair per entry ────

fn cache_dir(app: &tauri::AppHandle, namespace: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("overpass").join(namespace);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn safe_key(key: &str) -> String {
    key.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' }).collect()
}

fn age_ms(path: &Path) -> Option<u128> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let now = SystemTime::now();
    Some(now.duration_since(modified).ok()?.as_millis())
}

#[derive(Serialize)]
struct CacheEntry {
    key: String,
    meta: String,
}

/// Every entry younger than `max_age_ms`, with its metadata (small; the data is loaded on demand).
#[tauri::command]
fn cache_index(app: tauri::AppHandle, namespace: String, max_age_ms: u64) -> Result<Vec<CacheEntry>, String> {
    let dir = cache_dir(&app, &namespace)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(key) = name.strip_suffix(".meta.json") {
            if age_ms(&path).map(|a| a <= max_age_ms as u128).unwrap_or(false) {
                if let Ok(meta) = fs::read_to_string(&path) {
                    out.push(CacheEntry { key: key.to_string(), meta });
                }
            }
        }
    }
    Ok(out)
}

#[tauri::command]
fn cache_get(app: tauri::AppHandle, namespace: String, key: String, max_age_ms: u64) -> Result<Option<String>, String> {
    let file = cache_dir(&app, &namespace)?.join(format!("{}.data.json", safe_key(&key)));
    if !age_ms(&file).map(|a| a <= max_age_ms as u128).unwrap_or(false) {
        return Ok(None);
    }
    Ok(fs::read_to_string(&file).ok())
}

#[tauri::command]
fn cache_put(app: tauri::AppHandle, namespace: String, key: String, meta: String, data: String) -> Result<(), String> {
    let dir = cache_dir(&app, &namespace)?;
    let key = safe_key(&key);
    fs::write(dir.join(format!("{}.data.json", key)), data).map_err(|e| e.to_string())?;
    fs::write(dir.join(format!("{}.meta.json", key)), meta).map_err(|e| e.to_string())
}

/// Deletes cache entries older than `max_age_ms`. Never touches anything outside the cache folder.
#[tauri::command]
fn cache_evict(app: tauri::AppHandle, namespace: String, max_age_ms: u64) -> Result<usize, String> {
    let dir = cache_dir(&app, &namespace)?;
    let mut removed = 0;
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if age_ms(&path).map(|a| a > max_age_ms as u128).unwrap_or(false) && fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

// ── Embedded browser: a child webview laid over the side panel ────────────────────────────────

const BROWSER_LABEL: &str = "browser";

/// Runs in every page the embedded browser loads. On Google it keeps only the search box and the
/// results: hides the Google bar, the mobile header row (settings / share / logo), the result-type
/// tabs (AI Mode / All / Images ...), the slim app bar and the spacers between them, the
/// "AI Overview" title row, and shrinks the header wrapper to the search box so no blank band is
/// left. The voice and Lens buttons in the search box are replaced by one image button that switches
/// to the Images results for the same query (and back to All from there). Class names on Google
/// change, so everything is found structurally; the ids used (`sfcnt`, `appbar`, `cnt`,
/// `m-x-content`) are long-lived.
const BROWSER_INIT_SCRIPT: &str = r#"
(function () {
  if (!/(^|\.)google\./.test(location.hostname)) return;
  var css = '#gb, #gbwa, [aria-label="Google apps"], #sfcnt, #appbar, #oFNiHe { display: none !important; }' +
    ' #cnt { padding-top: 0 !important; }' +
    ' [aria-label="Search by voice"], [aria-label="Search by image"] { display: none !important; }' +
    ' .te-images { display: flex; align-items: center; padding: 0 12px; cursor: pointer; }' +
    ' .te-images svg { width: 24px; height: 24px; fill: currentColor; }';
  var IMAGE_ICON = '<svg viewBox="0 -960 960 960" aria-hidden="true"><path d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h560v-560H200v560Zm40-80h480L570-480 450-320l-90-120-120 160Zm-40 80v-560 560Z"/></svg>';
  function addCss() {
    var s = document.createElement('style');
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }
  function hideHeaderRow() {
    var q = document.querySelector('[name="q"]');
    var gear = document.querySelector('#og-te, [aria-label="Settings"]');
    if (!gear || !q) return;
    var e = gear;
    while (e.parentElement && !e.parentElement.contains(q) && e.parentElement !== document.body) e = e.parentElement;
    if (!e.contains(q) && !e.dataset.teHidden) { e.dataset.teHidden = '1'; e.style.display = 'none'; }
  }
  // The result-type tabs: the first navigation block in the results container that holds a list.
  function hideTabs() {
    var nav = document.querySelector('#cnt [role="navigation"]');
    if (!nav || !nav.querySelector('[role="list"]') || nav.dataset.teHidden) return;
    nav.dataset.teHidden = '1';
    nav.style.display = 'none';
    // Wrappers left holding only padding (Images results) collapse too.
    var e = nav.parentElement;
    for (var k = 0; k < 4 && e && e.id !== 'cnt' && e !== document.body; k++, e = e.parentElement) {
      if (e.getBoundingClientRect().height < 20) e.style.paddingBottom = '0';
    }
  }
  // The header wrapper has a fixed inline height sized for the (hidden) header row plus the search
  // box; shrink it to the search box. Only written when it differs, so the observer does not loop.
  function shrinkHeader() {
    var form = document.getElementById('searchform');
    var wrap = form && form.parentElement;
    if (!wrap || !wrap.style.height) return;
    var h = Math.max(0, Math.round(form.getBoundingClientRect().bottom - wrap.getBoundingClientRect().top)) + 'px';
    if (wrap.style.height !== h) wrap.style.height = h;
  }
  // The "AI Overview" title row: the ancestor of that heading that sits directly in the overview's
  // content column (its parent is tall and has several children).
  function hideOverviewTitle() {
    var headings = document.querySelectorAll('#m-x-content [role="heading"]');
    for (var i = 0; i < headings.length; i++) {
      var h = headings[i];
      if (h.textContent.trim() !== 'AI Overview' || h.dataset.teHidden) continue;
      h.dataset.teHidden = '1';
      var e = h;
      while (e.parentElement && !(e.parentElement.children.length > 1 && e.parentElement.getBoundingClientRect().height > 100)) e = e.parentElement;
      e.style.display = 'none';
    }
  }
  // Web results <-> Images for the current query (what the hidden Images / All tabs would do).
  function imagesUrl() {
    var u = new URL(location.href);
    if (u.searchParams.get('udm') === '2') u.searchParams.delete('udm');
    else { u.searchParams.set('udm', '2'); u.searchParams.delete('tbm'); }
    ['sa', 'ved', 'ei', 'oq', 'gs_lp', 'sclient'].forEach(function (k) { u.searchParams.delete(k); });
    return u.toString();
  }
  function addImagesButton() {
    var voice = document.querySelector('[aria-label="Search by voice"]');
    var box = voice && voice.parentElement;
    if (!box || box.querySelector('.te-images')) return;
    var b = document.createElement('div');
    b.className = 'te-images';
    b.setAttribute('role', 'button');
    b.setAttribute('aria-label', 'Images');
    b.title = 'Images';
    b.style.color = getComputedStyle(voice).color;
    b.innerHTML = IMAGE_ICON;
    b.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); location.href = imagesUrl(); });
    box.appendChild(b);
  }
  function tidy() { hideHeaderRow(); hideTabs(); shrinkHeader(); hideOverviewTitle(); addImagesButton(); }
  function start() {
    addCss();
    tidy();
    var timer = null;
    new MutationObserver(function () {
      clearTimeout(timer);
      timer = setTimeout(tidy, 250);
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
"#;

/// Geometry of the browser panel (logical px), kept so a window resize can re-fit the child webview:
/// its width, and how much of the window bottom it leaves free (the panel's status strip).
#[derive(Default)]
struct BrowserState {
    width: Mutex<f64>,
    bottom_inset: Mutex<f64>,
}

fn browser_height(window: &tauri::Window, state: &BrowserState) -> Result<f64, String> {
    let inset = *state.bottom_inset.lock().map_err(|e| e.to_string())?;
    Ok((window_logical_height(window)? - inset).max(100.0))
}

fn browser_webview(window: &tauri::Window) -> Option<tauri::Webview> {
    window.webviews().into_iter().find(|w| w.label() == BROWSER_LABEL)
}

fn window_logical_height(window: &tauri::Window) -> Result<f64, String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    Ok(size.to_logical::<f64>(scale).height)
}

/// Shows `url` in the embedded browser over the side panel: `width` logical px wide, from the top
/// down to `bottom_inset` px above the window bottom (the panel's status strip stays visible).
/// Async so it runs off the main thread: creating a child webview waits on the main thread.
#[tauri::command]
async fn browser_open(window: tauri::Window, state: tauri::State<'_, BrowserState>, url: String, width: f64, bottom_inset: f64) -> Result<(), String> {
    let url: tauri::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("Refusing to open {} in the browser", url.scheme()));
    }
    *state.width.lock().map_err(|e| e.to_string())? = width;
    *state.bottom_inset.lock().map_err(|e| e.to_string())? = bottom_inset;
    let height = browser_height(&window, &state)?;
    if let Some(webview) = browser_webview(&window) {
        webview.navigate(url).map_err(|e| e.to_string())?;
        webview.set_position(LogicalPosition::new(0.0, 0.0)).map_err(|e| e.to_string())?;
        webview.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
        webview.show().map_err(|e| e.to_string())?;
        webview.set_focus().map_err(|e| e.to_string())?;
    } else {
        #[allow(unused_mut)]
        let mut builder = WebviewBuilder::new(BROWSER_LABEL, WebviewUrl::External(url))
            .initialization_script(BROWSER_INIT_SCRIPT);
        // On Windows every webview sharing the user-data folder must use the same browser
        // arguments as the main window, or WebView2 refuses to start the child.
        #[cfg(windows)]
        if let Some(args) = window.config().app.windows.first().and_then(|w| w.additional_browser_args.clone()) {
            builder = builder.additional_browser_args(&args);
        }
        window
            .add_child(builder, LogicalPosition::new(0.0, 0.0), LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Follows the side panel when it is resized (a width of 0 hides the browser).
#[tauri::command]
async fn browser_resize(window: tauri::Window, state: tauri::State<'_, BrowserState>, width: f64, bottom_inset: f64) -> Result<(), String> {
    *state.width.lock().map_err(|e| e.to_string())? = width;
    *state.bottom_inset.lock().map_err(|e| e.to_string())? = bottom_inset;
    if let Some(webview) = browser_webview(&window) {
        if width <= 0.0 {
            webview.hide().map_err(|e| e.to_string())?;
        } else {
            let height = browser_height(&window, &state)?;
            webview.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Hides the embedded browser; the side panel is visible again.
#[tauri::command]
async fn browser_close(window: tauri::Window) -> Result<(), String> {
    if let Some(webview) = browser_webview(&window) {
        webview.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(BrowserState::default())
        .setup(|app| {
            // Keep the embedded browser fitted to the panel when the window is resized.
            if let Some(window) = app.get_window("main") {
                let handle = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::Resized(_) = event {
                        let state = handle.state::<BrowserState>();
                        if let (Some(webview), Ok(height)) = (browser_webview(&handle), browser_height(&handle, &state)) {
                            let width = *state.width.lock().unwrap();
                            let _ = webview.set_size(LogicalSize::new(width, height));
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            browser_open,
            browser_resize,
            browser_close,
            scan_trips,
            read_text,
            load_settings,
            save_settings,
            cache_index,
            cache_get,
            cache_put,
            cache_evict,
            now_ms
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

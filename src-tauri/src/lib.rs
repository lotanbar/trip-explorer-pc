//! Trip Explorer PC backend: reads the trips folder tree, persists settings and keeps the on-disk
//! cache (roads and cleaned tracks). It writes nothing into the trips folder itself; the folder is
//! kept in sync with a Google Drive folder (see `sync`), the only code that changes anything in it.

mod drive;
mod sync;

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use std::sync::Arc;
use tauri::{Emitter, Manager};

#[derive(Serialize)]
struct Recording {
    name: String,
    path: String,
    incomplete: bool,
}

/// A POI folder: one with a data.txt (see the spec's trips folder).
#[derive(Serialize)]
struct Poi {
    /// The folder name: DD.MM.YYYY HH-MM-SS.
    name: String,
    path: String,
    lat: f64,
    lon: f64,
    datetime: String,
    /// The category key as written in data.txt; None when the line is missing.
    category: Option<String>,
}

#[derive(Serialize)]
struct Trip {
    name: String,
    path: String,
    recordings_path: String,
    recordings: Vec<Recording>,
    pois: Vec<Poi>,
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

/// data.txt: one `key: value` per line; keys are lower case, unknown keys and blank lines are ignored.
fn parse_data(text: &str) -> std::collections::HashMap<String, String> {
    text.lines()
        .filter_map(|line| line.split_once(':'))
        .map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string()))
        .collect()
}

/// A folder is a POI when it holds a data.txt with valid coordinates; any other folder is skipped.
fn scan_poi(dir: &Path) -> Option<Poi> {
    let data = parse_data(&fs::read_to_string(dir.join("data.txt")).ok()?);
    let (lat, lon) = parse_coordinates(data.get("coordinates")?)?;
    Some(Poi {
        name: dir.file_name()?.to_string_lossy().to_string(),
        path: dir.to_string_lossy().to_string(),
        lat,
        lon,
        datetime: data.get("datetime").cloned().unwrap_or_default(),
        category: data.get("category").filter(|c| !c.is_empty()).cloned(),
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

#[tauri::command]
fn drive_status(sync: tauri::State<'_, Arc<sync::SyncHandle>>) -> sync::Status {
    sync.shared.lock().unwrap().status.clone()
}

/// The local trips folder the sync works on (None: no folder chosen).
#[tauri::command]
fn drive_set_root(sync: tauri::State<'_, Arc<sync::SyncHandle>>, root: Option<String>) {
    sync.shared.lock().unwrap().root = root.map(PathBuf::from);
}

/// The Sync button: one pass (Drive's changes come down, this folder's go up; the newer change wins).
#[tauri::command]
fn drive_sync(sync: tauri::State<'_, Arc<sync::SyncHandle>>) {
    sync.request();
}

/// Opens Google's sign-in page in the browser and waits for it to finish.
#[tauri::command]
async fn drive_sign_in(sync: tauri::State<'_, Arc<sync::SyncHandle>>) -> Result<String, String> {
    let handle = sync.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let token = drive::sign_in(|url| tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string()))?;
        let email = drive::Drive::new(token.clone()).about_email().map_err(|e| e.message)?;
        let auth = sync::Auth { refresh_token: token, email: Some(email.clone()) };
        fs::write(handle.auth_file(), serde_json::to_string(&auth).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        handle.shared.lock().unwrap().auth_changed = true;
        handle.wake.notify_all();
        Ok(email)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn drive_sign_out(sync: tauri::State<'_, Arc<sync::SyncHandle>>) {
    let _ = fs::remove_file(sync.auth_file());
    sync.shared.lock().unwrap().auth_changed = true;
    sync.wake.notify_all();
}

#[derive(Serialize)]
struct DriveFolder {
    id: String,
    name: String,
}

fn drive_client(sync: &sync::SyncHandle) -> Result<drive::Drive, String> {
    let auth = sync.load_auth().ok_or("Not signed in to Google")?;
    Ok(drive::Drive::new(auth.refresh_token))
}

/// The subfolders of a Drive folder (`root`: My Drive), by name.
#[tauri::command]
async fn drive_list_folders(sync: tauri::State<'_, Arc<sync::SyncHandle>>, parent: String) -> Result<Vec<DriveFolder>, String> {
    let handle = sync.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut d = drive_client(&handle)?;
        let list = d.children(&parent, true).map_err(|e| e.message)?;
        Ok(list.into_iter().map(|f| DriveFolder { id: f.id, name: f.name }).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn drive_create_folder(sync: tauri::State<'_, Arc<sync::SyncHandle>>, parent: String, name: String) -> Result<DriveFolder, String> {
    let handle = sync.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut d = drive_client(&handle)?;
        let f = d.create_folder(&parent, &name).map_err(|e| e.message)?;
        Ok(DriveFolder { id: f.id, name: f.name })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Syncs the trips folder with this Drive folder from now on (a fresh start: both sides are merged).
#[tauri::command]
fn drive_pick_folder(sync: tauri::State<'_, Arc<sync::SyncHandle>>, id: String, name: String) {
    sync.shared.lock().unwrap().new_folder = Some((id, name));
    sync.wake.notify_all();
}

/// Closes the app even though changes are still going up to Drive.
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

// ── On-disk cache (roads and cleaned tracks; the folder keeps its old name): one folder per namespace, one .meta.json + .data.json pair per entry ────

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&data_dir)?;
            let emitter = app.handle().clone();
            let sync = sync::Engine::start(data_dir, move |status, local_changed| {
                let _ = emitter.emit("sync-status", status.clone());
                if local_changed {
                    let _ = emitter.emit("sync-changed", ());
                }
            });
            app.manage(sync.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_trips,
            read_text,
            load_settings,
            save_settings,
            cache_get,
            cache_put,
            cache_evict,
            drive_status,
            drive_set_root,
            drive_sync,
            drive_sign_in,
            drive_sign_out,
            drive_list_folders,
            drive_create_folder,
            drive_pick_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

//! Google Drive sync of the whole trips folder. Drive is the truth; the newest change wins.
//!
//! Every cycle compares three views of the tree, path by path: the local folder, the Drive folder,
//! and the base (both sides as they were after the last sync). A side "changed" a file when its
//! content (MD5) differs from the base. One side changed → it is copied to the other; both changed →
//! the newer modified time wins (ties: Drive). A path gone from one side is removed from the other
//! (on Drive: to the trash; here: to the Recycle Bin), unless the other side changed it since.
//! A removal plus an addition of the same content is a rename: done as a move, nothing is sent again.
//!
//! On the first cycle after the app starts, local changes to files that were synced before lose to
//! Drive (a change counts only once it has been uploaded; see the spec). Files never synced still go up.
//!
//! The planner (`plan`) is pure; `Engine` scans, talks to Drive and applies the plan.

use crate::drive::{self, Drive, DriveError, RemoteFile};
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const REMOTE_EVERY: Duration = Duration::from_secs(30);
const LOCAL_EVERY: Duration = Duration::from_secs(5);
const RETRY_AFTER: Duration = Duration::from_secs(30);

// ── The three views ──────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub struct LocalEntry {
    pub dir: bool,
    pub size: u64,
    pub mtime: i64,
    /// Content hash; always known for files (taken from the base when size and time match it).
    pub md5: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RemoteEntry {
    pub id: String,
    pub dir: bool,
    pub size: u64,
    pub modified: i64,
    pub md5: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BaseEntry {
    pub id: String,
    pub dir: bool,
    pub size: u64,
    /// The local file's modified time when last synced (ms).
    pub mtime: i64,
    /// Drive's modified time when last synced (ms).
    pub rmod: i64,
    pub md5: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    MkdirRemote(String),
    Upload { path: String, id: Option<String> },
    /// A local rename or move, done on Drive without sending the file again.
    MoveRemote { id: String, from: String, to: String },
    MkdirLocal(String),
    /// A rename or move made on Drive, done here without downloading.
    MoveLocal { id: String, from: String, to: String },
    Download { path: String, id: String },
    TrashRemote { path: String, id: String },
    DeleteLocal(String),
    /// Both sides already match: only the base is brought up to date.
    Record(String),
    Forget(String),
}

impl Action {
    fn is_upload_side(&self) -> bool {
        matches!(self, Action::MkdirRemote(_) | Action::Upload { .. } | Action::MoveRemote { .. } | Action::TrashRemote { .. })
    }
    fn is_work(&self) -> bool {
        !matches!(self, Action::Record(_) | Action::Forget(_))
    }
}

fn under(path: &str, dir: &str) -> bool {
    path.len() > dir.len() && path.starts_with(dir) && path.as_bytes()[dir.len()] == b'/'
}

fn depth(path: &str) -> usize {
    path.matches('/').count()
}

/// Decides what to do with every path. `drive_wins`: local changes to already-synced files lose.
pub fn plan(
    local: &BTreeMap<String, LocalEntry>,
    remote: &BTreeMap<String, RemoteEntry>,
    base: &BTreeMap<String, BaseEntry>,
    drive_wins: bool,
) -> Vec<Action> {
    let paths: BTreeSet<&String> = local.keys().chain(remote.keys()).chain(base.keys()).collect();
    let mut actions = Vec::new();
    let mut dirs = Vec::new();

    for p in paths {
        let (l, r, b) = (local.get(p), remote.get(p), base.get(p));
        let is_dir = l.map(|e| e.dir).or(r.map(|e| e.dir)).or(b.map(|e| e.dir)).unwrap_or(false);
        if l.is_some() && r.is_some() && l.unwrap().dir != r.unwrap().dir {
            continue; // a file on one side, a folder on the other: left alone
        }
        if is_dir {
            dirs.push(p.clone());
            continue;
        }
        let path = p.clone();
        match (l, r) {
            (Some(l), Some(r)) => {
                if l.md5.is_some() && l.md5 == r.md5 {
                    let same = b.map(|b| b.id == r.id && b.mtime == l.mtime && b.rmod == r.modified && b.md5 == r.md5).unwrap_or(false);
                    if !same {
                        actions.push(Action::Record(path));
                    }
                    continue;
                }
                let local_changed = b.map(|b| l.md5 != b.md5).unwrap_or(true);
                let remote_changed = b.map(|b| r.md5 != b.md5 || (r.md5.is_none() && r.modified != b.rmod)).unwrap_or(true);
                let upload = if drive_wins && b.is_some() {
                    false
                } else if local_changed && !remote_changed {
                    true
                } else if remote_changed && !local_changed {
                    false
                } else {
                    l.mtime > r.modified
                };
                actions.push(if upload { Action::Upload { path, id: Some(r.id.clone()) } } else { Action::Download { path, id: r.id.clone() } });
            }
            (Some(l), None) => match b {
                Some(b) if drive_wins || l.md5 == b.md5 => actions.push(Action::DeleteLocal(path)),
                _ => actions.push(Action::Upload { path, id: None }),
            },
            (None, Some(r)) => match b {
                Some(b) if !drive_wins && r.md5 == b.md5 && !(r.md5.is_none() && r.modified != b.rmod) => {
                    actions.push(Action::TrashRemote { path, id: r.id.clone() })
                }
                _ => actions.push(Action::Download { path, id: r.id.clone() }),
            },
            (None, None) => actions.push(Action::Forget(path)),
        }
    }

    // Renames: a local removal plus a local addition with the same content is a move on Drive…
    let mut new_uploads: HashMap<(String, u64), Vec<usize>> = HashMap::new();
    for (i, a) in actions.iter().enumerate() {
        if let Action::Upload { path, id: None } = a {
            let l = &local[path];
            if let Some(m) = &l.md5 {
                new_uploads.entry((m.clone(), l.size)).or_default().push(i);
            }
        }
    }
    let mut replaced: HashMap<usize, Option<Action>> = HashMap::new();
    for (i, a) in actions.iter().enumerate() {
        if let Action::TrashRemote { path, id } = a {
            let b = &base[path];
            let Some(m) = &b.md5 else { continue };
            if let Some(list) = new_uploads.get_mut(&(m.clone(), b.size)) {
                if let Some(j) = list.pop() {
                    let to = match &actions[j] {
                        Action::Upload { path, .. } => path.clone(),
                        _ => unreachable!(),
                    };
                    replaced.insert(i, Some(Action::MoveRemote { id: id.clone(), from: path.clone(), to }));
                    replaced.insert(j, None);
                }
            }
        }
    }
    // …and a Drive removal plus a Drive addition of the same file (same id) is a move here.
    let mut downloads: HashMap<String, usize> = HashMap::new();
    for (i, a) in actions.iter().enumerate() {
        if let Action::Download { path, id } = a {
            if !local.contains_key(path) && !base.contains_key(path) {
                downloads.insert(id.clone(), i);
            }
        }
    }
    for (i, a) in actions.iter().enumerate() {
        if let Action::DeleteLocal(path) = a {
            let id = &base[path].id;
            if let Some(&j) = downloads.get(id) {
                if replaced.contains_key(&j) {
                    continue;
                }
                let to = match &actions[j] {
                    Action::Download { path, .. } => path.clone(),
                    _ => unreachable!(),
                };
                replaced.insert(i, Some(Action::MoveLocal { id: id.clone(), from: path.clone(), to }));
                replaced.insert(j, None);
            }
        }
    }
    let mut actions: Vec<Action> = actions
        .into_iter()
        .enumerate()
        .filter_map(|(i, a)| match replaced.remove(&i) {
            Some(r) => r,
            None => Some(a),
        })
        .collect();

    // Folders, deepest first, so a folder knows whether anything inside it stays.
    let mut keep_local: HashSet<String> = HashSet::new(); // paths that will exist here and must exist on Drive
    let mut keep_remote: HashSet<String> = HashSet::new(); // paths that will exist on Drive and must exist here
    for a in &actions {
        match a {
            Action::Upload { path, .. } => {
                keep_local.insert(path.clone());
            }
            Action::MoveRemote { to, .. } => {
                keep_local.insert(to.clone());
            }
            Action::Download { path, .. } => {
                keep_remote.insert(path.clone());
            }
            Action::MoveLocal { to, .. } => {
                keep_remote.insert(to.clone());
            }
            _ => {}
        }
    }
    // Everything that stays on both sides also keeps its folders.
    for p in local.keys() {
        if remote.contains_key(p) {
            keep_local.insert(p.clone());
            keep_remote.insert(p.clone());
        }
    }
    dirs.sort_by(|a, b| depth(b).cmp(&depth(a)).then(a.cmp(b)));
    let mut dir_actions = Vec::new();
    for p in dirs {
        let (l, r, b) = (local.get(&p), remote.get(&p), base.get(&p));
        let action = match (l, r, b) {
            (Some(_), Some(r), b) => {
                if b.map(|b| b.id != r.id).unwrap_or(true) {
                    Some(Action::Record(p.clone()))
                } else {
                    None
                }
            }
            (Some(_), None, None) => Some(Action::MkdirRemote(p.clone())),
            (Some(_), None, Some(_)) => {
                if drive_wins || !keep_local.iter().any(|k| under(k, &p)) {
                    Some(Action::DeleteLocal(p.clone()))
                } else {
                    Some(Action::MkdirRemote(p.clone()))
                }
            }
            (None, Some(_), None) => Some(Action::MkdirLocal(p.clone())),
            (None, Some(r), Some(_)) => {
                if drive_wins || keep_remote.iter().any(|k| under(k, &p)) {
                    Some(Action::MkdirLocal(p.clone()))
                } else {
                    Some(Action::TrashRemote { path: p.clone(), id: r.id.clone() })
                }
            }
            (None, None, Some(_)) => Some(Action::Forget(p.clone())),
            (None, None, None) => None,
        };
        if let Some(a) = action {
            match &a {
                Action::MkdirRemote(p) => {
                    keep_local.insert(p.clone());
                }
                Action::MkdirLocal(p) => {
                    keep_remote.insert(p.clone());
                }
                _ => {}
            }
            dir_actions.push(a);
        }
    }
    actions.extend(dir_actions);

    // The order they run in: folders before what goes in them; moves before the trash.
    let rank = |a: &Action| match a {
        Action::MkdirRemote(_) => 0,
        Action::MoveRemote { .. } => 1,
        Action::Upload { .. } => 2,
        Action::MkdirLocal(_) => 3,
        Action::MoveLocal { .. } => 4,
        Action::Download { .. } => 5,
        Action::TrashRemote { .. } => 6,
        Action::DeleteLocal(_) => 7,
        Action::Record(_) => 8,
        Action::Forget(_) => 9,
    };
    let key = |a: &Action| -> String {
        match a {
            Action::MkdirRemote(p) | Action::MkdirLocal(p) | Action::DeleteLocal(p) | Action::Record(p) | Action::Forget(p) => p.clone(),
            Action::Upload { path, .. } | Action::Download { path, .. } | Action::TrashRemote { path, .. } => path.clone(),
            Action::MoveRemote { to, .. } | Action::MoveLocal { to, .. } => to.clone(),
        }
    };
    actions.sort_by(|a, b| rank(a).cmp(&rank(b)).then(depth(&key(a)).cmp(&depth(&key(b)))).then(key(a).cmp(&key(b))));
    actions
}

// ── Remote tree ──────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RNode {
    pub name: String,
    pub parent: String,
    pub dir: bool,
    pub size: u64,
    pub modified: i64,
    pub md5: Option<String>,
}

impl RNode {
    fn from(f: &RemoteFile) -> Option<RNode> {
        if f.trashed || f.is_google_doc() || f.name.contains('/') || f.name.contains('\\') {
            return None;
        }
        Some(RNode {
            name: f.name.clone(),
            parent: f.parents.first().cloned().unwrap_or_default(),
            dir: f.is_dir(),
            size: f.size(),
            modified: f.modified_ms(),
            md5: f.md5_checksum.clone(),
        })
    }
}

/// Path of every node under `root` (nodes outside it are left out). Two items with one path: the
/// newer one is used.
pub fn remote_paths(root: &str, nodes: &HashMap<String, RNode>) -> BTreeMap<String, RemoteEntry> {
    fn path_of(id: &str, root: &str, nodes: &HashMap<String, RNode>, memo: &mut HashMap<String, Option<String>>, depth: usize) -> Option<String> {
        if id == root {
            return Some(String::new());
        }
        if let Some(p) = memo.get(id) {
            return p.clone();
        }
        let result = (|| {
            if depth > 64 {
                return None;
            }
            let n = nodes.get(id)?;
            let parent = path_of(&n.parent, root, nodes, memo, depth + 1)?;
            Some(if parent.is_empty() { n.name.clone() } else { format!("{}/{}", parent, n.name) })
        })();
        memo.insert(id.to_string(), result.clone());
        result
    }
    let mut memo = HashMap::new();
    let mut out: BTreeMap<String, RemoteEntry> = BTreeMap::new();
    for (id, n) in nodes {
        if let Some(p) = path_of(id, root, nodes, &mut memo, 0) {
            let e = RemoteEntry { id: id.clone(), dir: n.dir, size: n.size, modified: n.modified, md5: n.md5.clone() };
            match out.get(&p) {
                Some(old) if (old.modified, &old.id) >= (e.modified, &e.id) => {}
                _ => {
                    out.insert(p, e);
                }
            }
        }
    }
    out
}

// ── Local tree ───────────────────────────────────────────────────────────────────────────────

/// Files the sync never touches: temp files of in-progress writes, Windows' folder files.
pub fn ignored(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".tmp") || lower == "desktop.ini" || lower == "thumbs.db"
}

fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn file_md5(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut f = fs::File::open(path)?;
    let mut h = Md5::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{:02x}", b)).collect())
}

fn scan_local(root: &Path) -> BTreeMap<String, LocalEntry> {
    fn walk(dir: &Path, rel: &str, out: &mut BTreeMap<String, LocalEntry>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if ignored(&name) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let path = if rel.is_empty() { name.clone() } else { format!("{}/{}", rel, name) };
            if meta.is_dir() {
                out.insert(path.clone(), LocalEntry { dir: true, size: 0, mtime: 0, md5: None });
                walk(&entry.path(), &path, out);
            } else if meta.is_file() {
                out.insert(path, LocalEntry { dir: false, size: meta.len(), mtime: mtime_ms(&meta), md5: None });
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, "", &mut out);
    out
}

fn local_path(root: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(root.to_path_buf(), |p, part| p.join(part))
}

fn set_mtime(path: &Path, ms: i64) {
    if ms <= 0 {
        return;
    }
    if let Ok(f) = fs::OpenOptions::new().write(true).open(path) {
        let _ = f.set_modified(UNIX_EPOCH + Duration::from_millis(ms as u64));
    }
}

fn split(rel: &str) -> (&str, &str) {
    match rel.rfind('/') {
        Some(i) => (&rel[..i], &rel[i + 1..]),
        None => ("", rel),
    }
}

// ── State kept between runs ──────────────────────────────────────────────────────────────────

#[derive(Default, Serialize, Deserialize)]
pub struct SyncState {
    pub folder_id: Option<String>,
    pub folder_name: Option<String>,
    pub page_token: Option<String>,
    #[serde(default)]
    pub nodes: HashMap<String, RNode>,
    #[serde(default)]
    pub base: BTreeMap<String, BaseEntry>,
}

#[derive(Default, Serialize, Deserialize)]
pub struct Auth {
    pub refresh_token: String,
    pub email: Option<String>,
}

// ── What the UI sees ─────────────────────────────────────────────────────────────────────────

#[derive(Clone, Default, Serialize)]
pub struct Status {
    pub configured: bool,
    pub signed_in: bool,
    pub email: Option<String>,
    pub folder: Option<String>,
    pub busy: bool,
    pub done: u32,
    pub total: u32,
    pub bytes_done: u64,
    pub bytes_total: u64,
    /// Changes made here that are not on Drive yet (closing the app now would lose them).
    pub pending_up: u32,
    pub error: Option<String>,
    pub last_sync: Option<i64>,
}

#[derive(Default)]
pub struct Shared {
    pub status: Status,
    pub root: Option<PathBuf>,
    /// Something was written here: scan now (also counts as pending until scanned).
    pub dirty: bool,
    /// A new Drive folder was picked: start over with it.
    pub new_folder: Option<(String, String)>,
    pub auth_changed: bool,
    /// Ends the sync thread (tests: a second engine stands in for the next app start).
    pub stop: bool,
}

pub struct SyncHandle {
    pub shared: Mutex<Shared>,
    pub wake: Condvar,
    pub dir: PathBuf,
}

impl SyncHandle {
    pub fn poke(&self) {
        self.shared.lock().unwrap().dirty = true;
        self.wake.notify_all();
    }
    pub fn auth_file(&self) -> PathBuf {
        self.dir.join("drive_auth.json")
    }
    pub fn load_auth(&self) -> Option<Auth> {
        serde_json::from_str(&fs::read_to_string(self.auth_file()).ok()?).ok()
    }
    /// Changes not on Drive yet: known ones, plus a write not scanned yet.
    pub fn pending(&self) -> u32 {
        let s = self.shared.lock().unwrap();
        if !s.status.signed_in || s.status.folder.is_none() {
            return 0;
        }
        s.status.pending_up + if s.dirty { 1 } else { 0 }
    }
}

// ── The engine ───────────────────────────────────────────────────────────────────────────────

pub struct Engine {
    handle: Arc<SyncHandle>,
    state: SyncState,
    drive: Option<Drive>,
    md5_cache: HashMap<String, (u64, i64, String)>,
    last_remote: Option<Instant>,
    last_local: Option<Instant>,
    retry_at: Option<Instant>,
    /// The first cycle since start: local edits to synced files lose to Drive.
    fresh_start: bool,
    notify: Box<dyn Fn(&Status, bool) + Send>,
}

impl Engine {
    /// Starts the sync thread. `notify(status, local_changed)` is called on every progress step.
    pub fn start(dir: PathBuf, notify: impl Fn(&Status, bool) + Send + 'static) -> Arc<SyncHandle> {
        let handle = Arc::new(SyncHandle { shared: Mutex::new(Shared::default()), wake: Condvar::new(), dir });
        let state: SyncState = fs::read_to_string(handle.dir.join("drive_sync.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        {
            let mut s = handle.shared.lock().unwrap();
            s.status.configured = drive::configured();
            let auth = handle.load_auth();
            s.status.signed_in = auth.is_some();
            s.status.email = auth.and_then(|a| a.email);
            s.status.folder = state.folder_name.clone();
        }
        let mut engine = Engine {
            handle: handle.clone(),
            state,
            drive: None,
            md5_cache: HashMap::new(),
            last_remote: None,
            last_local: None,
            retry_at: None,
            fresh_start: true,
            notify: Box::new(notify),
        };
        std::thread::spawn(move || engine.run());
        handle
    }

    fn save_state(&self) {
        let file = self.handle.dir.join("drive_sync.json");
        let tmp = file.with_extension("json.tmp");
        if let Ok(json) = serde_json::to_string(&self.state) {
            if fs::write(&tmp, json).is_ok() {
                let _ = fs::rename(&tmp, &file);
            }
        }
    }

    fn update(&self, local_changed: bool, f: impl FnOnce(&mut Status)) {
        let status = {
            let mut s = self.handle.shared.lock().unwrap();
            f(&mut s.status);
            s.status.clone()
        };
        (self.notify)(&status, local_changed);
    }

    fn run(&mut self) {
        loop {
            let (root, dirty, new_folder, auth_changed) = {
                let mut s = self.handle.shared.lock().unwrap();
                if !s.dirty && s.new_folder.is_none() && !s.auth_changed {
                    s = self.handle.wake.wait_timeout(s, Duration::from_secs(1)).unwrap().0;
                }
                if s.stop {
                    return;
                }
                (s.root.clone(), s.dirty, s.new_folder.take(), std::mem::take(&mut s.auth_changed))
            };
            if auth_changed {
                self.drive = None;
                let auth = self.handle.load_auth();
                self.update(false, |st| {
                    st.signed_in = auth.is_some();
                    st.email = auth.and_then(|a| a.email);
                    st.error = None;
                });
                self.retry_at = None;
            }
            if let Some((id, name)) = new_folder {
                self.state = SyncState { folder_id: Some(id), folder_name: Some(name.clone()), ..Default::default() };
                self.save_state();
                self.last_remote = None;
                self.retry_at = None;
                self.fresh_start = false; // nothing was synced with this folder yet: a plain merge
                self.update(false, |st| {
                    st.folder = Some(name);
                    st.error = None;
                });
            }
            let Some(root) = root else { continue };
            if self.state.folder_id.is_none() || !root.is_dir() {
                continue;
            }
            if self.drive.is_none() {
                match self.handle.load_auth() {
                    Some(a) => self.drive = Some(Drive::new(a.refresh_token)),
                    None => continue,
                }
            }
            let now = Instant::now();
            if let Some(t) = self.retry_at {
                if now < t && !dirty {
                    continue;
                }
            }
            let remote_due = self.last_remote.map(|t| now.duration_since(t) >= REMOTE_EVERY).unwrap_or(true);
            let local_due = dirty || self.last_local.map(|t| now.duration_since(t) >= LOCAL_EVERY).unwrap_or(true);
            if !remote_due && !local_due {
                continue;
            }
            match self.cycle(&root, remote_due) {
                Ok(()) => {
                    self.retry_at = None;
                    self.update(false, |st| st.error = None);
                }
                Err(e) => {
                    self.retry_at = Some(Instant::now() + RETRY_AFTER);
                    if e.auth {
                        let _ = fs::remove_file(self.handle.auth_file());
                        self.drive = None;
                    }
                    self.update(false, |st| {
                        st.busy = false;
                        st.error = Some(if e.auth { "Signed out of Google: sign in again".into() } else { e.message.clone() });
                        if e.auth {
                            st.signed_in = false;
                        }
                    });
                }
            }
        }
    }

    fn cycle(&mut self, root: &Path, remote_due: bool) -> Result<(), DriveError> {
        let folder = self.state.folder_id.clone().unwrap();
        if self.state.page_token.is_none() {
            self.update(false, |st| st.busy = true);
            let drive = self.drive.as_mut().unwrap();
            let token = drive.start_page_token()?;
            let mut nodes = HashMap::new();
            list_tree(drive, &folder, &mut nodes)?;
            self.state.nodes = nodes;
            self.state.page_token = Some(token);
            self.save_state();
            self.last_remote = Some(Instant::now());
        } else if remote_due {
            self.pull_changes(&folder)?;
            self.last_remote = Some(Instant::now());
        }

        // The local view; a write made during the scan is caught next time.
        self.handle.shared.lock().unwrap().dirty = false;
        let mut local = scan_local(root);
        self.last_local = Some(Instant::now());
        for (path, e) in local.iter_mut() {
            if e.dir {
                continue;
            }
            if let Some(b) = self.state.base.get(path) {
                if b.size == e.size && b.mtime == e.mtime {
                    e.md5 = b.md5.clone();
                    continue;
                }
            }
            if let Some((size, mtime, md5)) = self.md5_cache.get(path) {
                if *size == e.size && *mtime == e.mtime {
                    e.md5 = Some(md5.clone());
                    continue;
                }
            }
            if let Ok(m) = file_md5(&local_path(root, path)) {
                self.md5_cache.insert(path.clone(), (e.size, e.mtime, m.clone()));
                e.md5 = Some(m);
            }
        }
        let remote = remote_paths(&folder, &self.state.nodes);
        let drive_wins = self.fresh_start && !self.state.base.is_empty();
        let actions = plan(&local, &remote, &self.state.base, drive_wins);
        self.fresh_start = false;

        let work: Vec<&Action> = actions.iter().filter(|a| a.is_work()).collect();
        let size_of = |a: &Action| -> u64 {
            match a {
                Action::Upload { path, .. } => local.get(path).map(|e| e.size).unwrap_or(0),
                Action::Download { path, .. } => remote.get(path).map(|e| e.size).unwrap_or(0),
                _ => 0,
            }
        };
        let total = work.len() as u32;
        let bytes_total: u64 = work.iter().map(|a| size_of(a)).sum();
        let mut pending_up = work.iter().filter(|a| a.is_upload_side()).count() as u32;
        if total > 0 {
            self.update(false, |st| {
                st.busy = true;
                st.done = 0;
                st.total = total;
                st.bytes_done = 0;
                st.bytes_total = bytes_total;
                st.pending_up = pending_up;
            });
        }

        let mut ids: HashMap<String, String> = remote.iter().filter(|(_, e)| e.dir).map(|(p, e)| (p.clone(), e.id.clone())).collect();
        ids.insert(String::new(), folder.clone());
        let mut gone_remote: Vec<String> = Vec::new();
        let mut gone_local: Vec<String> = Vec::new();
        let (mut done, mut bytes_done) = (0u32, 0u64);
        let mut local_changed = false;
        let mut last_save = Instant::now();
        for a in &actions {
            let skip = match a {
                Action::TrashRemote { path, .. } => gone_remote.iter().any(|g| under(path, g)),
                Action::DeleteLocal(path) => gone_local.iter().any(|g| under(path, g)),
                _ => false,
            };
            if !skip {
                self.apply(root, a, &local, &remote, &mut ids)?;
            } else {
                self.forget_tree(match a {
                    Action::TrashRemote { path, .. } | Action::DeleteLocal(path) => path,
                    _ => unreachable!(),
                });
            }
            match a {
                Action::TrashRemote { path, .. } => gone_remote.push(path.clone()),
                Action::DeleteLocal(path) => gone_local.push(path.clone()),
                _ => {}
            }
            if matches!(a, Action::MkdirLocal(_) | Action::MoveLocal { .. } | Action::Download { .. } | Action::DeleteLocal(_)) {
                local_changed = true;
            }
            if a.is_work() {
                done += 1;
                bytes_done += size_of(a);
                if a.is_upload_side() {
                    pending_up -= 1;
                }
                if last_save.elapsed() > Duration::from_secs(2) {
                    self.save_state();
                    last_save = Instant::now();
                }
                let changed_now = local_changed && matches!(a, Action::Download { .. } | Action::MoveLocal { .. });
                self.update(changed_now, |st| {
                    st.done = done;
                    st.bytes_done = bytes_done;
                    st.pending_up = pending_up;
                });
            }
        }
        self.save_state();
        let finished = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        self.update(local_changed, |st| {
            st.busy = false;
            st.pending_up = 0;
            st.last_sync = Some(finished);
            if total == 0 {
                st.done = 0;
                st.total = 0;
            }
        });
        Ok(())
    }

    /// Applies Drive's changes since the last look to the known tree.
    fn pull_changes(&mut self, folder: &str) -> Result<(), DriveError> {
        let drive = self.drive.as_mut().unwrap();
        let (changes, token) = drive.changes(self.state.page_token.as_deref().unwrap())?;
        if changes.is_empty() {
            self.state.page_token = Some(token);
            return Ok(());
        }
        let before: HashSet<String> = remote_paths(folder, &self.state.nodes).values().map(|e| e.id.clone()).collect();
        for c in &changes {
            if c.file_id == folder && (c.removed || c.file.as_ref().map(|f| f.trashed).unwrap_or(false)) {
                return Err(DriveError { message: "The Drive folder was removed or trashed; pick a folder again".into(), auth: false });
            }
            if c.file_id == folder || (!c.removed && c.file.is_none()) {
                continue;
            }
            match c.file.as_ref().and_then(|f| if c.removed { None } else { RNode::from(f) }) {
                Some(n) => {
                    self.state.nodes.insert(c.file_id.clone(), n);
                }
                None => {
                    self.state.nodes.remove(&c.file_id);
                }
            }
        }
        // Keep only what is inside the folder; a folder that newly appeared in it (moved in from
        // elsewhere in Drive) has its contents listed, as those files did not change themselves.
        let now = remote_paths(folder, &self.state.nodes);
        let inside: HashSet<String> = now.values().map(|e| e.id.clone()).collect();
        self.state.nodes.retain(|id, _| inside.contains(id));
        let arrived: Vec<String> = now.values().filter(|e| e.dir && !before.contains(&e.id)).map(|e| e.id.clone()).collect();
        for id in arrived {
            list_tree(drive, &id, &mut self.state.nodes)?;
        }
        self.state.page_token = Some(token);
        self.save_state();
        Ok(())
    }

    /// Drops a path and everything under it from the base. (Drive's tree is left alone: a folder renamed
    /// on Drive has the same id at its new path.)
    fn forget_tree(&mut self, path: &str) {
        let doomed: Vec<String> = self.state.base.keys().filter(|k| *k == path || under(k, path)).cloned().collect();
        for k in doomed {
            self.state.base.remove(&k);
        }
    }

    fn record(&mut self, path: &str, id: &str, dir: bool, local_file: &Path, r: &RNode) {
        let (size, mtime) = if dir { (0, 0) } else { fs::metadata(local_file).map(|m| (m.len(), mtime_ms(&m))).unwrap_or((0, 0)) };
        self.state.base.insert(path.to_string(), BaseEntry { id: id.to_string(), dir, size, mtime, rmod: r.modified, md5: r.md5.clone() });
    }

    fn put_node(&mut self, f: &RemoteFile) -> RNode {
        let n = RNode::from(f).unwrap_or(RNode { name: f.name.clone(), parent: String::new(), dir: f.is_dir(), size: f.size(), modified: f.modified_ms(), md5: f.md5_checksum.clone() });
        self.state.nodes.insert(f.id.clone(), n.clone());
        n
    }

    fn apply(
        &mut self,
        root: &Path,
        a: &Action,
        local: &BTreeMap<String, LocalEntry>,
        remote: &BTreeMap<String, RemoteEntry>,
        ids: &mut HashMap<String, String>,
    ) -> Result<(), DriveError> {
        let parent_id = |ids: &HashMap<String, String>, rel: &str| -> Result<String, DriveError> {
            let (dir, _) = split(rel);
            ids.get(dir).cloned().ok_or_else(|| DriveError { message: format!("No Drive folder for {}", dir), auth: false })
        };
        match a {
            Action::MkdirRemote(path) => {
                let parent = parent_id(ids, path)?;
                let f = self.drive.as_mut().unwrap().create_folder(&parent, split(path).1)?;
                let n = self.put_node(&f);
                ids.insert(path.clone(), f.id.clone());
                self.record(path, &f.id, true, &local_path(root, path), &n);
            }
            Action::Upload { path, id } => {
                let parent = parent_id(ids, path)?;
                let file = local_path(root, path);
                let mtime = local.get(path).map(|e| e.mtime).unwrap_or(0);
                let f = self.drive.as_mut().unwrap().upload(id.as_deref(), &parent, split(path).1, &file, mtime)?;
                let n = self.put_node(&f);
                self.record(path, &f.id, false, &file, &n);
            }
            Action::MoveRemote { id, from, to } => {
                let new_parent = parent_id(ids, to)?;
                let old_parent = self.state.nodes.get(id).map(|n| n.parent.clone()).unwrap_or_else(|| new_parent.clone());
                let f = self.drive.as_mut().unwrap().move_to(id, split(to).1, &new_parent, &old_parent)?;
                let n = self.put_node(&f);
                self.state.base.remove(from);
                self.record(to, id, false, &local_path(root, to), &n);
            }
            Action::MkdirLocal(path) => {
                fs::create_dir_all(local_path(root, path))?;
                let r = &remote[path];
                ids.insert(path.clone(), r.id.clone());
                let n = self.state.nodes.get(&r.id).cloned().unwrap();
                self.record(path, &r.id, true, &local_path(root, path), &n);
            }
            Action::MoveLocal { id, from, to } => {
                let dest = local_path(root, to);
                if let Some(dir) = dest.parent() {
                    fs::create_dir_all(dir)?;
                }
                fs::rename(local_path(root, from), &dest)?;
                let n = self.state.nodes.get(id).cloned().unwrap();
                set_mtime(&dest, n.modified);
                self.state.base.remove(from);
                self.record(to, id, false, &dest, &n);
            }
            Action::Download { path, id } => {
                let dest = local_path(root, path);
                self.drive.as_mut().unwrap().download(id, &dest)?;
                let n = self.state.nodes.get(id).cloned().unwrap();
                set_mtime(&dest, n.modified);
                self.record(path, id, false, &dest, &n);
            }
            Action::TrashRemote { path, id } => {
                self.drive.as_mut().unwrap().trash(id)?;
                self.forget_tree(path);
                self.state.nodes.remove(id);
            }
            Action::DeleteLocal(path) => {
                let p = local_path(root, path);
                if p.exists() {
                    trash::delete(&p).map_err(|e| DriveError { message: format!("{}: {}", p.display(), e), auth: false })?;
                }
                self.forget_tree(path);
            }
            Action::Record(path) => {
                let r = &remote[path];
                let n = self.state.nodes.get(&r.id).cloned().unwrap();
                if r.dir {
                    ids.insert(path.clone(), r.id.clone());
                }
                self.record(path, &r.id, r.dir, &local_path(root, path), &n);
            }
            Action::Forget(path) => {
                self.state.base.remove(path);
            }
        }
        Ok(())
    }
}

/// Everything under a Drive folder, into `nodes` (breadth first, one request per folder).
fn list_tree(drive: &mut Drive, top: &str, nodes: &mut HashMap<String, RNode>) -> Result<(), DriveError> {
    let mut queue = vec![top.to_string()];
    while let Some(dir) = queue.pop() {
        for f in drive.children(&dir, false)? {
            if let Some(n) = RNode::from(&f) {
                if n.dir {
                    queue.push(f.id.clone());
                }
                nodes.insert(f.id.clone(), n);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lf(md5: &str, mtime: i64) -> LocalEntry {
        LocalEntry { dir: false, size: md5.len() as u64, mtime, md5: Some(md5.into()) }
    }
    fn ld() -> LocalEntry {
        LocalEntry { dir: true, size: 0, mtime: 0, md5: None }
    }
    fn rf(id: &str, md5: &str, modified: i64) -> RemoteEntry {
        RemoteEntry { id: id.into(), dir: false, size: md5.len() as u64, modified, md5: Some(md5.into()) }
    }
    fn rd(id: &str) -> RemoteEntry {
        RemoteEntry { id: id.into(), dir: true, size: 0, modified: 0, md5: None }
    }
    fn bf(id: &str, md5: &str) -> BaseEntry {
        BaseEntry { id: id.into(), dir: false, size: md5.len() as u64, mtime: 1, rmod: 1, md5: Some(md5.into()) }
    }
    fn bd(id: &str) -> BaseEntry {
        BaseEntry { id: id.into(), dir: true, size: 0, mtime: 0, rmod: 0, md5: None }
    }
    fn m<V: Clone>(items: &[(&str, V)]) -> BTreeMap<String, V> {
        items.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }
    fn up(p: &str, id: Option<&str>) -> Action {
        Action::Upload { path: p.into(), id: id.map(Into::into) }
    }
    fn down(p: &str, id: &str) -> Action {
        Action::Download { path: p.into(), id: id.into() }
    }

    #[test]
    fn new_on_one_side_is_copied() {
        let a = plan(&m(&[("t", ld()), ("t/a", lf("aa", 5))]), &m(&[("u", rd("U")), ("u/b", rf("B", "bb", 5))]), &BTreeMap::new(), false);
        assert_eq!(a, vec![Action::MkdirRemote("t".into()), up("t/a", None), Action::MkdirLocal("u".into()), down("u/b", "B")]);
    }

    #[test]
    fn changed_on_one_side_wins_that_way() {
        let base = m(&[("a", bf("A", "old")), ("b", bf("B", "old"))]);
        let a = plan(&m(&[("a", lf("new", 9)), ("b", lf("old", 1))]), &m(&[("a", rf("A", "old", 1)), ("b", rf("B", "new", 9))]), &base, false);
        assert_eq!(a, vec![up("a", Some("A")), down("b", "B")]);
    }

    #[test]
    fn changed_on_both_sides_newest_wins() {
        let base = m(&[("a", bf("A", "old")), ("b", bf("B", "old"))]);
        let a = plan(&m(&[("a", lf("mine", 20)), ("b", lf("mine", 10))]), &m(&[("a", rf("A", "theirs", 10)), ("b", rf("B", "theirs", 20))]), &base, false);
        assert_eq!(a, vec![up("a", Some("A")), down("b", "B")]);
    }

    #[test]
    fn same_content_only_records() {
        let a = plan(&m(&[("a", lf("x", 3))]), &m(&[("a", rf("A", "x", 7))]), &BTreeMap::new(), false);
        assert_eq!(a, vec![Action::Record("a".into())]);
    }

    #[test]
    fn removals_mirror_unless_changed_since() {
        let base = m(&[("a", bf("A", "x")), ("b", bf("B", "x")), ("c", bf("C", "x")), ("d", bf("D", "x"))]);
        let local = m(&[("a", lf("x", 1)), ("b", lf("changed", 5))]);
        let remote = m(&[("c", rf("C", "x", 1)), ("d", rf("D", "changed", 5))]);
        let a = plan(&local, &remote, &base, false);
        assert_eq!(a, vec![up("b", None), down("d", "D"), Action::TrashRemote { path: "c".into(), id: "C".into() }, Action::DeleteLocal("a".into())]);
    }

    #[test]
    fn local_rename_is_a_move_on_drive() {
        let base = m(&[("t", bd("T")), ("t/old", bd("O")), ("t/old/p.jpg", bf("P", "jpg"))]);
        let local = m(&[("t", ld()), ("t/new", ld()), ("t/new/p.jpg", lf("jpg", 1))]);
        let remote = m(&[("t", rd("T")), ("t/old", rd("O")), ("t/old/p.jpg", rf("P", "jpg", 1))]);
        let a = plan(&local, &remote, &base, false);
        assert_eq!(
            a,
            vec![
                Action::MkdirRemote("t/new".into()),
                Action::MoveRemote { id: "P".into(), from: "t/old/p.jpg".into(), to: "t/new/p.jpg".into() },
                Action::TrashRemote { path: "t/old".into(), id: "O".into() },
            ]
        );
    }

    #[test]
    fn drive_rename_is_a_move_here() {
        let base = m(&[("r", bd("R")), ("r/x - recording.gpx", bf("G", "gpx"))]);
        let local = m(&[("r", ld()), ("r/x - recording.gpx", lf("gpx", 1))]);
        let remote = m(&[("r", rd("R")), ("r/x - y.gpx", rf("G", "gpx", 1))]);
        let a = plan(&local, &remote, &base, false);
        assert_eq!(a, vec![Action::MoveLocal { id: "G".into(), from: "r/x - recording.gpx".into(), to: "r/x - y.gpx".into() }]);
    }

    #[test]
    fn folder_removed_on_drive_stays_if_something_new_is_inside() {
        let base = m(&[("t", bd("T")), ("t/a", bf("A", "x"))]);
        let local = m(&[("t", ld()), ("t/a", lf("x", 1)), ("t/new", lf("n", 2))]);
        let a = plan(&local, &BTreeMap::new(), &base, false);
        assert_eq!(a, vec![Action::MkdirRemote("t".into()), up("t/new", None), Action::DeleteLocal("t/a".into())]);
    }

    #[test]
    fn drive_wins_on_start_for_synced_files_only() {
        let base = m(&[("a", bf("A", "old")), ("b", bf("B", "x"))]);
        let local = m(&[("a", lf("edited", 9)), ("n", lf("new", 9))]);
        let remote = m(&[("a", rf("A", "old", 1)), ("b", rf("B", "x", 1))]);
        let a = plan(&local, &remote, &base, true);
        assert_eq!(a, vec![up("n", None), down("a", "A"), down("b", "B")]);
    }

    #[test]
    fn remote_paths_follow_parents() {
        let mut nodes = HashMap::new();
        nodes.insert("T".to_string(), RNode { name: "trip".into(), parent: "ROOT".into(), dir: true, size: 0, modified: 0, md5: None });
        nodes.insert("A".to_string(), RNode { name: "a.txt".into(), parent: "T".into(), dir: false, size: 1, modified: 5, md5: Some("x".into()) });
        nodes.insert("Z".to_string(), RNode { name: "elsewhere".into(), parent: "OTHER".into(), dir: false, size: 1, modified: 5, md5: None });
        let p = remote_paths("ROOT", &nodes);
        assert_eq!(p.keys().cloned().collect::<Vec<_>>(), vec!["trip".to_string(), "trip/a.txt".to_string()]);
    }
}

/// Runs against real Google Drive with the app's saved sign-in (`cargo test live -- --ignored --nocapture`).
/// Works in a fresh subfolder of "Trip Explorer test" on Drive and a temp copy of trips-sample.
#[cfg(test)]
mod live {
    use super::*;

    fn copy_dir(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for e in fs::read_dir(from).unwrap().flatten() {
            let dest = to.join(e.file_name());
            if e.path().is_dir() {
                copy_dir(&e.path(), &dest);
            } else {
                fs::copy(e.path(), &dest).unwrap();
            }
        }
    }

    /// Waits until the engine has finished a cycle that started after now.
    fn settle(h: &SyncHandle, what: &str, max: Duration) -> Status {
        let t0 = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
        let start = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(300));
            let s = h.shared.lock().unwrap().status.clone();
            if let Some(e) = &s.error {
                panic!("{}: sync error {}", what, e);
            }
            if !s.busy && s.last_sync.map(|t| t > t0).unwrap_or(false) && !h.shared.lock().unwrap().dirty {
                println!("[{}] settled in {:.1}s ({} actions)", what, start.elapsed().as_secs_f32(), s.total);
                return s;
            }
            assert!(start.elapsed() < max, "{}: did not settle", what);
        }
    }

    fn remote_tree(d: &mut Drive, folder: &str) -> BTreeMap<String, RemoteEntry> {
        let mut nodes = HashMap::new();
        list_tree(d, folder, &mut nodes).unwrap();
        remote_paths(folder, &nodes)
    }

    fn local_tree(root: &Path) -> BTreeMap<String, Option<String>> {
        scan_local(root).into_iter().map(|(p, e)| (p.clone(), if e.dir { None } else { Some(file_md5(&local_path(root, &p)).unwrap()) })).collect()
    }

    fn assert_same(d: &mut Drive, folder: &str, root: &Path, what: &str) {
        let r: BTreeMap<String, Option<String>> = remote_tree(d, folder).into_iter().map(|(p, e)| (p, if e.dir { None } else { e.md5 })).collect();
        let l = local_tree(root);
        assert_eq!(l, r, "{}: local and Drive differ", what);
        println!("[{}] local == Drive ({} items)", what, l.len());
    }

    fn start(data: &Path, root: &Path) -> Arc<SyncHandle> {
        let h = Engine::start(data.to_path_buf(), |_, _| {});
        h.shared.lock().unwrap().root = Some(root.to_path_buf());
        h.poke();
        h
    }

    #[test]
    #[ignore]
    fn live_round_trip() {
        let appdata = PathBuf::from(std::env::var("APPDATA").unwrap()).join("com.lotanbar.tripexplorer");
        let auth: Auth = serde_json::from_str(&fs::read_to_string(appdata.join("drive_auth.json")).expect("sign in with the app first")).unwrap();
        let mut d = Drive::new(auth.refresh_token.clone());

        // Drive: "Trip Explorer test/<run>"
        let top = match d.children("root", true).unwrap().into_iter().find(|f| f.name == "Trip Explorer test") {
            Some(f) => f,
            None => d.create_folder("root", "Trip Explorer test").unwrap(),
        };
        let run = format!("run {}", chrono::Local::now().format("%Y-%m-%d %H-%M-%S"));
        let folder = d.create_folder(&top.id, &run).unwrap().id;

        // Local: a temp copy of trips-sample, and a temp data dir holding the sign-in.
        let tmp = std::env::temp_dir().join(format!("te-sync-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let root = tmp.join("trips");
        let data = tmp.join("data");
        copy_dir(Path::new("C:/Users/Lotan/Desktop/trips-sample"), &root);
        fs::create_dir_all(&data).unwrap();
        fs::copy(appdata.join("drive_auth.json"), data.join("drive_auth.json")).unwrap();

        // 1. First sync uploads everything.
        let h = start(&data, &root);
        h.shared.lock().unwrap().new_folder = Some((folder.clone(), run.clone()));
        h.wake.notify_all();
        settle(&h, "initial upload", Duration::from_secs(120));
        assert_same(&mut d, &folder, &root, "initial upload");
        let before = remote_tree(&mut d, &folder);

        // 2. A local edit goes up (same file id).
        let desc = root.join("Greece 2026/Kastro cave/description.txt");
        fs::write(&desc, "Edited on the PC").unwrap();
        h.poke();
        settle(&h, "local edit", Duration::from_secs(60));
        assert_same(&mut d, &folder, &root, "local edit");
        assert_eq!(remote_tree(&mut d, &folder)["Greece 2026/Kastro cave/description.txt"].id, before["Greece 2026/Kastro cave/description.txt"].id);

        // 3. A local POI rename is a move on Drive: the files keep their ids.
        fs::rename(root.join("Greece 2026/Portara"), root.join("Greece 2026/Portara of Naxos")).unwrap();
        h.poke();
        settle(&h, "local rename", Duration::from_secs(60));
        assert_same(&mut d, &folder, &root, "local rename");
        let after = remote_tree(&mut d, &folder);
        assert_eq!(after["Greece 2026/Portara of Naxos/coordinates.txt"].id, before["Greece 2026/Portara/coordinates.txt"].id);

        // 4. An edit on Drive comes down (within the 30 s remote poll).
        let plan_path = "plans/Naxos.txt";
        let edited = tmp.join("naxos-edit.txt");
        fs::write(&edited, "Edited on the phone\n").unwrap();
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
        d.upload(Some(&after[plan_path].id), "", "Naxos.txt", &edited, now_ms).unwrap();
        // 5. A rename on Drive is a rename here (no download).
        let gpx_old = "Greece 2026/recordings/2026-09-27 16-02-40 - recording.gpx";
        let rec_dir = after["Greece 2026/recordings"].id.clone();
        d.move_to(&after[gpx_old].id, "2026-09-27 16-02-40 - 17-00-00.gpx", &rec_dir, &rec_dir).unwrap();
        // 5b. A POI folder renamed on Drive is renamed here.
        d.move_to(&after["Greece 2026/Kastro cave"].id, "Kastro cave (closed)", &after["Greece 2026"].id, &after["Greece 2026"].id).unwrap();
        // 6. A file trashed on Drive goes here too.
        d.trash(&after["Greece 2026/Kastro cave/datetime.txt"].id).unwrap();
        let kastro = "Greece 2026/Kastro cave (closed)";
        std::thread::sleep(Duration::from_secs(32));
        settle(&h, "Drive changes", Duration::from_secs(60));
        assert_same(&mut d, &folder, &root, "Drive changes");
        assert_eq!(fs::read_to_string(root.join(plan_path)).unwrap(), "Edited on the phone\n");
        assert!(root.join("Greece 2026/recordings/2026-09-27 16-02-40 - 17-00-00.gpx").exists());
        assert!(!root.join(gpx_old).exists());
        assert!(!root.join("Greece 2026/Kastro cave").exists());
        assert!(root.join(kastro).join("description.txt").exists());
        assert!(!root.join(kastro).join("datetime.txt").exists());
        // 6b. A later cycle keeps the renamed folder (its Drive node is still known).
        std::thread::sleep(Duration::from_secs(32));
        settle(&h, "after folder rename", Duration::from_secs(60));
        assert_same(&mut d, &folder, &root, "after folder rename");
        assert!(root.join(kastro).join("description.txt").exists());

        // 7. A local removal goes to Drive's trash.
        fs::remove_file(root.join("plans/Naxos Imported.txt")).unwrap();
        h.poke();
        settle(&h, "local removal", Duration::from_secs(60));
        assert_same(&mut d, &folder, &root, "local removal");

        // 8. App closed with an unsynced edit to a synced file: on the next start Drive wins; a new file still goes up.
        h.shared.lock().unwrap().stop = true;
        std::thread::sleep(Duration::from_secs(2));
        fs::write(root.join(plan_path), "Unsynced PC edit\n").unwrap();
        fs::write(root.join("plans/New plan.txt"), "Made while closed\n").unwrap();
        let h2 = start(&data, &root);
        settle(&h2, "restart", Duration::from_secs(60));
        assert_same(&mut d, &folder, &root, "restart");
        assert_eq!(fs::read_to_string(root.join(plan_path)).unwrap(), "Edited on the phone\n");
        assert!(root.join("plans/New plan.txt").exists());
        h2.shared.lock().unwrap().stop = true;

        d.trash(&folder).unwrap();
        println!("OK — all steps passed; Drive run folder trashed");
    }
}

/// The PC engine against a given Drive folder, as the PC app would run it, for testing with the phone:
/// `TE_FOLDER=<drive folder id> cargo test live_join -- --ignored --nocapture`. Keeps its local copy
/// (a copy of trips-sample the first time) and state in the temp folder between runs.
#[cfg(test)]
mod live_join {
    use super::*;

    #[test]
    #[ignore]
    fn live_join() {
        let folder = std::env::var("TE_FOLDER").expect("TE_FOLDER");
        let appdata = PathBuf::from(std::env::var("APPDATA").unwrap()).join("com.lotanbar.tripexplorer");
        let tmp = std::env::temp_dir().join("te-join");
        let (root, data) = (tmp.join("trips"), tmp.join("data"));
        if !root.exists() {
            fn copy_dir(from: &Path, to: &Path) {
                fs::create_dir_all(to).unwrap();
                for e in fs::read_dir(from).unwrap().flatten() {
                    if e.path().is_dir() { copy_dir(&e.path(), &to.join(e.file_name())) } else { fs::copy(e.path(), to.join(e.file_name())).unwrap(); }
                }
            }
            copy_dir(Path::new("C:/Users/Lotan/Desktop/trips-sample"), &root);
            fs::create_dir_all(&data).unwrap();
            fs::copy(appdata.join("drive_auth.json"), data.join("drive_auth.json")).unwrap();
        }
        let fresh = !data.join("drive_sync.json").exists();
        let h = Engine::start(data.clone(), |_, _| {});
        h.shared.lock().unwrap().root = Some(root.clone());
        if fresh {
            h.shared.lock().unwrap().new_folder = Some((folder, "phone run".into()));
        }
        h.poke();
        let t0 = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
        loop {
            std::thread::sleep(Duration::from_millis(300));
            let s = h.shared.lock().unwrap().status.clone();
            if let Some(e) = s.error { panic!("{}", e) }
            if !s.busy && s.last_sync.map(|t| t > t0).unwrap_or(false) {
                println!("PC engine synced ({} actions)", s.total);
                break;
            }
        }
        h.shared.lock().unwrap().stop = true;
        for (p, e) in scan_local(&root) {
            if !e.dir { println!("  {}", p) }
        }
    }
}

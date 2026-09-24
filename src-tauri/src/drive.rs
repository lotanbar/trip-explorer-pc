//! Google Drive: sign-in (OAuth for installed apps: loopback redirect + PKCE, opened in the system
//! browser) and the few Drive v3 REST calls the sync needs. Blocking; the sync runs on its own thread.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const CLIENT_ID: Option<&str> = option_env!("GOOGLE_CLIENT_ID");
const CLIENT_SECRET: Option<&str> = option_env!("GOOGLE_CLIENT_SECRET");
const SCOPE: &str = "https://www.googleapis.com/auth/drive";
const API: &str = "https://www.googleapis.com/drive/v3";
const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3";
pub const FOLDER_MIME: &str = "application/vnd.google-apps.folder";
const FILE_FIELDS: &str = "id,name,parents,trashed,md5Checksum,size,modifiedTime,mimeType";
/// Files up to this size go up in one multipart request; bigger ones through a resumable session.
const MULTIPART_MAX: u64 = 5 * 1024 * 1024;

pub fn configured() -> bool {
    CLIENT_ID.is_some() && CLIENT_SECRET.is_some()
}

fn client_id() -> Result<&'static str, String> {
    CLIENT_ID.ok_or_else(|| "This build has no Google client (google_oauth.json)".to_string())
}

fn client_secret() -> Result<&'static str, String> {
    CLIENT_SECRET.ok_or_else(|| "This build has no Google client (google_oauth.json)".to_string())
}

// ── Sign-in ──────────────────────────────────────────────────────────────────────────────────

fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::getrandom(&mut buf).expect("random bytes");
    URL_SAFE_NO_PAD.encode(buf)
}

/// Runs the whole browser sign-in: opens Google's consent page through `open_url`, waits (up to five
/// minutes) for the redirect to a one-shot local server, and trades the code for a refresh token.
pub fn sign_in(open_url: impl Fn(&str) -> Result<(), String>) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{}", port);
    let verifier = random_token(48);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_token(16);
    let url = url::Url::parse_with_params(
        "https://accounts.google.com/o/oauth2/v2/auth",
        &[
            ("client_id", client_id()?),
            ("redirect_uri", redirect.as_str()),
            ("response_type", "code"),
            ("scope", SCOPE),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("access_type", "offline"),
            ("prompt", "consent"),
            ("state", state.as_str()),
        ],
    )
    .map_err(|e| e.to_string())?;
    #[cfg(debug_assertions)]
    eprintln!("[drive] sign-in URL: {}", url);
    open_url(url.as_str())?;

    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(300);
    let code = loop {
        if Instant::now() > deadline {
            return Err("Sign-in timed out".into());
        }
        let (mut stream, _) = match listener.accept() {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(200));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        let _ = stream.set_nonblocking(false);
        let mut line = String::new();
        BufReader::new(&stream).read_line(&mut line).map_err(|e| e.to_string())?;
        // "GET /?state=..&code=..&scope=.. HTTP/1.1"
        let target = line.split_whitespace().nth(1).unwrap_or("/").to_string();
        let parsed = url::Url::parse(&format!("http://localhost{}", target)).map_err(|e| e.to_string())?;
        let q = |k: &str| parsed.query_pairs().find(|(key, _)| key == k).map(|(_, v)| v.to_string());
        if q("state").is_none() && q("code").is_none() && q("error").is_none() {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
            continue; // e.g. /favicon.ico
        }
        let ok = q("state").as_deref() == Some(state.as_str()) && q("code").is_some();
        let body = if ok {
            "<html><body style=\"font-family:sans-serif;background:#121212;color:#e0e0e0\"><h2>Trip Explorer is signed in.</h2><p>You can close this tab.</p></body></html>"
        } else {
            "<html><body style=\"font-family:sans-serif;background:#121212;color:#e0e0e0\"><h2>Sign-in did not finish.</h2></body></html>"
        };
        let _ = stream.write_all(
            format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).as_bytes(),
        );
        if !ok {
            return Err(q("error").unwrap_or_else(|| "Sign-in was refused".into()));
        }
        break q("code").unwrap();
    };

    #[derive(Deserialize)]
    struct TokenResponse {
        refresh_token: Option<String>,
    }
    let http = reqwest::blocking::Client::new();
    let resp = http
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", client_id()?),
            ("client_secret", client_secret()?),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Token exchange failed: {}", text));
    }
    let token: TokenResponse = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    token.refresh_token.ok_or_else(|| "Google sent no refresh token".into())
}

// ── REST client ──────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFile {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub parents: Vec<String>,
    #[serde(default)]
    pub trashed: bool,
    pub md5_checksum: Option<String>,
    pub size: Option<String>,
    pub modified_time: Option<String>,
    #[serde(default)]
    pub mime_type: String,
}

impl RemoteFile {
    pub fn is_dir(&self) -> bool {
        self.mime_type == FOLDER_MIME
    }
    /// Google Docs, Sheets and the like have no bytes to download; the sync leaves them alone.
    pub fn is_google_doc(&self) -> bool {
        self.mime_type.starts_with("application/vnd.google-apps.") && !self.is_dir()
    }
    pub fn size(&self) -> u64 {
        self.size.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0)
    }
    pub fn modified_ms(&self) -> i64 {
        self.modified_time.as_deref().and_then(parse_time).unwrap_or(0)
    }
}

pub fn parse_time(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|t| t.timestamp_millis())
}

pub fn format_time(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

#[derive(Deserialize)]
struct FileList {
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
    #[serde(default)]
    files: Vec<RemoteFile>,
}

/// An error from Drive; `auth` is set when the refresh token no longer works (sign in again).
#[derive(Debug)]
pub struct DriveError {
    pub message: String,
    pub auth: bool,
}

impl From<reqwest::Error> for DriveError {
    fn from(e: reqwest::Error) -> Self {
        DriveError { message: e.to_string(), auth: false }
    }
}

impl From<std::io::Error> for DriveError {
    fn from(e: std::io::Error) -> Self {
        DriveError { message: e.to_string(), auth: false }
    }
}

fn err(message: impl Into<String>) -> DriveError {
    DriveError { message: message.into(), auth: false }
}

pub type DResult<T> = Result<T, DriveError>;

pub struct Drive {
    http: reqwest::blocking::Client,
    refresh_token: String,
    access: Option<(String, Instant)>,
}

/// Escapes a value for a Drive query string literal.
fn q_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

impl Drive {
    pub fn new(refresh_token: String) -> Self {
        let http = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(600))
            .connect_timeout(Duration::from_secs(20))
            .build()
            .expect("http client");
        Drive { http, refresh_token, access: None }
    }

    fn token(&mut self) -> DResult<String> {
        if let Some((t, until)) = &self.access {
            if Instant::now() < *until {
                return Ok(t.clone());
            }
        }
        #[derive(Deserialize)]
        struct Refreshed {
            access_token: String,
            expires_in: u64,
        }
        let resp = self
            .http
            .post("https://oauth2.googleapis.com/token")
            .form(&[
                ("client_id", client_id().map_err(err)?),
                ("client_secret", client_secret().map_err(err)?),
                ("refresh_token", self.refresh_token.as_str()),
                ("grant_type", "refresh_token"),
            ])
            .send()?;
        let status = resp.status();
        let text = resp.text()?;
        if !status.is_success() {
            return Err(DriveError { message: format!("Sign-in expired: {}", text), auth: status.as_u16() == 400 || status.as_u16() == 401 });
        }
        let r: Refreshed = serde_json::from_str(&text).map_err(|e| err(e.to_string()))?;
        let until = Instant::now() + Duration::from_secs(r.expires_in.saturating_sub(60));
        self.access = Some((r.access_token.clone(), until));
        Ok(r.access_token)
    }

    /// Sends a request built by `build` with a fresh token, retrying once after a 401.
    fn send(&mut self, build: impl Fn(&reqwest::blocking::Client, &str) -> reqwest::blocking::RequestBuilder) -> DResult<reqwest::blocking::Response> {
        for attempt in 0..2 {
            let token = self.token()?;
            let resp = build(&self.http, &token).send()?;
            if resp.status().as_u16() == 401 && attempt == 0 {
                self.access = None;
                continue;
            }
            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().unwrap_or_default();
                return Err(err(format!("Drive {}: {}", status, text.chars().take(300).collect::<String>())));
            }
            return Ok(resp);
        }
        unreachable!()
    }

    fn json<T: serde::de::DeserializeOwned>(&mut self, build: impl Fn(&reqwest::blocking::Client, &str) -> reqwest::blocking::RequestBuilder) -> DResult<T> {
        let text = self.send(build)?.text()?;
        serde_json::from_str(&text).map_err(|e| err(format!("{}: {}", e, text.chars().take(200).collect::<String>())))
    }

    pub fn about_email(&mut self) -> DResult<String> {
        #[derive(Deserialize)]
        struct User {
            #[serde(rename = "emailAddress")]
            email: String,
        }
        #[derive(Deserialize)]
        struct About {
            user: User,
        }
        let about: About = self.json(|h, t| h.get(format!("{}/about", API)).bearer_auth(t).query(&[("fields", "user(emailAddress)")]))?;
        Ok(about.user.email)
    }

    /// Every non-trashed child of a folder (`folders_only`: just the subfolders).
    pub fn children(&mut self, parent: &str, folders_only: bool) -> DResult<Vec<RemoteFile>> {
        let token = self.token()?;
        children_with(&self.http, &token, parent, folders_only)
    }

    /// A current access token and the HTTP client, for listing folders from several threads at once.
    pub fn lister(&mut self) -> DResult<(reqwest::blocking::Client, String)> {
        Ok((self.http.clone(), self.token()?))
    }

    pub fn get(&mut self, id: &str) -> DResult<RemoteFile> {
        let id = id.to_string();
        self.json(move |h, t| h.get(format!("{}/files/{}", API, id)).bearer_auth(t).query(&[("fields", FILE_FIELDS)]))
    }

    pub fn create_folder(&mut self, parent: &str, name: &str) -> DResult<RemoteFile> {
        let body = serde_json::json!({ "name": name, "mimeType": FOLDER_MIME, "parents": [parent] });
        self.json(move |h, t| h.post(format!("{}/files", API)).bearer_auth(t).query(&[("fields", FILE_FIELDS)]).json(&body))
    }

    /// Uploads `path` as a new file in `parent` (`id` None) or as new content of file `id`. Drive's
    /// modified time is set to `modified_ms` (the local file's), so both sides agree on "newer".
    pub fn upload(&mut self, id: Option<&str>, parent: &str, name: &str, path: &Path, modified_ms: i64) -> DResult<RemoteFile> {
        let size = fs::metadata(path)?.len();
        let mut meta = serde_json::json!({ "name": name, "modifiedTime": format_time(modified_ms) });
        if id.is_none() {
            meta["parents"] = serde_json::json!([parent]);
        }
        let url = match id {
            Some(id) => format!("{}/files/{}", UPLOAD, id),
            None => format!("{}/files", UPLOAD),
        };
        let patch = id.is_some();
        if size <= MULTIPART_MAX {
            let bytes = fs::read(path)?;
            let boundary = format!("te{}", random_token(12).replace(['-', '_'], "x"));
            let mut body = Vec::with_capacity(bytes.len() + 512);
            body.extend_from_slice(format!("--{}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{}\r\n--{}\r\nContent-Type: application/octet-stream\r\n\r\n", boundary, meta, boundary).as_bytes());
            body.extend_from_slice(&bytes);
            body.extend_from_slice(format!("\r\n--{}--\r\n", boundary).as_bytes());
            let ctype = format!("multipart/related; boundary={}", boundary);
            return self.json(move |h, t| {
                let r = if patch { h.patch(&url) } else { h.post(&url) };
                r.bearer_auth(t).query(&[("uploadType", "multipart"), ("fields", FILE_FIELDS)]).header("Content-Type", ctype.as_str()).body(body.clone())
            });
        }
        // Resumable: open a session, then send the whole file in one PUT.
        let session = self.send(move |h, t| {
            let r = if patch { h.patch(&url) } else { h.post(&url) };
            r.bearer_auth(t).query(&[("uploadType", "resumable"), ("fields", FILE_FIELDS)]).header("X-Upload-Content-Length", size.to_string()).json(&meta)
        })?;
        let location = session.headers().get("location").and_then(|v| v.to_str().ok()).ok_or_else(|| err("No upload session"))?.to_string();
        let file = fs::File::open(path)?;
        let resp = self.http.put(&location).header("Content-Length", size.to_string()).body(reqwest::blocking::Body::sized(file, size)).send()?;
        if !resp.status().is_success() {
            return Err(err(format!("Upload {}: {}", resp.status(), resp.text().unwrap_or_default())));
        }
        serde_json::from_str(&resp.text()?).map_err(|e| err(e.to_string()))
    }

    /// Downloads a file's bytes to `dest` through a temp file next to it.
    pub fn download(&mut self, id: &str, dest: &Path) -> DResult<()> {
        let id = id.to_string();
        let mut resp = self.send(move |h, t| h.get(format!("{}/files/{}", API, id)).bearer_auth(t).query(&[("alt", "media")]))?;
        if let Some(dir) = dest.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = tmp_path(dest);
        {
            let mut out = fs::File::create(&tmp)?;
            let mut buf = vec![0u8; 256 * 1024];
            loop {
                let n = resp.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                out.write_all(&buf[..n])?;
            }
            out.flush()?;
        }
        if dest.exists() {
            fs::remove_file(dest)?;
        }
        fs::rename(&tmp, dest)?;
        Ok(())
    }

    /// Renames and/or moves a file or folder.
    pub fn move_to(&mut self, id: &str, name: &str, new_parent: &str, old_parent: &str) -> DResult<RemoteFile> {
        let body = serde_json::json!({ "name": name });
        let url = format!("{}/files/{}", API, id);
        let (np, op) = (new_parent.to_string(), old_parent.to_string());
        self.json(move |h, t| {
            let mut r = h.patch(&url).bearer_auth(t).query(&[("fields", FILE_FIELDS)]).json(&body);
            if np != op {
                r = r.query(&[("addParents", np.as_str()), ("removeParents", op.as_str())]);
            }
            r
        })
    }

    /// Moves a file or folder to Drive's trash (kept 30 days).
    pub fn trash(&mut self, id: &str) -> DResult<()> {
        let url = format!("{}/files/{}", API, id);
        self.send(move |h, t| h.patch(&url).bearer_auth(t).query(&[("fields", "id")]).json(&serde_json::json!({ "trashed": true })))?;
        Ok(())
    }
}

/// Every non-trashed child of a folder, with a given token (thread-safe; see `Drive::lister`).
pub fn children_with(http: &reqwest::blocking::Client, token: &str, parent: &str, folders_only: bool) -> DResult<Vec<RemoteFile>> {
    let mut q = format!("'{}' in parents and trashed = false", q_escape(parent));
    if folders_only {
        q.push_str(&format!(" and mimeType = '{}'", FOLDER_MIME));
    }
    let fields = format!("nextPageToken,files({})", FILE_FIELDS);
    let mut out = Vec::new();
    let mut page: Option<String> = None;
    loop {
        let mut r = http.get(format!("{}/files", API)).bearer_auth(token).query(&[("q", q.as_str()), ("fields", fields.as_str()), ("pageSize", "1000"), ("orderBy", "name")]);
        if let Some(p) = &page {
            r = r.query(&[("pageToken", p.as_str())]);
        }
        let resp = r.send()?;
        let status = resp.status();
        let text = resp.text()?;
        if !status.is_success() {
            return Err(err(format!("Drive {}: {}", status, text.chars().take(300).collect::<String>())));
        }
        let list: FileList = serde_json::from_str(&text).map_err(|e| err(e.to_string()))?;
        out.extend(list.files);
        match list.next_page_token {
            Some(p) => page = Some(p),
            None => return Ok(out),
        }
    }
}

/// `<file>.sync.tmp` next to a file: where downloads land before replacing it. Never synced.
pub fn tmp_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".sync.tmp");
    dest.with_file_name(name)
}

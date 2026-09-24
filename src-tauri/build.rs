fn main() {
    // The Google OAuth client (Desktop type) is kept out of git in google_oauth.json; without it the
    // build still works and Drive sync reports that it is not configured.
    println!("cargo:rerun-if-changed=google_oauth.json");
    if let Ok(text) = std::fs::read_to_string("google_oauth.json") {
        for key in ["client_id", "client_secret"] {
            if let Some(value) = json_string(&text, key) {
                println!("cargo:rustc-env=GOOGLE_{}={}", key.to_uppercase(), value);
            }
        }
    }
    tauri_build::build()
}

/// The string value of `"key": "..."` in a flat JSON object (no escapes in these values).
fn json_string(text: &str, key: &str) -> Option<String> {
    let at = text.find(&format!("\"{}\"", key))?;
    let rest = &text[at + key.len() + 2..];
    let start = rest.find('"')? + 1;
    let end = rest[start..].find('"')?;
    Some(rest[start..start + end].to_string())
}

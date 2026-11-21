//! Asks GitHub which release is newest, so the app can say whether an update is available.

use serde_json::Value;
use std::time::Duration;

const LATEST: &str = "https://api.github.com/repos/zaclohrenz/AssessIT/releases/latest";

/// The newest published release's tag, e.g. "v0.1.5". Drafts and pre-releases don't count.
#[tauri::command]
pub async fn latest_release() -> Result<String, String> {
    let res = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(concat!("AssessIT/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?
        .get(LATEST)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Couldn't reach GitHub: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("GitHub returned {}", res.status()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    let body: Value = serde_json::from_slice(&bytes).map_err(|e| format!("GitHub sent something unexpected: {e}"))?;
    body["tag_name"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "GitHub didn't say which release is latest.".to_string())
}

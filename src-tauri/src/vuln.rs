//! CVE lookups for vulnerability triage: the official CVE record (which carries CISA's
//! Vulnrichment SSVC answers) and CISA's Known Exploited Vulnerabilities catalog.

use serde::Serialize;
use serde_json::Value;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const CVE_API: &str = "https://cveawg.mitre.org/api/cve/";
const KEV_URL: &str = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
/// Re-download KEV after this long. CISA updates it a few times a week.
const KEV_MAX_AGE: u64 = 6 * 60 * 60;

fn valid_cve_id(id: &str) -> bool {
    let mut parts = id.split('-');
    matches!(
        (parts.next(), parts.next(), parts.next(), parts.next()),
        (Some("CVE"), Some(y), Some(n), None)
            if y.len() == 4 && y.bytes().all(|b| b.is_ascii_digit()) && n.len() >= 4 && n.bytes().all(|b| b.is_ascii_digit())
    )
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

async fn get(url: &str, max_bytes: usize) -> Result<(reqwest::StatusCode, Vec<u8>), String> {
    let res = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(concat!("AssessIT/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach {}: {e}", url.split('/').nth(2).unwrap_or(url)))?;
    let status = res.status();
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > max_bytes {
        return Err(format!("{url} sent more data than expected."));
    }
    Ok((status, bytes.to_vec()))
}

/// The CVE record (CVE JSON 5) from the CVE Program's API. None if the ID doesn't exist.
#[tauri::command]
pub async fn cve_record(id: String) -> Result<Option<Value>, String> {
    if !valid_cve_id(&id) {
        return Err("That doesn't look like a CVE ID (e.g. CVE-2024-3400).".into());
    }
    let (status, body) = get(&format!("{CVE_API}{id}"), 5 * 1024 * 1024).await?;
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(format!("The CVE service returned {status}."));
    }
    serde_json::from_slice(&body).map(Some).map_err(|e| format!("Unexpected CVE record: {e}"))
}

#[derive(Serialize)]
pub struct KevLookup {
    entry: Option<Value>,
    catalog_version: String,
    /// Seconds since the Unix epoch when the catalog was downloaded.
    fetched_at: u64,
    /// true = couldn't refresh; this is the last downloaded copy.
    stale: bool,
}

/// Looks a CVE up in KEV, downloading the catalog at most every few hours and keeping the last copy for offline use.
#[tauri::command]
pub async fn kev_lookup(app: AppHandle, id: String) -> Result<KevLookup, String> {
    let cache = app.path().app_data_dir().ok().map(|d| d.join("kev-cache.json"));
    let cached: Option<Value> = cache.as_ref().and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice(&b).ok());
    let age = cached.as_ref().and_then(|c| c["fetched_at"].as_u64()).map(|t| now().saturating_sub(t));

    let (catalog, fetched_at, stale) = if age.is_some_and(|a| a < KEV_MAX_AGE) {
        let c = cached.unwrap();
        (c["catalog"].clone(), c["fetched_at"].as_u64().unwrap_or(0), false)
    } else {
        let fresh = match get(KEV_URL, 50 * 1024 * 1024).await {
            Ok((s, body)) if s.is_success() => serde_json::from_slice::<Value>(&body).map_err(|e| format!("Unexpected KEV catalog: {e}")),
            Ok((s, _)) => Err(format!("CISA's KEV feed returned {s}.")),
            Err(e) => Err(e),
        };
        match (fresh, cached) {
            (Ok(catalog), _) => {
                let t = now();
                if let Some(f) = &cache {
                    if let Some(dir) = f.parent() {
                        let _ = std::fs::create_dir_all(dir);
                    }
                    let _ = std::fs::write(f, serde_json::to_vec(&serde_json::json!({ "fetched_at": t, "catalog": catalog })).unwrap_or_default());
                }
                (catalog, t, false)
            }
            (Err(_), Some(c)) => (c["catalog"].clone(), c["fetched_at"].as_u64().unwrap_or(0), true),
            (Err(e), None) => return Err(e),
        }
    };
    let entry = catalog["vulnerabilities"]
        .as_array()
        .and_then(|v| v.iter().find(|x| x["cveID"].as_str().is_some_and(|c| c.eq_ignore_ascii_case(&id))))
        .cloned();
    Ok(KevLookup {
        entry,
        catalog_version: catalog["catalogVersion"].as_str().unwrap_or("").into(),
        fetched_at,
        stale,
    })
}

#[cfg(test)]
mod tests {
    use super::valid_cve_id;

    #[test]
    fn cve_ids() {
        assert!(valid_cve_id("CVE-2024-3400"));
        assert!(valid_cve_id("CVE-2026-129448"));
        assert!(!valid_cve_id("CVE-24-3400"));
        assert!(!valid_cve_id("CVE-2024-340"));
        assert!(!valid_cve_id("CVE-2024-3400/../x"));
        assert!(!valid_cve_id("cve-2024-3400"));
    }
}

//! Where an organization's AssessIT config comes from, and fetching it.
//!
//! Lookup order for the config URL (first one found wins):
//!   1. Managed preference, set by an admin so users can't change it:
//!        macOS:   a configuration profile (MDM), or
//!                 sudo defaults write /Library/Preferences/io.github.zaclohrenz.assessit ConfigURL "https://…"
//!        Windows: HKLM\Software\AssessIT  ConfigURL (REG_SZ), via Group Policy / Intune
//!   2. Install-time file: written by the Homebrew cask when installed with
//!        HOMEBREW_ASSESSIT_CONFIG_URL=https://… brew install --cask assessit
//!   3. The same preference set by the user themselves (`defaults write` without sudo, or HKCU)
//!   4. Whatever the user typed in Settings, or the public default (decided in the frontend).

use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
const BUNDLE_ID: &str = "io.github.zaclohrenz.assessit";
const MAX_BYTES: usize = 2 * 1024 * 1024;

#[derive(Serialize)]
pub struct ConfigSource {
    url: Option<String>,
    /// "managed" | "install" | "none"
    source: &'static str,
}

/// A ConfigURL preference and whether only an admin could have set it.
struct PrefUrl {
    url: String,
    admin: bool,
}

#[cfg(target_os = "macos")]
fn pref_url() -> Option<PrefUrl> {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::string::CFString;
    use core_foundation_sys::preferences::{
        kCFPreferencesAnyHost, kCFPreferencesAnyUser, CFPreferencesAppValueIsForced, CFPreferencesCopyAppValue, CFPreferencesCopyValue,
    };
    let key = CFString::new("ConfigURL");
    let app = CFString::new(BUNDLE_ID);
    let as_url = |v: core_foundation_sys::base::CFTypeRef| -> Option<String> {
        if v.is_null() {
            return None;
        }
        let any = unsafe { CFType::wrap_under_create_rule(v) };
        any.downcast::<CFString>().map(|s| s.to_string().trim().to_string()).filter(|s| !s.is_empty())
    };
    // Forced by a configuration profile (MDM).
    if unsafe { CFPreferencesAppValueIsForced(key.as_concrete_TypeRef(), app.as_concrete_TypeRef()) } != 0 {
        if let Some(url) = as_url(unsafe { CFPreferencesCopyAppValue(key.as_concrete_TypeRef(), app.as_concrete_TypeRef()) }) {
            return Some(PrefUrl { url, admin: true });
        }
    }
    // /Library/Preferences: only an admin can write it.
    let system = unsafe { CFPreferencesCopyValue(key.as_concrete_TypeRef(), app.as_concrete_TypeRef(), kCFPreferencesAnyUser, kCFPreferencesAnyHost) };
    if let Some(url) = as_url(system) {
        return Some(PrefUrl { url, admin: true });
    }
    // The user's own `defaults write`: a hint, not a mandate.
    as_url(unsafe { CFPreferencesCopyAppValue(key.as_concrete_TypeRef(), app.as_concrete_TypeRef()) }).map(|url| PrefUrl { url, admin: false })
}

#[cfg(windows)]
fn pref_url() -> Option<PrefUrl> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;
    // HKLM is admin-only (Group Policy / Intune); HKCU is the user's own.
    [(HKEY_LOCAL_MACHINE, true), (HKEY_CURRENT_USER, false)].iter().find_map(|(hive, admin)| {
        RegKey::predef(*hive)
            .open_subkey("Software\\AssessIT")
            .and_then(|k| k.get_value::<String, _>("ConfigURL"))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(|url| PrefUrl { url, admin: *admin })
    })
}

/// Linux has no MDM preference store, so mirror it with files:
/// `/etc/assessit/config-url` is root-owned (admin), `$XDG_CONFIG_HOME/assessit/config-url` is the user's own.
#[cfg(not(any(target_os = "macos", windows)))]
fn pref_url() -> Option<PrefUrl> {
    let read = |p: PathBuf| std::fs::read_to_string(p).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Some(url) = read(PathBuf::from("/etc/assessit/config-url")) {
        return Some(PrefUrl { url, admin: true });
    }
    let user_dir = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    read(user_dir.join("assessit/config-url")).map(|url| PrefUrl { url, admin: false })
}

fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok()
}

#[tauri::command]
pub fn config_source(app: AppHandle) -> ConfigSource {
    let pref = pref_url();
    if let Some(PrefUrl { url, admin: true }) = &pref {
        return ConfigSource { url: Some(url.clone()), source: "managed" };
    }
    let installed = data_dir(&app)
        .map(|d| d.join("config-url"))
        .and_then(|f| std::fs::read_to_string(f).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    match installed {
        Some(url) => ConfigSource { url: Some(url), source: "install" },
        // A preference the user set themselves ranks like an install-time URL, below the Homebrew one.
        None => match pref {
            Some(p) => ConfigSource { url: Some(p.url), source: "install" },
            None => ConfigSource { url: None, source: "none" },
        },
    }
}

#[derive(Serialize)]
pub struct Fetched {
    body: Value,
    /// Seconds since the Unix epoch when this copy was downloaded.
    fetched_at: u64,
    /// true = the download failed and this is the last good copy.
    stale: bool,
    error: Option<String>,
}

fn allowed(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://localhost") || url.starts_with("http://127.0.0.1")
}

async fn download(url: &str) -> Result<Value, String> {
    if !allowed(url) {
        return Err("Config URLs must start with https://".into());
    }
    let res = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(concat!("AssessIT/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("{} returned {}", url, res.status()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("Config file is larger than 2 MB.".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("Config isn't valid JSON: {e}"))
}

/// Downloads a JSON config (or policy) file, caching the last good copy per URL for offline use.
#[tauri::command]
pub async fn fetch_config(app: AppHandle, url: String) -> Result<Fetched, String> {
    let cache = data_dir(&app).map(|d| d.join("config-cache.json"));
    let mut all: serde_json::Map<String, Value> = cache
        .as_ref()
        .and_then(|f| std::fs::read(f).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    match download(&url).await {
        Ok(body) => {
            let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            all.insert(url.clone(), serde_json::json!({ "body": body, "fetched_at": now }));
            if let Some(f) = &cache {
                if let Some(dir) = f.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let _ = std::fs::write(f, serde_json::to_vec(&all).unwrap_or_default());
            }
            Ok(Fetched { body, fetched_at: now, stale: false, error: None })
        }
        Err(e) => match all.get(&url) {
            Some(c) => Ok(Fetched {
                body: c["body"].clone(),
                fetched_at: c["fetched_at"].as_u64().unwrap_or(0),
                stale: true,
                error: Some(e),
            }),
            None => Err(e),
        },
    }
}

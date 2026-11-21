//! Sends a finished assessment somewhere an approval can happen.
//!  - Webhook: POST JSON to a Power Automate / Teams Workflows / any HTTP trigger.
//!    No end-user sign-in; the flow owns the SharePoint write and the approval.
//!  - SharePoint (Graph): write a list item directly as the signed-in user,
//!    using the device-code flow against the org's own Entra app registration.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

const SCOPE: &str = "https://graph.microsoft.com/Sites.ReadWrite.All https://graph.microsoft.com/User.Read offline_access";

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .user_agent(concat!("AssessIT/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("http client")
}

fn trim(s: &str) -> String {
    s.chars().take(600).collect()
}

#[tauri::command]
pub async fn post_webhook(url: String, payload: Value) -> Result<String, String> {
    if !url.starts_with("https://") && !url.starts_with("http://localhost") && !url.starts_with("http://127.0.0.1") {
        return Err("Webhook URL must start with https://".into());
    }
    let res = http().post(&url).json(&payload).send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if status.is_success() {
        Ok(format!("{} {}", status.as_u16(), trim(&body)))
    } else {
        Err(format!("Webhook returned {}: {}", status, trim(&body)))
    }
}

// ---------------- Microsoft Graph ----------------

#[derive(Serialize, Deserialize, Clone, Default)]
struct Tokens {
    tenant: String,
    client_id: String,
    access_token: String,
    refresh_token: String,
    expires_at: u64,
    account: String,
}

#[derive(Default)]
pub struct GraphState {
    tokens: Mutex<Option<Tokens>>,
}

#[derive(Serialize, Deserialize)]
pub struct DeviceCode {
    device_code: String,
    user_code: String,
    verification_uri: String,
    message: String,
    interval: u64,
    expires_in: u64,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn token_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("graph-token.json"))
}

fn save_tokens(app: &AppHandle, t: &Tokens) {
    let Some(f) = token_file(app) else { return };
    if let Some(dir) = f.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::write(&f, serde_json::to_vec(t).unwrap_or_default()).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600));
        }
    }
}

fn authority(tenant: &str) -> String {
    let t = if tenant.trim().is_empty() { "organizations" } else { tenant.trim() };
    format!("https://login.microsoftonline.com/{t}/oauth2/v2.0")
}

#[tauri::command]
pub async fn graph_sign_in_start(tenant: String, client_id: String) -> Result<DeviceCode, String> {
    if client_id.trim().is_empty() {
        return Err("Set the Entra app (client) ID in Settings first.".into());
    }
    let res = http()
        .post(format!("{}/devicecode", authority(&tenant)))
        .form(&[("client_id", client_id.trim()), ("scope", SCOPE)])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let v: Value = res.json().await.map_err(|e| e.to_string())?;
    if let Some(e) = v["error_description"].as_str() {
        return Err(trim(e));
    }
    serde_json::from_value(v).map_err(|e| e.to_string())
}

async fn account_name(access: &str) -> String {
    let me: Value = match http().get("https://graph.microsoft.com/v1.0/me").bearer_auth(access).send().await {
        Ok(r) => r.json().await.unwrap_or_default(),
        Err(_) => Value::Null,
    };
    me["userPrincipalName"].as_str().unwrap_or("").to_string()
}

fn tokens_from(v: &Value, tenant: &str, client_id: &str, prev_refresh: &str) -> Option<Tokens> {
    Some(Tokens {
        tenant: tenant.into(),
        client_id: client_id.into(),
        access_token: v["access_token"].as_str()?.into(),
        refresh_token: v["refresh_token"].as_str().unwrap_or(prev_refresh).into(),
        expires_at: now() + v["expires_in"].as_u64().unwrap_or(3600),
        account: String::new(),
    })
}

/// Polls until the user finishes signing in on the web page (or the code expires).
#[tauri::command]
pub async fn graph_sign_in_wait(
    app: AppHandle,
    state: State<'_, GraphState>,
    tenant: String,
    client_id: String,
    device_code: String,
    interval: u64,
    expires_in: u64,
) -> Result<String, String> {
    let deadline = now() + expires_in;
    let mut wait = interval.max(2);
    while now() < deadline {
        tokio::time::sleep(Duration::from_secs(wait)).await;
        let v: Value = http()
            .post(format!("{}/token", authority(&tenant)))
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("client_id", client_id.trim()),
                ("device_code", device_code.as_str()),
            ])
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        match v["error"].as_str() {
            None => {
                let mut t = tokens_from(&v, &tenant, client_id.trim(), "").ok_or("No token returned.")?;
                t.account = account_name(&t.access_token).await;
                save_tokens(&app, &t);
                let who = t.account.clone();
                *state.tokens.lock().await = Some(t);
                return Ok(who);
            }
            Some("authorization_pending") => {}
            Some("slow_down") => wait += 5,
            Some(_) => return Err(trim(v["error_description"].as_str().unwrap_or("Sign-in failed."))),
        }
    }
    Err("Sign-in code expired. Try again.".into())
}

async fn access_token(app: &AppHandle, state: &GraphState) -> Result<String, String> {
    let mut guard = state.tokens.lock().await;
    if guard.is_none() {
        *guard = token_file(app)
            .and_then(|f| std::fs::read(f).ok())
            .and_then(|b| serde_json::from_slice(&b).ok());
    }
    let t = guard.as_mut().ok_or("Not signed in to Microsoft 365.")?;
    if t.expires_at > now() + 120 {
        return Ok(t.access_token.clone());
    }
    let v: Value = http()
        .post(format!("{}/token", authority(&t.tenant)))
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", t.client_id.as_str()),
            ("refresh_token", t.refresh_token.as_str()),
            ("scope", SCOPE),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let mut fresh = tokens_from(&v, &t.tenant, &t.client_id, &t.refresh_token)
        .ok_or("Microsoft 365 session expired. Sign in again.")?;
    fresh.account = t.account.clone();
    save_tokens(app, &fresh);
    *t = fresh;
    Ok(t.access_token.clone())
}

#[tauri::command]
pub async fn graph_status(app: AppHandle, state: State<'_, GraphState>) -> Result<Option<String>, String> {
    let mut guard = state.tokens.lock().await;
    if guard.is_none() {
        *guard = token_file(&app)
            .and_then(|f| std::fs::read(f).ok())
            .and_then(|b| serde_json::from_slice(&b).ok());
    }
    Ok(guard.as_ref().map(|t: &Tokens| t.account.clone()))
}

#[tauri::command]
pub async fn graph_sign_out(app: AppHandle, state: State<'_, GraphState>) -> Result<(), String> {
    *state.tokens.lock().await = None;
    if let Some(f) = token_file(&app) {
        let _ = std::fs::remove_file(f);
    }
    Ok(())
}

async fn graph_get(token: &str, url: &str) -> Result<Value, String> {
    let res = http().get(url).bearer_auth(token).send().await.map_err(|e| e.to_string())?;
    let ok = res.status().is_success();
    let v: Value = res.json().await.map_err(|e| e.to_string())?;
    if !ok {
        return Err(trim(v["error"]["message"].as_str().unwrap_or("Graph request failed.")));
    }
    Ok(v)
}

/// "https://contoso.sharepoint.com/sites/Risk" -> Graph site id
async fn resolve_site(token: &str, site_url: &str) -> Result<String, String> {
    let rest = site_url
        .trim()
        .trim_end_matches('/')
        .strip_prefix("https://")
        .ok_or("Site URL must start with https://")?;
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    let url = if path.is_empty() {
        format!("https://graph.microsoft.com/v1.0/sites/{host}")
    } else {
        format!("https://graph.microsoft.com/v1.0/sites/{host}:/{path}")
    };
    let v = graph_get(token, &url).await?;
    v["id"].as_str().map(String::from).ok_or("Site not found.".into())
}

#[tauri::command]
pub async fn graph_create_item(
    app: AppHandle,
    state: State<'_, GraphState>,
    site_url: String,
    list_name: String,
    fields: Value,
) -> Result<String, String> {
    let token = access_token(&app, &state).await?;
    let site = resolve_site(&token, &site_url).await?;
    let lists = graph_get(
        &token,
        &format!("https://graph.microsoft.com/v1.0/sites/{site}/lists?$select=id,displayName"),
    )
    .await?;
    let list_id = lists["value"]
        .as_array()
        .and_then(|a| a.iter().find(|l| l["displayName"].as_str() == Some(list_name.trim())))
        .and_then(|l| l["id"].as_str())
        .ok_or(format!("List \"{}\" not found on that site.", list_name.trim()))?
        .to_string();
    let res = http()
        .post(format!("https://graph.microsoft.com/v1.0/sites/{site}/lists/{list_id}/items"))
        .bearer_auth(&token)
        .json(&json!({ "fields": fields }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let ok = res.status().is_success();
    let v: Value = res.json().await.map_err(|e| e.to_string())?;
    if !ok {
        return Err(trim(v["error"]["message"].as_str().unwrap_or("Could not create the list item.")));
    }
    Ok(v["webUrl"].as_str().unwrap_or("").to_string())
}

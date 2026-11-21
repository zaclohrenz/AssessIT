//! Runs the user's own Claude Code CLI headlessly to gather evidence.
//! No API keys: it uses whatever account the user signed into `claude` with.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct ResearchState {
    child: Mutex<Option<Child>>,
}

#[derive(Serialize, Clone)]
pub struct Progress {
    kind: &'static str,
    text: String,
}

#[derive(Serialize)]
pub struct ClaudeStatus {
    path: Option<String>,
    version: Option<String>,
    logged_in: bool,
    account: Option<String>,
    error: Option<String>,
}

const EXE: &str = if cfg!(windows) { "claude.exe" } else { "claude" };

/// GUI apps launched from Finder get a bare PATH, so ask the user's login shell for theirs.
fn shell_path() -> &'static str {
    static P: OnceLock<String> = OnceLock::new();
    P.get_or_init(|| {
        let base = std::env::var("PATH").unwrap_or_default();
        if cfg!(windows) {
            return base;
        }
        let default_shell = if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/sh" };
        let shell = std::env::var("SHELL").unwrap_or_else(|_| default_shell.into());
        let child = std::process::Command::new(shell)
            .args(["-ilc", "printf '__P__%s__P__' \"$PATH\""])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        // A slow or interactive shell profile must not hang the app.
        let found = child.ok().and_then(|mut c| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while c.try_wait().ok()?.is_none() {
                if std::time::Instant::now() > deadline {
                    let _ = c.kill();
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            let o = c.wait_with_output().ok()?;
            let s = String::from_utf8_lossy(&o.stdout).to_string();
            let a = s.find("__P__")? + 5;
            let b = s[a..].find("__P__")? + a;
            Some(s[a..b].to_string())
        });
        match found {
            Some(p) if !p.is_empty() => format!("{p}:{base}"),
            _ => base,
        }
    })
}

fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_default()
}

pub fn locate() -> Option<PathBuf> {
    let h = home();
    let mut candidates: Vec<PathBuf> = vec![
        h.join(".local/bin").join(EXE),
        h.join(".claude/local").join(EXE),
    ];
    if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            candidates.push(PathBuf::from(appdata).join("npm").join("claude.cmd"));
        }
    } else {
        candidates.extend(
            ["/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/home/linuxbrew/.linuxbrew/bin/claude", "/usr/bin/claude"]
                .iter()
                .map(PathBuf::from),
        );
        candidates.push(h.join(".npm-global/bin/claude"));
        candidates.push(h.join(".bun/bin/claude"));
    }
    let sep = if cfg!(windows) { ';' } else { ':' };
    for dir in shell_path().split(sep).filter(|d| !d.is_empty()) {
        candidates.push(Path::new(dir).join(EXE));
        if cfg!(windows) {
            candidates.push(Path::new(dir).join("claude.cmd"));
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn command(path: &Path) -> Command {
    let mut c = Command::new(path);
    c.env("PATH", shell_path());
    #[cfg(windows)]
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    c
}

#[tauri::command]
pub async fn claude_status() -> ClaudeStatus {
    let Some(path) = locate() else {
        return ClaudeStatus {
            path: None,
            version: None,
            logged_in: false,
            account: None,
            error: Some("Claude Code is not installed.".into()),
        };
    };
    let run = |args: &'static [&'static str]| {
        let mut c = command(&path);
        c.args(args).stdin(Stdio::null());
        async move { c.output().await }
    };
    let version = run(&["--version"])
        .await
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let auth: Option<Value> = run(&["auth", "status"])
        .await
        .ok()
        .and_then(|o| serde_json::from_slice(&o.stdout).ok());
    let logged_in = auth.as_ref().and_then(|a| a["loggedIn"].as_bool()).unwrap_or(false);
    let account = auth.as_ref().and_then(|a| {
        a["email"]
            .as_str()
            .or(a["account"]["email"].as_str())
            .or(a["authMethod"].as_str())
            .map(String::from)
    });
    ClaudeStatus {
        path: Some(path.display().to_string()),
        version,
        logged_in,
        account,
        error: (!logged_in).then(|| "Claude Code is installed but not signed in.".into()),
    }
}

/// Turn one stream-json event into a short progress line for the UI.
fn describe(ev: &Value) -> Option<Progress> {
    match ev["type"].as_str()? {
        "system" if ev["subtype"] == "init" => Some(Progress {
            kind: "status",
            text: format!("Started ({})", ev["model"].as_str().unwrap_or("Claude")),
        }),
        "assistant" => {
            let blocks = ev["message"]["content"].as_array()?;
            blocks.iter().find_map(|b| match b["type"].as_str()? {
                "tool_use" => {
                    let input = &b["input"];
                    match b["name"].as_str()? {
                        "WebSearch" => Some(Progress {
                            kind: "search",
                            text: input["query"].as_str().unwrap_or("").to_string(),
                        }),
                        "WebFetch" => Some(Progress {
                            kind: "fetch",
                            text: input["url"].as_str().unwrap_or("").to_string(),
                        }),
                        "StructuredOutput" => Some(Progress {
                            kind: "status",
                            text: "Writing up answers".into(),
                        }),
                        _ => None,
                    }
                }
                "text" => {
                    let t = b["text"].as_str()?.trim();
                    (!t.is_empty()).then(|| Progress {
                        kind: "note",
                        text: t.chars().take(220).collect(),
                    })
                }
                _ => None,
            })
        }
        _ => None,
    }
}

#[tauri::command]
pub async fn research_start(
    app: AppHandle,
    state: State<'_, ResearchState>,
    prompt: String,
    schema: Value,
    model: String,
) -> Result<Value, String> {
    let path = locate().ok_or("Claude Code is not installed.")?;
    // An empty scratch dir keeps the CLI away from any project files or CLAUDE.md.
    let work = std::env::temp_dir().join("assessit-research");
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;

    let mut cmd = command(&path);
    cmd.current_dir(&work)
        .args(["-p", "--output-format", "stream-json", "--verbose"])
        .args(["--json-schema", &schema.to_string()])
        .args(["--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch"])
        .args(["--strict-mcp-config", "--no-session-persistence", "--setting-sources", ""])
        .args(["--model", &model])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| format!("Could not start Claude Code: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;
    *state.child.lock().await = Some(child);

    stdin.write_all(prompt.as_bytes()).await.map_err(|e| e.to_string())?;
    drop(stdin);

    let err_task = tokio::spawn(async move {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s).await;
        s
    });

    let mut lines = BufReader::new(stdout).lines();
    let mut result: Option<Value> = None;
    let mut failure: Option<String> = None;
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(ev) = serde_json::from_str::<Value>(&line) else { continue };
        if ev["type"] == "result" {
            if ev["is_error"].as_bool().unwrap_or(false) || ev["structured_output"].is_null() {
                failure = Some(
                    ev["result"].as_str().unwrap_or("Claude did not return structured answers.").to_string(),
                );
            } else {
                result = Some(ev["structured_output"].clone());
            }
            continue;
        }
        if let Some(p) = describe(&ev) {
            let _ = app.emit("research-progress", p);
        }
    }

    let child = state.child.lock().await.take();
    let status = match child {
        Some(mut c) => c.wait().await.ok(),
        None => return Err("Research was cancelled.".into()),
    };
    let stderr_text = err_task.await.unwrap_or_default();

    if let Some(r) = result {
        return Ok(r);
    }
    let detail = failure
        .or_else(|| (!stderr_text.trim().is_empty()).then(|| stderr_text.trim().to_string()))
        .unwrap_or_else(|| format!("Claude Code exited ({:?}) without answers.", status));
    Err(detail)
}

/// Opens a terminal window that installs Claude Code if needed and starts sign-in,
/// so non-technical users never have to type a command.
#[tauri::command]
pub fn open_claude_setup() -> Result<(), String> {
    let login = match locate() {
        Some(p) => format!("\"{}\" auth login", p.display()),
        None if cfg!(windows) => {
            "powershell -NoProfile -Command \"irm https://claude.ai/install.ps1 | iex\" && %USERPROFILE%\\.local\\bin\\claude.exe auth login".into()
        }
        None => "if command -v brew >/dev/null; then brew install --cask claude-code; \
                 else curl -fsSL https://claude.ai/install.sh | bash; fi && \
                 PATH=\"$HOME/.local/bin:$PATH\" claude auth login"
            .into(),
    };
    #[cfg(target_os = "macos")]
    {
        let script = std::env::temp_dir().join("assessit-claude-setup.command");
        let body = format!(
            "#!/bin/zsh -l\necho 'Setting up Claude Code for AssessIT...'\n{login}\necho\necho 'Done. Return to AssessIT and click \"Check again\". You can close this window.'\n"
        );
        std::fs::write(&script, body).map_err(|e| e.to_string())?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        std::process::Command::new("open")
            .args(["-a", "Terminal"])
            .arg(&script)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", "cmd", "/K", &login])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let script = std::env::temp_dir().join("assessit-claude-setup.sh");
        let body = format!(
            "#!/bin/sh\necho 'Setting up Claude Code for AssessIT...'\n{login}\necho\necho 'Done. Return to AssessIT and click \"Check again\". Press Enter to close this window.'\nread _\n"
        );
        std::fs::write(&script, body).map_err(|e| e.to_string())?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        open_linux_terminal(&script)?;
    }
    Ok(())
}

/// Terminal emulators to try, in order, with the flag that makes each one run a program.
#[cfg(all(unix, not(target_os = "macos")))]
const LINUX_TERMINALS: &[(&str, &[&str])] = &[
    ("x-terminal-emulator", &["-e"]),
    ("gnome-terminal", &["--"]),
    ("konsole", &["-e"]),
    ("xfce4-terminal", &["-x"]),
    ("kitty", &[]),
    ("alacritty", &["-e"]),
    ("wezterm", &["start", "--"]),
    ("foot", &[]),
    ("tilix", &["-e"]),
    ("terminator", &["-x"]),
    ("xterm", &["-e"]),
];

/// Opens `script` in the user's terminal: `$TERMINAL` first, then whichever known emulator is installed.
#[cfg(all(unix, not(target_os = "macos")))]
fn open_linux_terminal(script: &Path) -> Result<(), String> {
    let find = |name: &str| -> Option<PathBuf> {
        shell_path().split(':').filter(|d| !d.is_empty()).map(|d| Path::new(d).join(name)).find(|p| p.is_file())
    };
    let mut tried: Vec<(PathBuf, Vec<&str>)> = Vec::new();
    if let Some(t) = std::env::var("TERMINAL").ok().filter(|t| !t.trim().is_empty()) {
        let path = PathBuf::from(t.trim());
        let path = if path.is_absolute() { Some(path) } else { find(t.trim()) };
        if let Some(p) = path {
            let flags = LINUX_TERMINALS
                .iter()
                .find(|(n, _)| p.file_name().is_some_and(|f| f == *n))
                .map(|(_, f)| f.to_vec())
                .unwrap_or_else(|| vec!["-e"]);
            tried.push((p, flags));
        }
    }
    tried.extend(LINUX_TERMINALS.iter().filter_map(|(n, f)| find(n).map(|p| (p, f.to_vec()))));
    for (term, flags) in tried {
        if std::process::Command::new(&term).args(flags).arg(script).env("PATH", shell_path()).spawn().is_ok() {
            return Ok(());
        }
    }
    Err(format!("Couldn't find a terminal to open. Open one and run: sh {}", script.display()))
}

#[tauri::command]
pub async fn research_cancel(state: State<'_, ResearchState>) -> Result<(), String> {
    if let Some(mut c) = state.child.lock().await.take() {
        c.kill().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

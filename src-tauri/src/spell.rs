// ─── SPELL & GRAMMAR CHECK — the provider layer ────────────────────────
//
// TWO PROVIDERS, ONE PROTOCOL: both speak LanguageTool's /v2/check
// form-POST. Online = https://api.languagetool.org (text leaves the
// device — the consented, default-off mode). Local = a sidecar
// org.languagetool.server.HTTPServer process bound to 127.0.0.1
// (loopback only; the server is never started with --public).
//
// THE LOCAL RUNTIME IS NEVER BUNDLED — it is downloaded ON DEMAND, with
// the user explicitly warned about the size first (the privacy/store
// posture: the installer ships small; the ~290MB is a choice, not a
// default). It lands in {appDataDir}/spell-runtime/:
//     languagetool/   the PRUNED English-only tree (110MB) — all
//                     language classes (the boot registry instantiates
//                     every language; Class.forName failures kill the
//                     server) + full en data + every language's
//                     common_words.txt (the language identifier needs
//                     it) — see keep_lt_entry, validated empirically
//                     against a real 6.6 server boot.
//     jre/            Temurin 21 JRE (~158MB) from the Adoptium API.
//
// Lifecycle: ensure_server is idempotent (a healthy port is reused —
// an orphan from a crashed app is adopted, never duplicated); the
// process is killed on app exit (lib.rs RunEvent::Exit → shutdown).

use serde::{Deserialize, Serialize};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

// ─── Wire (the LT JSON contract, mirrored TS-side in spell/types.ts) ───

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LtReplacement {
    pub value: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LtRule {
    pub id: String,
    pub description: String,
    #[serde(default)]
    pub issue_type: Option<String>,
    pub category: LtCategory,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LtCategory {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LtMatch {
    pub message: String,
    #[serde(default)]
    pub short_message: Option<String>,
    pub offset: usize,
    pub length: usize,
    #[serde(default)]
    pub replacements: Option<Vec<LtReplacement>>,
    pub rule: LtRule,
}

#[derive(Deserialize)]
struct LtCheckResponse {
    #[serde(default)]
    matches: Vec<LtMatch>,
}

// ─── State ──────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum SpellServerStatus {
    Stopped,
    Starting,
    Ready,
    Unavailable,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpellStatusDto {
    pub status: SpellServerStatus,
    pub port: u16,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpellInstallProgress {
    pub stage: String,
    pub received: u64,
    pub total: u64,
}

pub struct SpellState {
    child: Mutex<Option<Child>>,
    port: AtomicU16,
    status: Mutex<SpellServerStatus>,
    installing: AtomicBool,
    http: reqwest::Client,
}

impl SpellState {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            port: AtomicU16::new(0),
            status: Mutex::new(SpellServerStatus::Stopped),
            installing: AtomicBool::new(false),
            http: reqwest::Client::builder()
                .user_agent("TensorEditor/0.1 (FLOSS word processor)")
                .timeout(Duration::from_secs(60))
                .build()
                .expect("reqwest client"),
        }
    }
}

// ─── Paths ──────────────────────────────────────────────────────────────

fn runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir unavailable: {e}"))?;
    Ok(dir.join("spell-runtime"))
}

fn lt_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join("languagetool"))
}

fn java_bin(app: &AppHandle) -> Result<PathBuf, String> {
    let exe = if cfg!(windows) { "java.exe" } else { "java" };
    Ok(runtime_root(app)?.join("jre").join("bin").join(exe))
}

/// The pinned artifacts (one URL per artifact, one-time downloads).
/// LT 6.6 = the current stable zip (241MB compressed; pruned to ~110MB
/// on disk). Temurin 21 = an LTS JRE satisfying LT's Java 17 floor.
const LT_ZIP_URL: &str = "https://languagetool.org/download/LanguageTool-6.6.zip";

fn adoptium_url() -> Result<String, String> {
    let os = match std::env::consts::OS {
        "linux" => "linux",
        "windows" => "windows",
        "macos" => "mac",
        other => return Err(format!("unsupported platform: {other}")),
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "aarch64",
        "x86" => "x86",
        other => return Err(format!("unsupported architecture: {other}")),
    };
    Ok(format!(
        "https://api.adoptium.net/v3/binary/latest/21/ga/{os}/{arch}/jre/hotspot/normal/eclipse"
    ))
}

// ─── The pruning recipe (validated against a real boot + check) ─────────
//
// The distro ships EXPLODED classes (org/languagetool/...), thin jars,
// and per-language data. Boot instantiates EVERY language's classes
// (Languages.createLanguageObjects) and the language identifier reads
// every language's common_words.txt — so classes and those tiny files
// stay for all languages; everything else stays only for English.

const DROP_LIBS: &[&str] = &[
    "dutch-pos-dict.jar",
    "languagetool-ga-dicts.jar",
    "lucene-gosen-ipadic.jar",
    "hanlp.jar",
    "morfologik-ukrainian-lt.jar",
    "catalan-pos-dict.jar",
    "french-pos-dict.jar",
    "german-pos-dict.jar",
    "portuguese-pos-dict.jar",
    "spanish-pos-dict.jar",
    "asturian-pos-dict.jar",
    "morfologik-crh-lt.jar",
    "jwordsplitter.jar",
    "morphology-el.jar",
];

/// `rel` = the zip entry path with the `LanguageTool-6.6/` root stripped.
fn keep_lt_entry(rel: &str) -> bool {
    if let Some(jar) = rel.strip_prefix("libs/") {
        return !DROP_LIBS.contains(&jar);
    }
    if let Some(rest) = rel.strip_prefix("org/languagetool/") {
        let mut parts = rest.splitn(3, '/');
        if let (Some(kind), Some(lang), Some(_)) =
            (parts.next(), parts.next(), parts.next())
        {
            if (kind == "rules" || kind == "resource") && lang != "en" {
                let file = rel.rsplit('/').next().unwrap_or("");
                return file.ends_with(".class") || file == "common_words.txt";
            }
        }
    }
    !matches!(
        rel,
        "testrules.sh" | "testrules.bat" | "CHANGES.txt" | "CHANGES.md" | "languagetool-commandline.jar"
    )
}

/// Strip the single versioned root folder the LT zip wraps everything in.
fn strip_lt_root(name: &str) -> Option<&str> {
    let rest = name.strip_prefix("LanguageTool-6.6/")?;
    Some(rest)
}

// ─── Sidecar lifecycle ─────────────────────────────────────────────────

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    Ok(listener.local_addr().map_err(|e| e.to_string())?.port())
}

async fn health_ok(client: &reqwest::Client, port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/v2/check");
    let resp = client
        .post(&url)
        .form(&[("language", "en-US"), ("text", "a")])
        .timeout(Duration::from_secs(20))
        .send()
        .await;
    matches!(resp, Ok(r) if r.status().is_success())
}

fn set_status(state: &SpellState, s: SpellServerStatus) {
    *state.status.lock().unwrap() = s;
}

/// Idempotent: reuse a healthy process (an orphan from a crashed app is
/// adopted), else spawn from the installed runtime. The lock scope is
/// fully synchronous (a MutexGuard must never share an await point);
/// concurrency resolves as wait-vs-spawn decided under the lock.
async fn ensure_server(app: &AppHandle, state: &SpellState) -> Result<u16, String> {
    // 1. A live, healthy server — the fast path (also adopts orphans).
    let port = state.port.load(Ordering::SeqCst);
    if port != 0 && health_ok(&state.http, port).await {
        set_status(state, SpellServerStatus::Ready);
        return Ok(port);
    }

    // 2. An existing alive child (booting, or sick): wait for it; if it
    //    never gets healthy, clear it and respawn.
    let alive = state
        .child
        .lock()
        .unwrap()
        .as_mut()
        .is_some_and(|c| c.try_wait().ok().flatten().is_none());
    if alive {
        let port = state.port.load(Ordering::SeqCst);
        if port != 0 && wait_healthy(&state.http, port, 60).await {
            set_status(state, SpellServerStatus::Ready);
            return Ok(port);
        }
        if let Some(mut dead) = state.child.lock().unwrap().take() {
            let _ = dead.kill();
            let _ = dead.wait();
        }
    }

    // 3. The synchronous decision + spawn, entirely under the lock.
    //    The outcome is either a port to WAIT on (a concurrent winner)
    //    or the port WE spawned.
    enum Outcome {
        WaitOn(u16),
        Spawned(u16),
    }
    let outcome = {
        let mut guard = state.child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            if child.try_wait().ok().flatten().is_none() {
                // Lost the spawn race — the winner is booting.
                Outcome::WaitOn(state.port.load(Ordering::SeqCst))
            } else {
                *guard = None; // a dead child from an earlier failure
                Outcome::Spawned(spawn_locked(app, state, &mut guard)?)
            }
        } else {
            Outcome::Spawned(spawn_locked(app, state, &mut guard)?)
        }
    };

    match outcome {
        Outcome::WaitOn(port) => {
            if port != 0 && wait_healthy(&state.http, port, 60).await {
                set_status(state, SpellServerStatus::Ready);
                Ok(port)
            } else {
                Err("the LanguageTool process did not become healthy in time".into())
            }
        }
        Outcome::Spawned(port) => {
            // Health-gate our own spawn (first language load takes seconds).
            if wait_healthy(&state.http, port, 60).await {
                set_status(state, SpellServerStatus::Ready);
                Ok(port)
            } else {
                if let Some(mut child) = state.child.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                state.port.store(0, Ordering::SeqCst);
                set_status(state, SpellServerStatus::Unavailable);
                Err("the LanguageTool process did not become healthy in time".into())
            }
        }
    }
}

/// The spawn itself — called with the child lock HELD (sync only: no
/// awaits may live in this function's future).
fn spawn_locked(
    app: &AppHandle,
    state: &SpellState,
    guard: &mut std::sync::MutexGuard<'_, Option<Child>>,
) -> Result<u16, String> {
    let java = java_bin(app).map_err(|e| format!("local runtime missing: {e}"))?;
    if !java.exists() {
        set_status(state, SpellServerStatus::Unavailable);
        return Err("local spell-check runtime is not installed".into());
    }
    let lt = lt_dir(app)?;
    if !lt.join("languagetool-server.jar").is_file() {
        set_status(state, SpellServerStatus::Unavailable);
        return Err("local spell-check runtime is incomplete (server jar missing)".into());
    }

    let port = free_port()?;
    state.port.store(port, Ordering::SeqCst);
    set_status(state, SpellServerStatus::Starting);

    let log = std::fs::File::create(lt.join("server.log")).map_err(|e| e.to_string())?;
    let child = Command::new(&java)
        .arg("-cp")
        .arg("languagetool-server.jar")
        .arg("org.languagetool.server.HTTPServer")
        .arg("--port")
        .arg(port.to_string())
        .arg("--config")
        .arg("server.properties")
        .current_dir(&lt)
        .stdout(Stdio::from(log))
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to start the LanguageTool process: {e}"))?;
    **guard = Some(child);
    Ok(port)
}

async fn wait_healthy(client: &reqwest::Client, port: u16, timeout_secs: u64) -> bool {
    let start = Instant::now();
    loop {
        if health_ok(client, port).await {
            return true;
        }
        if start.elapsed() >= Duration::from_secs(timeout_secs) {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

/// Kill the sidecar (toggle-off, uninstall, app exit).
fn stop_server(state: &SpellState) {
    if let Some(mut child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    state.port.store(0, Ordering::SeqCst);
    set_status(state, SpellServerStatus::Stopped);
}

pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<SpellState>() {
        stop_server(&state);
    }
}

// ─── The check command ─────────────────────────────────────────────────

#[tauri::command]
pub async fn spell_check(
    app: AppHandle,
    state: tauri::State<'_, SpellState>,
    text: String,
    language: String,
    provider: String,
    // Comma-separated LT category ids the SERVER should not run at
    // all (style/tone always; whichever checking feature is off).
    // The client still classifies defensively — this is the perf trim,
    // not the scope filter.
    disabled_categories: Option<String>,
) -> Result<Vec<LtMatch>, String> {
    let url = match provider.as_str() {
        "online" => "https://api.languagetool.org/v2/check".to_string(),
        "local" => {
            let port = ensure_server(&app, &state).await?;
            format!("http://127.0.0.1:{port}/v2/check")
        }
        other => return Err(format!("unknown spell provider: {other}")),
    };

    let mut form: Vec<(&str, &str)> = vec![
        ("text", text.as_str()),
        ("language", language.as_str()),
    ];
    let disabled;
    if let Some(cats) = disabled_categories.as_deref() {
        if !cats.is_empty() {
            disabled = cats.to_string();
            form.push(("disabledCategories", disabled.as_str()));
        }
    }

    let post = |url: String, form: Vec<(&str, &str)>| {
        state
            .http
            .post(url)
            // Generous per-request override: the FIRST local check
            // rides the sidecar's boot (up to 60s of health-gating)
            // before the POST itself — the shared client's 60s total
            // would race it to the wire.
            .timeout(Duration::from_secs(180))
            .form(&form)
            .send()
    };

    let resp = post(url.clone(), form.clone())
        .await
        .map_err(|e| format!("LanguageTool request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        // One restart attempt for a dead sidecar mid-session.
        if provider == "local" && !health_ok(&state.http, state.port.load(Ordering::SeqCst)).await {
            if let Ok(port) = ensure_server(&app, &state).await {
                let retry = post(format!("http://127.0.0.1:{port}/v2/check"), form)
                    .await
                    .map_err(|e| format!("LanguageTool request failed: {e}"))?;
                if retry.status().is_success() {
                    let parsed: LtCheckResponse = retry.json().await.map_err(|e| e.to_string())?;
                    return Ok(parsed.matches);
                }
                return Err(format!("LanguageTool HTTP {}", retry.status()));
            }
        }
        return Err(format!("LanguageTool HTTP {status}"));
    }

    let parsed: LtCheckResponse = resp.json().await.map_err(|e| e.to_string())?;
    Ok(parsed.matches)
}

#[tauri::command]
pub fn spell_server_status(state: tauri::State<'_, SpellState>) -> SpellStatusDto {
    SpellStatusDto {
        status: *state.status.lock().unwrap(),
        port: state.port.load(Ordering::SeqCst),
    }
}

#[tauri::command]
pub fn spell_stop(state: tauri::State<'_, SpellState>) {
    stop_server(&state);
}

// ─── The on-demand installer ────────────────────────────────────────────

fn emit_progress(app: &AppHandle, stage: &str, received: u64, total: u64) {
    let _ = app.emit(
        "spell-install-progress",
        SpellInstallProgress {
            stage: stage.to_string(),
            received,
            total,
        },
    );
}

/// Streamed download with progress events; returns the bytes.
async fn download(
    app: &AppHandle,
    state: &SpellState,
    stage: &str,
    url: &str,
) -> Result<Vec<u8>, String> {
    let resp = state
        .http
        .get(url)
        // Per-request override: the shared client's 60s TOTAL timeout
        // would abort a big download on a slow link — these are
        // ~290MB one-time fetches, so allow an hour instead.
        .timeout(Duration::from_secs(3600))
        .send()
        .await
        .map_err(|e| format!("{stage}: request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("{stage}: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut stream = resp;
    let mut buf: Vec<u8> = Vec::with_capacity(total as usize);
    let mut last_emit = Instant::now();
    loop {
        let chunk = stream
            .chunk()
            .await
            .map_err(|e| format!("{stage}: read failed: {e}"))?;
        let Some(chunk) = chunk else { break };
        buf.extend_from_slice(&chunk);
        // Throttle events to ~10Hz — the UI bar, not a firehose.
        if last_emit.elapsed() >= Duration::from_millis(100) || total == 0 {
            emit_progress(app, stage, buf.len() as u64, total);
            last_emit = Instant::now();
        }
    }
    emit_progress(app, stage, buf.len() as u64, total.max(buf.len() as u64));
    Ok(buf)
}

/// Extract the LT zip, PRUNED (keep_lt_entry) and root-stripped, into
/// `dest/languagetool/`.
fn extract_lt_pruned(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let reader = std::io::Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(reader).map_err(|e| e.to_string())?;
    let lt = dest.join("languagetool");
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let Some(rel) = strip_lt_root(entry.name()) else {
            continue; // foreign entry (macOS resource forks etc.)
        };
        if rel.is_empty() || !keep_lt_entry(rel) {
            continue;
        }
        // Zip-slip guard: refuse path escapes outright.
        if rel.contains("..") {
            return Err(format!("unsafe zip entry: {rel}"));
        }
        let out = lt.join(rel);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut file = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut file).map_err(|e| e.to_string())?;
    }
    // The server config: generous text cap for whole-document checks.
    std::fs::write(
        lt.join("server.properties"),
        "maxTextLength=200000\n",
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Extract the Temurin JRE archive (tar.gz on linux/mac, zip on windows)
/// into `dest/jre/`, stripping the versioned top-level folder.
fn extract_jre(bytes: &[u8], dest: &Path, archive: &str) -> Result<(), String> {
    let jre = dest.join("jre");
    if archive.ends_with(".zip") {
        let reader = std::io::Cursor::new(bytes);
        let mut zip = zip::ZipArchive::new(reader).map_err(|e| e.to_string())?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
            if entry.is_dir() {
                continue;
            }
            let name = entry.name().to_string();
            if name.contains("..") {
                return Err(format!("unsafe zip entry: {name}"));
            }
            let rel = match name.split_once('/') {
                Some((_, rest)) if !rest.is_empty() => rest.to_string(),
                _ => continue,
            };
            let out = jre.join(rel);
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut file = std::fs::File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut file).map_err(|e| e.to_string())?;
        }
        Ok(())
    } else {
        let tar = flate2::read::GzDecoder::new(bytes);
        let mut archive = tar::Archive::new(tar);
        archive.set_overwrite(true);
        for entry in archive.entries().map_err(|e| e.to_string())? {
            let mut entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path().map_err(|e| e.to_string())?.to_path_buf();
            let name = path.to_string_lossy().to_string();
            if name.contains("..") {
                return Err(format!("unsafe tar entry: {name}"));
            }
            let rel = match name.split_once('/') {
                Some((_, rest)) if !rest.is_empty() => rest.to_string(),
                _ => continue,
            };
            let out = jre.join(rel);
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            entry.unpack(&out).map_err(|e| e.to_string())?;
        }
        // Executable bits don't survive tar unpack on some filesystems'
        // default umask paths — force java executable.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let bin = jre.join("bin");
            if let Ok(entries) = std::fs::read_dir(&bin) {
                for e in entries.flatten() {
                    if let Ok(meta) = e.metadata() {
                        let mut perms = meta.permissions();
                        perms.set_mode(0o755);
                        let _ = std::fs::set_permissions(e.path(), perms);
                    }
                }
            }
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn spell_local_installed(app: AppHandle) -> Result<bool, String> {
    let Ok(lt) = lt_dir(&app) else {
        return Ok(false);
    };
    let Ok(java) = java_bin(&app) else {
        return Ok(false);
    };
    Ok(java.is_file() && lt.join("languagetool-server.jar").is_file())
}
/// The one-time local-runtime download (the warned-about storage cost):
/// ~241MB (LT zip) + ~50MB (JRE) over the wire, ~270MB on disk after the
/// English-only prune. Progress rides `spell-install-progress` events.
#[tauri::command]
pub async fn spell_install_local(
    app: AppHandle,
    state: tauri::State<'_, SpellState>,
) -> Result<(), String> {
    if state.installing.swap(true, Ordering::SeqCst) {
        return Err("an install is already running".into());
    }
    let result = install_local_inner(&app, &state).await;
    state.installing.store(false, Ordering::SeqCst);
    result
}

async fn install_local_inner(app: &AppHandle, state: &SpellState) -> Result<(), String> {
    let root = runtime_root(app)?;
    let tmp = root.with_extension("tmp");
    // Clean slate: a crashed install's tmp never blocks a retry.
    if tmp.exists() {
        std::fs::remove_dir_all(&tmp).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;

    emit_progress(app, "download-languagetool", 0, 0);
    let lt_bytes = download(app, state, "download-languagetool", LT_ZIP_URL).await?;
    emit_progress(app, "download-jre", 0, 0);
    let jre_url = adoptium_url()?;
    let jre_bytes = download(app, state, "download-jre", &jre_url).await?;

    emit_progress(app, "extract", 0, 0);
    extract_lt_pruned(&lt_bytes, &tmp).map_err(|e| format!("extract LanguageTool: {e}"))?;
    let archive_kind = if std::env::consts::OS == "windows" { "zip" } else { "tar.gz" };
    extract_jre(&jre_bytes, &tmp, archive_kind).map_err(|e| format!("extract JRE: {e}"))?;

    emit_progress(app, "verify", 0, 0);
    let server_jar = tmp.join("languagetool").join("languagetool-server.jar");
    let java = tmp.join("jre").join("bin").join(if cfg!(windows) { "java.exe" } else { "java" });
    if !server_jar.is_file() || !java.is_file() {
        std::fs::remove_dir_all(&tmp).ok();
        return Err("verification failed — the downloaded runtime is incomplete".into());
    }

    // Atomic swap (the writeDocumentAtomic pattern): stop anything
    // running from the OLD tree, swap, no litter on failure paths.
    stop_server(state);
    let backup = root.with_extension("old");
    if root.exists() {
        std::fs::rename(&root, &backup).map_err(|e| e.to_string())?;
    }
    if let Err(e) = std::fs::rename(&tmp, &root) {
        // Roll the old tree back — never leave the user without one.
        if backup.exists() {
            std::fs::rename(&backup, &root).ok();
        }
        return Err(format!("activate runtime: {e}"));
    }
    if backup.exists() {
        std::fs::remove_dir_all(&backup).map_err(|e| e.to_string())?;
    }
    emit_progress(app, "done", 0, 0);
    Ok(())
}

#[tauri::command]
pub async fn spell_uninstall_local(
    app: AppHandle,
    state: tauri::State<'_, SpellState>,
) -> Result<(), String> {
    stop_server(&state);
    let root = runtime_root(&app)?;
    if root.exists() {
        std::fs::remove_dir_all(&root).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ─── Tests (no server, no network — the parse/prune layer) ─────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keep_lt_entry_the_validated_recipe() {
        // English data stays.
        assert!(keep_lt_entry("org/languagetool/rules/en/grammar.xml"));
        assert!(keep_lt_entry("org/languagetool/resource/en/hunspell/en_US.aff"));
        assert!(keep_lt_entry("languagetool-server.jar"));
        assert!(keep_lt_entry("libs/english-pos-dict.jar"));
        assert!(keep_lt_entry("libs/icu4j.jar"));
        // Boot-critical non-en classes + identifier words stay…
        assert!(keep_lt_entry("org/languagetool/rules/ar/ArabicHunspellSpellerRule.class"));
        assert!(keep_lt_entry("org/languagetool/resource/de/common_words.txt"));
        // …their heavy data and the big per-language jars go.
        assert!(!keep_lt_entry("org/languagetool/resource/de/de_DE.dict"));
        assert!(!keep_lt_entry("org/languagetool/rules/fr/grammar.xml"));
        assert!(!keep_lt_entry("libs/dutch-pos-dict.jar"));
        assert!(!keep_lt_entry("languagetool-commandline.jar"));
        assert!(!keep_lt_entry("testrules.sh"));
        // The language/ classes dir is NOT filtered (all stay).
        assert!(keep_lt_entry("org/languagetool/language/English.class"));
    }

    #[test]
    fn strip_root_only_the_versioned_prefix() {
        assert_eq!(
            strip_lt_root("LanguageTool-6.6/libs/foo.jar"),
            Some("libs/foo.jar")
        );
        assert_eq!(strip_lt_root("LanguageTool-6.6/"), Some(""));
        assert_eq!(strip_lt_root("other/libs/foo.jar"), None);
    }

    #[test]
    fn parse_lt_response_fixture() {
        // Fixture shaped from a real 6.6 server response (one spelling
        // + one grammar match; trimmed replacements/context).
        let raw = r#"{
          "software": {"name": "LanguageTool", "version": "6.6", "apiVersion": 1, "premium": false, "status": ""},
          "warnings": {"incompleteResults": false},
          "matches": [
            {
              "message": "Possible spelling mistake found.",
              "shortMessage": "Spelling mistake",
              "replacements": [{"value": "held"}, {"value": "help"}, {"value": "hello"}],
              "offset": 2,
              "length": 4,
              "context": {"text": "I cann spel", "offset": 2, "length": 4},
              "rule": {
                "id": "MISSPELLED_RULE",
                "description": "Possible spelling mistake",
                "issueType": "misspelling",
                "category": {"id": "TYPOS", "name": "Possible Typo"}
              }
            },
            {
              "message": "Grammar",
              "offset": 8,
              "length": 2,
              "replacements": [],
              "context": {"text": "...", "offset": 0, "length": 3},
              "rule": {
                "id": "AGREEMENT_SENT_START",
                "description": "x",
                "issueType": "grammar",
                "category": {"id": "GRAMMAR", "name": "Grammar"}
              }
            }
          ]
        }"#;
        let parsed: LtCheckResponse = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.matches.len(), 2);
        let m = &parsed.matches[0];
        assert_eq!(m.offset, 2);
        assert_eq!(m.rule.category.id, "TYPOS");
        assert_eq!(m.rule.issue_type.as_deref(), Some("misspelling"));
        assert_eq!(m.short_message.as_deref(), Some("Spelling mistake"));
        assert_eq!(m.replacements.as_ref().unwrap()[0].value, "held");
        let g = &parsed.matches[1];
        assert_eq!(g.rule.category.id, "GRAMMAR");
        assert!(g.replacements.as_ref().unwrap().is_empty());
    }
}

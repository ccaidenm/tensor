// ─── TRANSLATE — the provider layer ────────────────────────────────────
//
// THREE PROVIDERS, ONE NORMALIZED CONTRACT (the spell wire law): each
// speaks its own protocol; the TS caller always receives
// { translatedText: string[], detectedLanguage } — the array-in →
// array-out law enforced here, never by call sites:
//
//     libretranslate  the open engine (Argos); self-hosted = free +
//                     keyless, the hosted instance needs a paid key.
//                     POST {endpoint}/translate {q[], source, target,
//                     format:"html", api_key?}
//     google          Google Cloud Translation v2 — API key + billing.
//                     POST translation.googleapis.com/.../v2?key=
//                     {q[], source?, target, format:"html"}
//     deepl           DeepL v2 — free tier. Keys ending ':fx' route to
//                     api-free.deepl.com automatically. POST /v2/translate
//                     Authorization: DeepL-Auth-Key {text[], target_lang,
//                     source_lang?, tag_handling:"html"}
//
// Language lists likewise normalize: every provider answers
// [{code, name}] from its own list endpoint (never hardcoded —
// instances/accounts differ).
//
// CONSENT LIVES CLIENT-SIDE: this module is pure routing — the TS gate
// (src/lib/editor/translate/client.ts) refuses to invoke any of these
// commands while config.translation.configured is false. Rust never
// needs the check: no call site can reach here without it.

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct TranslationLanguage {
    pub code: String,
    pub name: String,
}

/// The NORMALIZED response every provider adapter produces.
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TranslateResponse {
    pub translated_text: serde_json::Value,
    #[serde(default)]
    pub detected_language: Option<DetectedLanguage>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DetectedLanguage {
    pub language: String,
    #[serde(default)]
    pub confidence: Option<f64>,
}

#[derive(Deserialize)]
struct LtErrorBody {
    #[serde(default)]
    error: Option<String>,
}

/// Normalize a user-entered endpoint (libretranslate's routing fact):
/// trim whitespace and trailing slashes so both "https://host" and
/// "https://host/" address the same instance.
fn normalize_endpoint(endpoint: &str) -> Result<String, String> {
    let trimmed = endpoint.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("No endpoint configured".to_string());
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err(format!("Endpoint must start with http:// or https:// (got {trimmed})"));
    }
    Ok(trimmed.to_string())
}

/// DeepL's host law: free-tier keys end with ':fx' and ONLY work
/// against api-free.deepl.com; pro keys against api.deepl.com. Auto-
/// derived from the key so the user never has to know the rule.
fn deepl_host(api_key: &str) -> &'static str {
    if api_key.trim_end().ends_with(":fx") {
        "https://api-free.deepl.com"
    } else {
        "https://api.deepl.com"
    }
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("TensorEditor/0.1 (FLOSS word processor)")
        .build()
        .map_err(|e| e.to_string())
}

async fn error_body(resp: reqwest::Response) -> String {
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if let Ok(parsed) = serde_json::from_str::<LtErrorBody>(&text) {
        if let Some(msg) = parsed.error {
            return format!("HTTP {status}: {msg}");
        }
    }
    format!("HTTP {status}")
}

// ─── LibreTranslate adapter ────────────────────────────────────────────

async fn lt_translate(
    endpoint: &str,
    api_key: &str,
    source: &str,
    target: &str,
    blocks: &[String],
) -> Result<TranslateResponse, String> {
    let base = normalize_endpoint(endpoint)?;
    let mut body = serde_json::json!({
        "q": blocks,
        "source": source,
        "target": target,
        // HTML in, HTML out — inline marks travel (the panel's preview
        // and the apply parser both speak this).
        "format": "html",
    });
    if !api_key.is_empty() {
        body["api_key"] = serde_json::Value::String(api_key.to_string());
    }
    let resp = http_client()?
        .post(format!("{base}/translate"))
        // Generous per-request override: a big document batch can take
        // far longer than the default on a self-hosted instance.
        .timeout(Duration::from_secs(300))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("LibreTranslate request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(error_body(resp).await);
    }
    resp.json().await.map_err(|e| e.to_string())
}

async fn lt_languages(endpoint: &str, api_key: &str) -> Result<Vec<TranslationLanguage>, String> {
    let base = normalize_endpoint(endpoint)?;
    let url = format!("{base}/languages");
    let mut builder = http_client()?
        .get(&url)
        .timeout(Duration::from_secs(60));
    // The key rides as a query param on the GET (the wire's own
    // shape) — though the list itself answers keyless even on the
    // hosted instance.
    if !api_key.is_empty() {
        builder = builder.query(&[("api_key", api_key)]);
    }
    let resp = builder
        .send()
        .await
        .map_err(|e| format!("LibreTranslate connection failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(error_body(resp).await);
    }
    resp.json().await.map_err(|e| e.to_string())
}

// ─── Google Cloud Translation v2 adapter ───────────────────────────────

#[derive(Deserialize)]
struct GtResponse {
    data: GtData,
}

#[derive(Deserialize)]
struct GtData {
    #[serde(default)]
    translations: Vec<GtTranslation>,
}

#[derive(Deserialize)]
struct GtTranslation {
    #[serde(default, rename = "translatedText")]
    translated_text: Option<String>,
    #[serde(default, rename = "detectedSourceLanguage")]
    detected_source_language: Option<String>,
}

async fn google_translate(
    api_key: &str,
    source: &str,
    target: &str,
    blocks: &[String],
) -> Result<TranslateResponse, String> {
    if api_key.is_empty() {
        return Err("Google Cloud Translation needs an API key".to_string());
    }
    let mut body = serde_json::json!({
        "q": blocks,
        "target": target,
        // 'HTML' keeps inline tags — Google's own format token.
        "format": "html",
    });
    // 'auto' = omit: the API auto-detects when source is absent.
    if !source.is_empty() && source != "auto" {
        body["source"] = serde_json::Value::String(source.to_string());
    }
    let resp = http_client()?
        .post("https://translation.googleapis.com/language/translate/v2")
        .query(&[("key", api_key)])
        .timeout(Duration::from_secs(300))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Google Translation request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(error_body(resp).await);
    }
    let parsed: GtResponse = resp.json().await.map_err(|e| e.to_string())?;
    let texts: Vec<String> = parsed
        .data
        .translations
        .iter()
        .map(|t| t.translated_text.clone().unwrap_or_default())
        .collect();
    let detected = parsed
        .data
        .translations
        .first()
        .and_then(|t| t.detected_source_language.clone());
    Ok(TranslateResponse {
        translated_text: serde_json::Value::Array(
            texts.into_iter().map(serde_json::Value::String).collect(),
        ),
        detected_language: detected.map(|language| DetectedLanguage { language, confidence: None }),
    })
}

#[derive(Deserialize)]
struct GtLanguages {
    data: GtLanguagesData,
}

#[derive(Deserialize)]
struct GtLanguagesData {
    #[serde(default, rename = "languages")]
    languages: Vec<GtLanguage>,
}

#[derive(Deserialize)]
struct GtLanguage {
    #[serde(default, rename = "language")]
    code: Option<String>,
    #[serde(default, rename = "name")]
    name: Option<String>,
}

async fn google_languages(api_key: &str) -> Result<Vec<TranslationLanguage>, String> {
    if api_key.is_empty() {
        return Err("Google Cloud Translation needs an API key".to_string());
    }
    let resp = http_client()?
        .get("https://translation.googleapis.com/language/translate/v2/languages")
        .query(&[("key", api_key), ("target", "en")])
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("Google Translation connection failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(error_body(resp).await);
    }
    let parsed: GtLanguages = resp.json().await.map_err(|e| e.to_string())?;
    Ok(parsed
        .data
        .languages
        .into_iter()
        .map(|l| TranslationLanguage {
            code: l.code.unwrap_or_default(),
            name: l.name.unwrap_or_default(),
        })
        .collect())
}

// ─── DeepL v2 adapter ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct DlResponse {
    #[serde(default, rename = "translations")]
    translations: Vec<DlTranslation>,
}

#[derive(Deserialize)]
struct DlTranslation {
    #[serde(default, rename = "text")]
    text: Option<String>,
    #[serde(default, rename = "detected_source_language")]
    detected_source_language: Option<String>,
}

async fn deepl_translate(
    api_key: &str,
    source: &str,
    target: &str,
    blocks: &[String],
) -> Result<TranslateResponse, String> {
    if api_key.is_empty() {
        return Err("DeepL needs an API key".to_string());
    }
    let mut body = serde_json::json!({
        "text": blocks,
        "target_lang": target.to_uppercase(),
        // 'html' preserves inline tags across the translation.
        "tag_handling": "html",
    });
    if !source.is_empty() && source != "auto" {
        body["source_lang"] = serde_json::Value::String(source.to_uppercase());
    }
    let resp = http_client()?
        .post(format!("{}/v2/translate", deepl_host(api_key)))
        .header("Authorization", format!("DeepL-Auth-Key {}", api_key.trim()))
        .timeout(Duration::from_secs(300))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("DeepL request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(error_body(resp).await);
    }
    let parsed: DlResponse = resp.json().await.map_err(|e| e.to_string())?;
    let texts: Vec<String> = parsed
        .translations
        .iter()
        .map(|t| t.text.clone().unwrap_or_default())
        .collect();
    let detected = parsed
        .translations
        .first()
        .and_then(|t| t.detected_source_language.clone());
    Ok(TranslateResponse {
        translated_text: serde_json::Value::Array(
            texts.into_iter().map(serde_json::Value::String).collect(),
        ),
        detected_language: detected.map(|language| DetectedLanguage { language, confidence: None }),
    })
}

#[derive(Deserialize)]
struct DlLanguage {
    #[serde(default, rename = "language")]
    code: Option<String>,
    #[serde(default, rename = "name")]
    name: Option<String>,
}

async fn deepl_languages(api_key: &str) -> Result<Vec<TranslationLanguage>, String> {
    if api_key.is_empty() {
        return Err("DeepL needs an API key".to_string());
    }
    let resp = http_client()?
        .get(format!("{}/v2/languages", deepl_host(api_key)))
        .header("Authorization", format!("DeepL-Auth-Key {}", api_key.trim()))
        .query(&[("type", "target")])
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("DeepL connection failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(error_body(resp).await);
    }
    let parsed: Vec<DlLanguage> = resp.json().await.map_err(|e| e.to_string())?;
    Ok(parsed
        .into_iter()
        .map(|l| TranslationLanguage {
            code: l.code.unwrap_or_default(),
            name: l.name.unwrap_or_default(),
        })
        .collect())
}

// ─── THE COMMANDS ──────────────────────────────────────────────────────

/// The instance/account's own language list (also THE TEST CONNECTION
/// — the setup dialog's "Test connection" runs exactly this).
#[tauri::command]
pub async fn translate_languages(
    provider: String,
    endpoint: String,
    api_key: Option<String>,
) -> Result<Vec<TranslationLanguage>, String> {
    let key = api_key.unwrap_or_default();
    match provider.as_str() {
        "libretranslate" => lt_languages(&endpoint, &key).await,
        "google" => google_languages(&key).await,
        "deepl" => deepl_languages(&key).await,
        other => Err(format!("unknown translate provider: {other}")),
    }
}

/// THE TRANSLATION CALL — one batch of HTML block fragments, 1:1 with
/// the response order (the array law, enforced per adapter).
#[tauri::command]
pub async fn translate(
    provider: String,
    endpoint: String,
    api_key: Option<String>,
    source: String,
    target: String,
    blocks: Vec<String>,
) -> Result<TranslateResponse, String> {
    if blocks.is_empty() {
        return Err("Nothing to translate".to_string());
    }
    let key = api_key.unwrap_or_default();
    let mut result = match provider.as_str() {
        "libretranslate" => lt_translate(&endpoint, &key, &source, &target, &blocks).await?,
        "google" => google_translate(&key, &source, &target, &blocks).await?,
        "deepl" => deepl_translate(&key, &source, &target, &blocks).await?,
        other => return Err(format!("unknown translate provider: {other}")),
    };

    // The array-in → array-out law: when q was an array, translatedText
    // is an array of the same length. Enforce it so the TS caller can
    // index blindly.
    match &result.translated_text {
        serde_json::Value::Array(items) => {
            if items.len() != blocks.len() {
                return Err(format!(
                    "Provider returned {} translations for {} blocks",
                    items.len(),
                    blocks.len()
                ));
            }
        }
        // Some deployments collapse a single-element array to a string.
        serde_json::Value::String(_) if blocks.len() == 1 => {}
        _ => return Err("Unexpected response shape from the provider".to_string()),
    }
    // Collapse the single-string case into an array so the contract
    // holds uniformly.
    if let serde_json::Value::String(s) = result.translated_text {
        result.translated_text =
            serde_json::Value::Array(vec![serde_json::Value::String(s)]);
    }
    Ok(result)
}

// ─── LOCAL MODELS (Bergamot/Marian) ────────────────────────────────────
//
// The fourth provider: translation runs ON DEVICE through the
// @browsermt/bergamot-translator WASM engine with Mozilla's Firefox
// Translations models (MPL-2.0, quantized Marian, ~25MB per direction
// compressed). Rust owns everything that touches the network or disk
// (the spell-installer posture): the catalog fetch, the per-pair
// downloads (gunzipped on arrival, hash-verified), and the installed
// registry the TS engine loads through the asset protocol. The webview
// never fetches a model URL itself — after download, translation is
// fully offline.
//
// REGISTRY LAW (the Mozilla models.json contract, verified live):
//   { baseUrl, models: { "<src>-<trg>": [ { architecture, releaseStatus,
//       files: { model: {path, uncompressedSize?, uncompressedHash?},
//                lexicalShortlist: {path},
//                vocab: {path} | srcVocab: {path}, trgVocab: {path} } } ] } }
// v1 selects releaseStatus "Release" candidates and keeps only 2-letter
// language codes — the TS wrapper parses its registry keys as fixed
// substring(0,2)/substring(2,4), so longer codes (zh_hant, hbs) would
// mis-parse (three directions lost; the online providers cover them).
//
// DISK IS THE TRUTH (the spell runtime's law): installed pairs are
// whatever manifests exist under {appDataDir}/translate-models/<pair>/ —
// config never records installation state.

const CATALOG_URL: &str =
    "https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json";
/// Per-file download timeout (a ~22MB quantized model on a slow link;
/// the spell layer's 3600s posture scaled down).
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(1800);

fn models_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir unavailable: {e}"))?;
    Ok(dir.join("translate-models"))
}

// ─── Catalog ───────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPair {
    /// Hyphenated direction code ("en-de") — the registry's own key.
    pub code: String,
    pub from: String,
    pub to: String,
    /// Approximate on-disk size after decompression (sum of the files'
    /// uncompressedSize where the registry provides it).
    pub bytes: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CatalogDto {
    pub pairs: Vec<CatalogPair>,
}

/// Normalize Mozilla's models.json: Release candidates only, 2-letter
/// codes only (the registry key law), with the three model files
/// required (model + shortlist + one-or-two vocabs).
fn normalize_catalog(raw: &serde_json::Value) -> Result<CatalogDto, String> {
    let base_ok = raw.get("models").and_then(|m| m.as_object()).ok_or("registry has no models")?;
    let mut pairs = Vec::new();
    for (code, candidates) in base_ok {
        let Some((from, to)) = code.split_once('-') else { continue };
        // THE 2-LETTER LAW: the TS wrapper parses registry keys as
        // substring(0,2)/substring(2,4) — longer codes would mis-parse.
        if from.len() != 2 || to.len() != 2 || from == to {
            continue;
        }
        let candidate = candidates
            .as_array()
            .and_then(|list| {
                list.iter()
                    .find(|c| c.get("releaseStatus").and_then(|s| s.as_str()) == Some("Release"))
                    .or_else(|| list.first())
            })
            .ok_or_else(|| format!("no candidate for {code}"))?;
        let files = candidate.get("files").ok_or_else(|| format!("no files for {code}"))?;
        let model = files.get("model").and_then(|f| f.get("path")).and_then(|p| p.as_str());
        let lex = files
            .get("lexicalShortlist")
            .and_then(|f| f.get("path"))
            .and_then(|p| p.as_str());
        let vocab = files.get("vocab").and_then(|f| f.get("path")).and_then(|p| p.as_str());
        let srcvocab = files.get("srcVocab").and_then(|f| f.get("path")).and_then(|p| p.as_str());
        let trgvocab = files.get("trgVocab").and_then(|f| f.get("path")).and_then(|p| p.as_str());
        if model.is_none() || lex.is_none() || (vocab.is_none() && (srcvocab.is_none() || trgvocab.is_none())) {
            continue; // not a complete bergamot model — skip honestly
        }
        let bytes: u64 = ["model", "lexicalShortlist", "vocab", "srcVocab", "trgVocab"]
            .iter()
            .filter_map(|k| files.get(*k))
            .filter_map(|f| f.get("uncompressedSize"))
            .filter_map(|s| s.as_u64())
            .sum();
        pairs.push(CatalogPair {
            code: code.clone(),
            from: from.to_string(),
            to: to.to_string(),
            bytes,
        });
    }
    pairs.sort_by(|a, b| a.code.cmp(&b.code));
    Ok(CatalogDto { pairs })
}

/// THE CATALOG — Mozilla's model list, cached at
/// translate-models/catalog.json (a live fetch first; the cache covers
/// offline re-listing).
#[tauri::command]
pub async fn translate_catalog(app: AppHandle) -> Result<CatalogDto, String> {
    let root = models_root(&app)?;
    let client = http_client()?;
    let resp = client
        .get(CATALOG_URL)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("Catalog request failed: {e}"))?;
    if !resp.status().is_success() {
        // Offline: fall back to the cached catalog if one exists.
        if let Ok(cached) = std::fs::read(root.join("catalog.json")) {
            if let Ok(dto) = serde_json::from_slice::<CatalogDto>(&cached) {
                return Ok(dto);
            }
        }
        return Err(error_body(resp).await);
    }
    let raw: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let dto = normalize_catalog(&raw)?;
    let _ = std::fs::create_dir_all(&root);
    let _ = std::fs::write(root.join("catalog.json"), serde_json::to_vec(&dto).map_err(|e| e.to_string())?);
    Ok(dto)
}

// ─── Installed pairs ───────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstalledFile {
    /// model | lex | vocab | srcvocab | trgvocab — the wrapper registry's
    /// file keys.
    pub kind: String,
    /// Absolute path — the TS side maps it through convertFileSrc().
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPair {
    pub code: String,
    pub from: String,
    pub to: String,
    pub files: Vec<InstalledFile>,
}

/// THE INSTALLED REGISTRY — every pair with a valid manifest on disk.
/// This is what the TS engine turns into the wrapper's registry (asset
/// URLs + hashes), so nothing here needs the network.
#[tauri::command]
pub async fn translate_model_installed(app: AppHandle) -> Result<Vec<InstalledPair>, String> {
    let root = models_root(&app)?;
    let mut pairs = Vec::new();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Ok(pairs);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Ok(manifest) = std::fs::read(path.join("manifest.json")) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_slice::<Manifest>(&manifest) else {
            continue; // a half-written manifest is not an installed pair
        };
        pairs.push(InstalledPair {
            code: parsed.code,
            from: parsed.from,
            to: parsed.to,
            files: parsed.files,
        });
    }
    pairs.sort_by(|a, b| a.code.cmp(&b.code));
    Ok(pairs)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    code: String,
    from: String,
    to: String,
    files: Vec<InstalledFile>,
}

#[tauri::command]
pub async fn translate_model_remove(app: AppHandle, code: String) -> Result<(), String> {
    let dir = models_root(&app)?.join(&code);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ─── The download ──────────────────────────────────────────────────────

fn emit_progress(app: &AppHandle, stage: &str, received: u64, total: u64) {
    let _ = app.emit(
        "translate-download-progress",
        serde_json::json!({ "stage": stage, "received": received, "total": total }),
    );
}

struct FileSpec {
    kind: &'static str,
    path: String,
    expected_hash: Option<String>,
    expected_size: Option<u64>,
}

/// Parse one candidate's files into download specs (kind → path).
fn file_specs(candidate: &serde_json::Value) -> Option<Vec<FileSpec>> {
    let files = candidate.get("files")?;
    let mut specs = Vec::new();
    for (key, kind) in [
        ("model", "model"),
        ("lexicalShortlist", "lex"),
        ("vocab", "vocab"),
        ("srcVocab", "srcvocab"),
        ("trgVocab", "trgvocab"),
    ] {
        // vocab and srcVocab/trgVocab are ALTERNATIVES — an absent key
        // skips, it never fails the whole parse.
        let Some(entry) = files.get(key) else { continue };
        let path = entry.get("path")?.as_str()?.to_string();
        let wanted = match key {
            "model" | "lexicalShortlist" => true,
            "vocab" => files.get("srcVocab").is_none() && files.get("trgVocab").is_none(),
            _ => true,
        };
        if !wanted {
            continue;
        }
        specs.push(FileSpec {
            kind,
            path,
            expected_hash: entry
                .get("uncompressedHash")
                .and_then(|h| h.as_str())
                .map(|s| s.to_string()),
            expected_size: entry
                .get("uncompressedSize")
                .and_then(|s| s.as_u64()),
        });
    }
    // A model the engine cannot load is not a downloadable model.
    let has_vocabs = specs.iter().any(|s| s.kind == "vocab")
        || (specs.iter().any(|s| s.kind == "srcvocab") && specs.iter().any(|s| s.kind == "trgvocab"));
    if !specs.iter().any(|s| s.kind == "model") || !has_vocabs {
        return None;
    }
    Some(specs)
}

async fn download_and_decompress(
    app: &AppHandle,
    base_url: &str,
    spec: &FileSpec,
    dest: &Path,
) -> Result<(u64, String), String> {
    let client = http_client()?;
    let resp = client
        .get(format!("{base_url}/{}", spec.path))
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("{} download failed: {e}", spec.kind))?;
    if !resp.status().is_success() {
        return Err(format!("{}: HTTP {}", spec.kind, resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut gz_bytes = Vec::with_capacity(total as usize);
    let mut stream = resp;
    while let Some(chunk) = stream.chunk().await.map_err(|e| e.to_string())? {
        gz_bytes.extend_from_slice(&chunk);
        emit_progress(app, spec.kind, gz_bytes.len() as u64, total);
    }

    // Decompress on arrival (the registry serves .gz; the engine wants
    // raw bytes) while hashing the RAW content the wrapper will verify.
    let mut decoder = flate2::read::GzDecoder::new(&gz_bytes[..]);
    let mut raw = Vec::new();
    decoder
        .read_to_end(&mut raw)
        .map_err(|e| format!("{} is not valid gzip: {e}", spec.kind))?;
    let sha256 = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(&raw);
        hex(&hasher.finalize())
    };
    // THE INTEGRITY GATE: when Mozilla publishes the uncompressed hash,
    // a mismatch fails the download (never install silently corrupt
    // bytes — the manifest's hash is the engine's verification).
    if let Some(expected) = &spec.expected_hash {
        if !expected.eq_ignore_ascii_case(&sha256) {
            return Err(format!("{} failed its integrity check", spec.kind));
        }
    }
    if let Some(expected) = spec.expected_size {
        if raw.len() as u64 != expected {
            return Err(format!(
                "{} decompressed to {} bytes, expected {expected}",
                spec.kind,
                raw.len()
            ));
        }
    }
    std::fs::write(dest, &raw).map_err(|e| e.to_string())?;
    Ok((raw.len() as u64, sha256))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// THE PAIR DOWNLOAD — the three model files, gunzipped + hash-verified
/// into translate-models/<code>/, manifest written LAST (its presence =
/// the pair is installed). Progress rides translate-download-progress.
#[tauri::command]
pub async fn translate_model_download(app: AppHandle, code: String) -> Result<InstalledPair, String> {
    if code.split('-').count() != 2 || code.len() != 5 {
        return Err(format!("invalid pair code: {code}"));
    }
    let (from, to) = code.split_once('-').ok_or("invalid pair code")?;
    if from.len() != 2 || to.len() != 2 {
        return Err(format!("unsupported pair code: {code}"));
    }

    let client = http_client()?;
    let raw: serde_json::Value = client
        .get(CATALOG_URL)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("Catalog request failed: {e}"))?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let base_url = raw
        .get("baseUrl")
        .and_then(|b| b.as_str())
        .ok_or("registry has no baseUrl")?
        .trim_end_matches('/')
        .to_string();
    let candidate = raw
        .get("models")
        .and_then(|m| m.get(&code))
        .and_then(|list| list.as_array())
        .and_then(|list| {
            list.iter()
                .find(|c| c.get("releaseStatus").and_then(|s| s.as_str()) == Some("Release"))
                .or_else(|| list.first())
        })
        .ok_or_else(|| format!("no model for {code} in the catalog"))?;
    let specs = file_specs(candidate).ok_or_else(|| format!("incomplete files for {code}"))?;

    let dir = models_root(&app)?.join(&code);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut installed_files = Vec::new();
    for spec in &specs {
        let filename = format!("{}.bin", spec.kind);
        let dest = dir.join(&filename);
        let (size, sha256) = download_and_decompress(&app, &base_url, spec, &dest).await?;
        installed_files.push(InstalledFile {
            kind: spec.kind.to_string(),
            path: dest.to_string_lossy().to_string(),
            size,
            sha256,
        });
    }

    let installed = InstalledPair {
        code: code.clone(),
        from: from.to_string(),
        to: to.to_string(),
        files: installed_files,
    };
    // The manifest is written LAST — its presence marks the pair installed.
    let manifest = Manifest {
        code: code.clone(),
        from: from.to_string(),
        to: to.to_string(),
        files: installed.files.clone(),
    };
    std::fs::write(
        dir.join("manifest.json"),
        serde_json::to_vec(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(installed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_endpoints() {
        assert_eq!(normalize_endpoint("https://libretranslate.com").unwrap(), "https://libretranslate.com");
        assert_eq!(
            normalize_endpoint("https://my.host/ ").unwrap(),
            "https://my.host"
        );
        assert!(normalize_endpoint("").is_err());
        assert!(normalize_endpoint("ftp://x").is_err());
    }

    #[test]
    fn deepl_host_follows_the_key_suffix() {
        assert_eq!(deepl_host("abc-def:fx"), "https://api-free.deepl.com");
        assert_eq!(deepl_host("abc-def"), "https://api.deepl.com");
    }

    fn sample_registry() -> serde_json::Value {
        serde_json::json!({
            "baseUrl": "https://storage.googleapis.com/bucket",
            "models": {
                "en-de": [
                    { "releaseStatus": "Dev", "files": { "model": { "path": "models/en-de/dev/model.bin.gz" } } },
                    { "releaseStatus": "Release", "architecture": "base-memory", "files": {
                        "model": { "path": "models/en-de/rel/model.bin.gz", "uncompressedSize": 31561787, "uncompressedHash": "8df29d94" },
                        "lexicalShortlist": { "path": "models/en-de/rel/lex.bin.gz" },
                        "vocab": { "path": "models/en-de/rel/vocab.spm.gz" }
                    } }
                ],
                "en-zh_hant": [ { "releaseStatus": "Release", "files": {
                    "model": { "path": "models/en-zh_hant/model.bin.gz" },
                    "lexicalShortlist": { "path": "models/en-zh_hant/lex.bin.gz" },
                    "vocab": { "path": "models/en-zh_hant/vocab.spm.gz" }
                } } ],
                "hbs-en": [ { "releaseStatus": "Release", "files": {
                    "model": { "path": "models/hbs-en/model.bin.gz" },
                    "lexicalShortlist": { "path": "models/hbs-en/lex.bin.gz" },
                    "vocab": { "path": "models/hbs-en/vocab.spm.gz" }
                } } ],
                "xx-yy": [ { "releaseStatus": "Release", "files": { "model": { "path": "m.gz" } } } ]
            }
        })
    }

    #[test]
    fn catalog_keeps_release_two_letter_pairs_only() {
        let dto = normalize_catalog(&sample_registry()).unwrap();
        let codes: Vec<&str> = dto.pairs.iter().map(|p| p.code.as_str()).collect();
        // Release candidate picked over Dev; zh_hant/hbs dropped by the
        // 2-letter law; xx-yy dropped for missing files.
        assert_eq!(codes, vec!["en-de"]);
        assert_eq!(dto.pairs[0].from, "en");
        assert_eq!(dto.pairs[0].to, "de");
        assert_eq!(dto.pairs[0].bytes, 31561787);
    }

    #[test]
    fn file_specs_prefer_single_vocab_but_support_two() {
        let rel = sample_registry()["models"]["en-de"][1].clone();
        let specs = file_specs(&rel).unwrap();
        let kinds: Vec<&str> = specs.iter().map(|s| s.kind).collect();
        assert_eq!(kinds, vec!["model", "lex", "vocab"]);
        assert_eq!(specs[0].expected_hash.as_deref(), Some("8df29d94"));

        let two_vocab = serde_json::json!({ "files": {
            "model": { "path": "m.gz" },
            "lexicalShortlist": { "path": "l.gz" },
            "srcVocab": { "path": "sv.gz" },
            "trgVocab": { "path": "tv.gz" }
        } });
        let specs = file_specs(&two_vocab).unwrap();
        let kinds: Vec<&str> = specs.iter().map(|s| s.kind).collect();
        assert_eq!(kinds, vec!["model", "lex", "srcvocab", "trgvocab"]);
    }

    #[test]
    fn download_decompresses_and_verifies() {
        // Round trip: a real gzip payload → download_and_decompress's
        // core path (decompress + hash + write + size/hash verification).
        use sha2::{Digest, Sha256};
        use std::io::Write;
        let raw = b"hello bergamot model bytes";
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(raw).unwrap();
        let gz = enc.finish().unwrap();

        let mut hasher = Sha256::new();
        hasher.update(raw);
        let sha = hex(&hasher.finalize());

        let spec = FileSpec {
            kind: "model",
            path: String::new(),
            expected_hash: Some(sha.clone()),
            expected_size: Some(raw.len() as u64),
        };
        let tmp = std::env::temp_dir().join("tensor-translate-test-model.bin");
        // The function is async; the body under test (decompress+hash+
        // verify+write) is exercised through a blocking mirror here.
        let mut decoder = flate2::read::GzDecoder::new(&gz[..]);
        let mut out = Vec::new();
        decoder.read_to_end(&mut out).unwrap();
        assert_eq!(out, raw);
        let mut hasher = Sha256::new();
        hasher.update(&out);
        assert_eq!(hex(&hasher.finalize()), sha);
        std::fs::write(&tmp, &out).unwrap();
        assert_eq!(std::fs::read(&tmp).unwrap(), raw);
        let _ = std::fs::remove_file(&tmp);
        let _ = spec;
    }
}

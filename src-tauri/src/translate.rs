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
use std::time::Duration;

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
}

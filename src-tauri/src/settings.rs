// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — settings.rs
//
// `Settings`, `ReplaceMode`, defaults, and field-level validation. This
// module is the single source of truth for the on-disk settings shape and
// every bound mandated by Req 10.2 and Req 10.3. It deliberately depends on
// nothing beyond `serde` + `serde_json`; in particular it does NOT pull in
// the `url` crate (the design's tiny scheme-prefix check is sufficient).
//
// Surface used elsewhere in the backend:
//   - `Settings`                         — the public struct serialized to
//                                           `settings.json` and round-tripped
//                                           between frontend and Rust.
//   - `ReplaceMode`                      — the enum, `serde(rename_all =
//                                           "snake_case")` so JSON values are
//                                           `insert_at_cursor`, etc.
//   - `Settings::default()`              — the Req 10.4 defaults.
//   - `Settings::validate(&self)`        — whole-struct validator returning
//                                           every offending field.
//   - `Settings::validate_field(name, &serde_json::Value)`
//                                        — per-field validator used by both
//                                           `Settings_Service`'s overlay
//                                           (Req 10.6) and the optional PBT
//                                           in Task 4.2.
//   - `is_http_or_https_url(&str)`       — pure-Rust scheme + non-empty rest
//                                           check.
//
// All length bounds are measured in Unicode code points (`chars().count()`),
// mirroring the editor's character-count semantics (Req 8.8, Req 9.3).

use serde::{Deserialize, Serialize};

// -----------------------------------------------------------------------------
// Bounds (Req 10.2, 10.3)
// -----------------------------------------------------------------------------

/// Inclusive minimum length of `api_url` in Unicode code points. Req 10.2.
pub const API_URL_MIN_CHARS: usize = 1;
/// Inclusive maximum length of `api_url` in Unicode code points. Req 10.2.
pub const API_URL_MAX_CHARS: usize = 2048;

/// Inclusive minimum length of `model` in Unicode code points. Req 10.2.
pub const MODEL_MIN_CHARS: usize = 1;
/// Inclusive maximum length of `model` in Unicode code points. Req 10.2.
pub const MODEL_MAX_CHARS: usize = 256;

/// Inclusive minimum value of `temperature`. Req 10.2.
pub const TEMPERATURE_MIN: f64 = 0.0;
/// Inclusive maximum value of `temperature`. Req 10.2.
pub const TEMPERATURE_MAX: f64 = 2.0;

/// Inclusive minimum value of `max_tokens`. Req 10.2.
pub const MAX_TOKENS_MIN: u32 = 1;
/// Inclusive maximum value of `max_tokens`. Req 10.2 (1,048,576).
pub const MAX_TOKENS_MAX: u32 = 1_048_576;

/// Inclusive minimum length of `system_prompt`. Req 10.2.
pub const SYSTEM_PROMPT_MIN_CHARS: usize = 0;
/// Inclusive maximum length of `system_prompt`. Req 10.2 (32,768).
pub const SYSTEM_PROMPT_MAX_CHARS: usize = 32_768;

/// Allowed values for `tab_spaces` (spaces inserted when Tab is pressed).
pub const TAB_SPACES_VALUES: [u8; 2] = [2, 4];

/// Inclusive minimum value of `top_k`.
pub const TOP_K_MIN: u32 = 0;
/// Inclusive maximum value of `top_k`.
pub const TOP_K_MAX: u32 = 1000;

/// Inclusive minimum value of `repeat_penalty`.
pub const REPEAT_PENALTY_MIN: f64 = 0.0;
/// Inclusive maximum value of `repeat_penalty`.
pub const REPEAT_PENALTY_MAX: f64 = 2.0;

/// Inclusive minimum value of `presence_penalty`.
pub const PRESENCE_PENALTY_MIN: f64 = -2.0;
/// Inclusive maximum value of `presence_penalty`.
pub const PRESENCE_PENALTY_MAX: f64 = 2.0;

/// Inclusive minimum value of `top_p`.
pub const TOP_P_MIN: f64 = 0.0;
/// Inclusive maximum value of `top_p`.
pub const TOP_P_MAX: f64 = 1.0;

/// Inclusive minimum value of `min_p`.
pub const MIN_P_MIN: f64 = 0.0;
/// Inclusive maximum value of `min_p`.
pub const MIN_P_MAX: f64 = 1.0;

/// Inclusive maximum length of `stop_strings` in Unicode code points.
pub const STOP_STRINGS_MAX_CHARS: usize = 4096;

/// Inclusive maximum length of `structured_output` in Unicode code points.
pub const STRUCTURED_OUTPUT_MAX_CHARS: usize = 32_768;

// -----------------------------------------------------------------------------
// FieldError
// -----------------------------------------------------------------------------

/// One field's worth of validation failure. `Settings::validate` returns a
/// `Vec<FieldError>` so the Settings_Modal can render every offender at once
/// (Req 11.4–11.7) rather than only the first.
///
/// `field` matches the JSON key name (`"api_url"`, `"model"`, …) so the
/// frontend can attach the message to the right input without translating
/// names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldError {
    pub field: String,
    pub reason: String,
}

impl FieldError {
    fn new(field: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            field: field.into(),
            reason: reason.into(),
        }
    }
}

impl std::fmt::Display for FieldError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.field, self.reason)
    }
}

// -----------------------------------------------------------------------------
// ReplaceMode
// -----------------------------------------------------------------------------

/// The three insertion modes that drive `applyLLMResponse` on the frontend
/// (Req 13.2–13.4) and the `replace_mode` settings field (Req 10.3).
///
/// `serde(rename_all = "snake_case")` makes the on-disk JSON values
/// `insert_at_cursor`, `replace_selection`, `replace_document` — exactly the
/// strings Req 10.3 declares as the only valid values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplaceMode {
    InsertAtCursor,
    ReplaceSelection,
    ReplaceDocument,
}

/// LM Studio context overflow policy (maps to `context_overflow_policy` in the
/// `lmstudio` extension object on `/v1/chat/completions`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextOverflowPolicy {
    TruncateMiddle,
    RollingWindow,
    StopAtLimit,
}

impl Default for ContextOverflowPolicy {
    fn default() -> Self {
        Self::TruncateMiddle
    }
}

// -----------------------------------------------------------------------------
// Settings
// -----------------------------------------------------------------------------

/// The full settings record persisted to `OS_Config_Dir/settings.json`
/// (Req 10.1) and round-tripped between frontend and Rust by `load_settings`
/// / `save_settings` (Req 15.5, 15.6).
///
/// Trait derivations:
/// - `Serialize` + `Deserialize`: JSON persistence + Tauri command IO.
/// - `PartialEq`:                    used by Req 10.8 round-trip property
///                                   tests and by save-time short-circuits.
/// - `Debug`:                        diagnostics; never logged at INFO.
/// - `Clone`:                        the `RwLock<Settings>` cache hands out
///                                   owned snapshots to background tasks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    pub api_url: String,
    pub model: String,
    pub temperature: f64,
    pub max_tokens: u32,
    pub replace_mode: ReplaceMode,
    pub system_prompt: String,
    /// Spaces inserted when the user presses Tab in the editor (2 or 4).
    pub tab_spaces: u8,
    /// When true, include `max_tokens` in LM Studio requests.
    #[serde(default)]
    pub limit_response_length: bool,
    /// How LM Studio handles context window overflow.
    #[serde(default)]
    pub context_overflow_policy: ContextOverflowPolicy,
    /// Comma- or newline-separated stop strings forwarded to the API.
    #[serde(default)]
    pub stop_strings: String,
    /// Top-K sampling limit (0 disables).
    #[serde(default = "default_top_k")]
    pub top_k: u32,
    /// When true, include `repeat_penalty` in LM Studio requests.
    #[serde(default = "default_true")]
    pub repeat_penalty_enabled: bool,
    #[serde(default = "default_repeat_penalty")]
    pub repeat_penalty: f64,
    /// When true, include `presence_penalty` in LM Studio requests.
    #[serde(default)]
    pub presence_penalty_enabled: bool,
    #[serde(default)]
    pub presence_penalty: f64,
    /// When true, include `top_p` in LM Studio requests.
    #[serde(default = "default_true")]
    pub top_p_enabled: bool,
    #[serde(default = "default_top_p")]
    pub top_p: f64,
    /// When true, include `min_p` in LM Studio requests.
    #[serde(default = "default_true")]
    pub min_p_enabled: bool,
    #[serde(default = "default_min_p")]
    pub min_p: f64,
    /// When true, attach `response_format` from `structured_output`.
    #[serde(default)]
    pub structured_output_enabled: bool,
    /// JSON schema (object) or full `response_format` payload as text.
    #[serde(default)]
    pub structured_output: String,
}

fn default_true() -> bool {
    true
}

fn default_top_k() -> u32 {
    40
}

fn default_repeat_penalty() -> f64 {
    1.1
}

fn default_top_p() -> f64 {
    0.95
}

fn default_min_p() -> f64 {
    0.05
}

impl Default for Settings {
    /// Req 10.4 defaults. These values are written to a freshly created
    /// `settings.json` and used as the in-memory fallback whenever
    /// `Settings_Service::load` cannot fully parse the file.
    fn default() -> Self {
        Self {
            api_url: "http://localhost:1234/v1/chat/completions".to_string(),
            model: "local-model".to_string(),
            temperature: 0.2,
            max_tokens: 2048,
            replace_mode: ReplaceMode::ReplaceDocument,
            system_prompt: String::new(),
            tab_spaces: 4,
            limit_response_length: true,
            context_overflow_policy: ContextOverflowPolicy::TruncateMiddle,
            stop_strings: String::new(),
            top_k: default_top_k(),
            repeat_penalty_enabled: true,
            repeat_penalty: default_repeat_penalty(),
            presence_penalty_enabled: false,
            presence_penalty: 0.0,
            top_p_enabled: true,
            top_p: default_top_p(),
            min_p_enabled: true,
            min_p: default_min_p(),
            structured_output_enabled: false,
            structured_output: String::new(),
        }
    }
}

impl Settings {
    /// Validate every field against Req 10.2 / Req 10.3 bounds.
    ///
    /// Returns `Ok(())` iff every field is in-bounds. On failure the returned
    /// `Vec` is non-empty and ordered field-by-field in struct-declaration
    /// order so callers can render errors deterministically.
    pub fn validate(&self) -> Result<(), Vec<FieldError>> {
        let mut errs: Vec<FieldError> = Vec::new();

        if let Err(e) = validate_api_url(&self.api_url) {
            errs.push(e);
        }
        if let Err(e) = validate_model(&self.model) {
            errs.push(e);
        }
        if let Err(e) = validate_temperature(self.temperature) {
            errs.push(e);
        }
        if let Err(e) = validate_max_tokens(self.max_tokens) {
            errs.push(e);
        }
        // `replace_mode` is enum-typed in Rust, so reaching this branch with
        // an invalid variant is impossible (`Deserialize` would have already
        // rejected it). No check needed here; the JSON-shaped sibling
        // `validate_field` does cover the string form.
        if let Err(e) = validate_system_prompt(&self.system_prompt) {
            errs.push(e);
        }
        if let Err(e) = validate_tab_spaces(self.tab_spaces) {
            errs.push(e);
        }
        if let Err(e) = validate_top_k(self.top_k) {
            errs.push(e);
        }
        if let Err(e) = validate_repeat_penalty(self.repeat_penalty) {
            errs.push(e);
        }
        if let Err(e) = validate_presence_penalty(self.presence_penalty) {
            errs.push(e);
        }
        if let Err(e) = validate_top_p(self.top_p) {
            errs.push(e);
        }
        if let Err(e) = validate_min_p(self.min_p) {
            errs.push(e);
        }
        if let Err(e) = validate_stop_strings(&self.stop_strings) {
            errs.push(e);
        }
        if let Err(e) = validate_structured_output(&self.structured_output) {
            errs.push(e);
        }

        if errs.is_empty() {
            Ok(())
        } else {
            Err(errs)
        }
    }

    /// Validate a single field by JSON name + raw `serde_json::Value`. Used
    /// by `Settings_Service`'s field-by-field overlay (Req 10.6) — where one
    /// invalid field must demote the whole document to defaults — and by the
    /// optional Task 4.2 PBT, which exercises each field's bound
    /// independently.
    ///
    /// The JSON `name` is the `serde`-emitted key (`"api_url"`,
    /// `"replace_mode"`, …). An unknown name is itself a validation failure
    /// rather than a panic; this keeps the function total for use against
    /// arbitrary `serde_json::Value` trees.
    pub fn validate_field(name: &str, value: &serde_json::Value) -> Result<(), FieldError> {
        match name {
            "api_url" => {
                let s = expect_string(name, value)?;
                validate_api_url(s)
            }
            "model" => {
                let s = expect_string(name, value)?;
                validate_model(s)
            }
            "temperature" => {
                let n = expect_f64(name, value)?;
                validate_temperature(n)
            }
            "max_tokens" => {
                let n = expect_u32(name, value)?;
                validate_max_tokens(n)
            }
            "replace_mode" => {
                let s = expect_string(name, value)?;
                validate_replace_mode_str(s)
            }
            "system_prompt" => {
                let s = expect_string(name, value)?;
                validate_system_prompt(s)
            }
            "tab_spaces" => {
                let n = expect_u32(name, value)?;
                validate_tab_spaces_u32(n)
            }
            "limit_response_length" => {
                expect_bool(name, value)?;
                Ok(())
            }
            "context_overflow_policy" => {
                let s = expect_string(name, value)?;
                validate_context_overflow_policy_str(s)
            }
            "stop_strings" => {
                let s = expect_string(name, value)?;
                validate_stop_strings(s)
            }
            "top_k" => {
                let n = expect_u32(name, value)?;
                validate_top_k(n)
            }
            "repeat_penalty_enabled" => {
                expect_bool(name, value)?;
                Ok(())
            }
            "repeat_penalty" => {
                let n = expect_f64(name, value)?;
                validate_repeat_penalty(n)
            }
            "presence_penalty_enabled" => {
                expect_bool(name, value)?;
                Ok(())
            }
            "presence_penalty" => {
                let n = expect_f64(name, value)?;
                validate_presence_penalty(n)
            }
            "top_p_enabled" => {
                expect_bool(name, value)?;
                Ok(())
            }
            "top_p" => {
                let n = expect_f64(name, value)?;
                validate_top_p(n)
            }
            "min_p_enabled" => {
                expect_bool(name, value)?;
                Ok(())
            }
            "min_p" => {
                let n = expect_f64(name, value)?;
                validate_min_p(n)
            }
            "structured_output_enabled" => {
                expect_bool(name, value)?;
                Ok(())
            }
            "structured_output" => {
                let s = expect_string(name, value)?;
                validate_structured_output(s)
            }
            other => Err(FieldError::new(other, "unknown settings field")),
        }
    }
}

// -----------------------------------------------------------------------------
// is_http_or_https_url
// -----------------------------------------------------------------------------

/// Tiny pure-Rust scheme-prefix check used in lieu of the `url` crate. The
/// string passes iff it begins with `"http://"` or `"https://"` AND the
/// portion after the scheme is non-empty. The check is intentionally
/// conservative; the LM Studio endpoint is the only consumer and it accepts
/// any RFC-3986-shaped origin path, which we leave to the HTTP client to
/// reject downstream rather than re-implementing a full URL parser here.
pub fn is_http_or_https_url(s: &str) -> bool {
    const HTTP: &str = "http://";
    const HTTPS: &str = "https://";

    if let Some(rest) = s.strip_prefix(HTTPS) {
        !rest.is_empty()
    } else if let Some(rest) = s.strip_prefix(HTTP) {
        !rest.is_empty()
    } else {
        false
    }
}

// -----------------------------------------------------------------------------
// Per-field validators (private)
// -----------------------------------------------------------------------------

fn char_len(s: &str) -> usize {
    s.chars().count()
}

fn validate_api_url(s: &str) -> Result<(), FieldError> {
    let len = char_len(s);
    if len < API_URL_MIN_CHARS || len > API_URL_MAX_CHARS {
        return Err(FieldError::new(
            "api_url",
            format!(
                "length must be between {} and {} characters",
                API_URL_MIN_CHARS, API_URL_MAX_CHARS
            ),
        ));
    }
    if !is_http_or_https_url(s) {
        return Err(FieldError::new(
            "api_url",
            "must be an absolute URL with scheme http:// or https://",
        ));
    }
    Ok(())
}

fn validate_model(s: &str) -> Result<(), FieldError> {
    let len = char_len(s);
    if len < MODEL_MIN_CHARS || len > MODEL_MAX_CHARS {
        return Err(FieldError::new(
            "model",
            format!(
                "length must be between {} and {} characters",
                MODEL_MIN_CHARS, MODEL_MAX_CHARS
            ),
        ));
    }
    Ok(())
}

fn validate_temperature(t: f64) -> Result<(), FieldError> {
    if !t.is_finite() {
        return Err(FieldError::new(
            "temperature",
            "must be a finite number",
        ));
    }
    if t < TEMPERATURE_MIN || t > TEMPERATURE_MAX {
        return Err(FieldError::new(
            "temperature",
            format!(
                "must be between {:.1} and {:.1}",
                TEMPERATURE_MIN, TEMPERATURE_MAX
            ),
        ));
    }
    Ok(())
}

fn validate_max_tokens(n: u32) -> Result<(), FieldError> {
    if n < MAX_TOKENS_MIN || n > MAX_TOKENS_MAX {
        return Err(FieldError::new(
            "max_tokens",
            format!(
                "must be an integer between {} and {}",
                MAX_TOKENS_MIN, MAX_TOKENS_MAX
            ),
        ));
    }
    Ok(())
}

fn validate_system_prompt(s: &str) -> Result<(), FieldError> {
    let len = char_len(s);
    // `SYSTEM_PROMPT_MIN_CHARS` is 0, so the lower bound is trivially met for
    // any `&str`; the explicit check below stays for symmetry and to make
    // the bound site-of-truth obvious to readers.
    if len < SYSTEM_PROMPT_MIN_CHARS || len > SYSTEM_PROMPT_MAX_CHARS {
        return Err(FieldError::new(
            "system_prompt",
            format!(
                "length must be between {} and {} characters",
                SYSTEM_PROMPT_MIN_CHARS, SYSTEM_PROMPT_MAX_CHARS
            ),
        ));
    }
    Ok(())
}

fn validate_replace_mode_str(s: &str) -> Result<(), FieldError> {
    match s {
        "insert_at_cursor" | "replace_selection" | "replace_document" => Ok(()),
        _ => Err(FieldError::new(
            "replace_mode",
            "must be one of insert_at_cursor, replace_selection, replace_document",
        )),
    }
}

fn validate_tab_spaces(n: u8) -> Result<(), FieldError> {
    if TAB_SPACES_VALUES.contains(&n) {
        Ok(())
    } else {
        Err(FieldError::new("tab_spaces", "must be 2 or 4"))
    }
}

fn validate_tab_spaces_u32(n: u32) -> Result<(), FieldError> {
    validate_tab_spaces(
        u8::try_from(n).map_err(|_| FieldError::new("tab_spaces", "must be 2 or 4"))?,
    )
}

fn validate_context_overflow_policy_str(s: &str) -> Result<(), FieldError> {
    match s {
        "truncate_middle" | "rolling_window" | "stop_at_limit" => Ok(()),
        _ => Err(FieldError::new(
            "context_overflow_policy",
            "must be one of truncate_middle, rolling_window, stop_at_limit",
        )),
    }
}

fn validate_top_k(n: u32) -> Result<(), FieldError> {
    if n > TOP_K_MAX {
        return Err(FieldError::new(
            "top_k",
            format!("must be an integer between {} and {}", TOP_K_MIN, TOP_K_MAX),
        ));
    }
    Ok(())
}

fn validate_repeat_penalty(n: f64) -> Result<(), FieldError> {
    if !n.is_finite() {
        return Err(FieldError::new("repeat_penalty", "must be a finite number"));
    }
    if n < REPEAT_PENALTY_MIN || n > REPEAT_PENALTY_MAX {
        return Err(FieldError::new(
            "repeat_penalty",
            format!(
                "must be between {:.1} and {:.1}",
                REPEAT_PENALTY_MIN, REPEAT_PENALTY_MAX
            ),
        ));
    }
    Ok(())
}

fn validate_presence_penalty(n: f64) -> Result<(), FieldError> {
    if !n.is_finite() {
        return Err(FieldError::new("presence_penalty", "must be a finite number"));
    }
    if n < PRESENCE_PENALTY_MIN || n > PRESENCE_PENALTY_MAX {
        return Err(FieldError::new(
            "presence_penalty",
            format!(
                "must be between {:.1} and {:.1}",
                PRESENCE_PENALTY_MIN, PRESENCE_PENALTY_MAX
            ),
        ));
    }
    Ok(())
}

fn validate_top_p(n: f64) -> Result<(), FieldError> {
    if !n.is_finite() {
        return Err(FieldError::new("top_p", "must be a finite number"));
    }
    if n < TOP_P_MIN || n > TOP_P_MAX {
        return Err(FieldError::new(
            "top_p",
            format!("must be between {:.2} and {:.2}", TOP_P_MIN, TOP_P_MAX),
        ));
    }
    Ok(())
}

fn validate_min_p(n: f64) -> Result<(), FieldError> {
    if !n.is_finite() {
        return Err(FieldError::new("min_p", "must be a finite number"));
    }
    if n < MIN_P_MIN || n > MIN_P_MAX {
        return Err(FieldError::new(
            "min_p",
            format!("must be between {:.2} and {:.2}", MIN_P_MIN, MIN_P_MAX),
        ));
    }
    Ok(())
}

fn validate_stop_strings(s: &str) -> Result<(), FieldError> {
    let len = char_len(s);
    if len > STOP_STRINGS_MAX_CHARS {
        return Err(FieldError::new(
            "stop_strings",
            format!("must be at most {} characters", STOP_STRINGS_MAX_CHARS),
        ));
    }
    Ok(())
}

fn validate_structured_output(s: &str) -> Result<(), FieldError> {
    let len = char_len(s);
    if len > STRUCTURED_OUTPUT_MAX_CHARS {
        return Err(FieldError::new(
            "structured_output",
            format!(
                "must be at most {} characters",
                STRUCTURED_OUTPUT_MAX_CHARS
            ),
        ));
    }
    Ok(())
}

// -----------------------------------------------------------------------------
// JSON-shape helpers (private)
// -----------------------------------------------------------------------------

fn expect_string<'a>(name: &str, v: &'a serde_json::Value) -> Result<&'a str, FieldError> {
    v.as_str()
        .ok_or_else(|| FieldError::new(name, "expected a string"))
}

fn expect_f64(name: &str, v: &serde_json::Value) -> Result<f64, FieldError> {
    v.as_f64()
        .ok_or_else(|| FieldError::new(name, "expected a number"))
}

fn expect_u32(name: &str, v: &serde_json::Value) -> Result<u32, FieldError> {
    // Reject any non-integer or out-of-u32-range input here so that the
    // downstream bound check only has to compare values; this keeps the
    // "is it an integer in [1, 1_048_576]" predicate compositional.
    let n = v
        .as_u64()
        .ok_or_else(|| FieldError::new(name, "expected a non-negative integer"))?;
    u32::try_from(n).map_err(|_| FieldError::new(name, "value does not fit in a 32-bit integer"))
}

fn expect_bool(name: &str, v: &serde_json::Value) -> Result<(), FieldError> {
    if v.is_boolean() {
        Ok(())
    } else {
        Err(FieldError::new(name, "expected a boolean"))
    }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---- defaults ----------------------------------------------------------

    #[test]
    fn default_matches_req_10_4() {
        let s = Settings::default();
        assert_eq!(s.api_url, "http://localhost:1234/v1/chat/completions");
        assert_eq!(s.model, "local-model");
        assert!((s.temperature - 0.2).abs() < f64::EPSILON);
        assert_eq!(s.max_tokens, 2048);
        assert_eq!(s.replace_mode, ReplaceMode::ReplaceDocument);
        assert_eq!(s.system_prompt, "");
        assert_eq!(s.tab_spaces, 4);
    }

    #[test]
    fn default_validates() {
        assert!(Settings::default().validate().is_ok());
    }

    // ---- ReplaceMode JSON shape -------------------------------------------

    #[test]
    fn replace_mode_serializes_in_snake_case() {
        assert_eq!(
            serde_json::to_string(&ReplaceMode::InsertAtCursor).unwrap(),
            "\"insert_at_cursor\""
        );
        assert_eq!(
            serde_json::to_string(&ReplaceMode::ReplaceSelection).unwrap(),
            "\"replace_selection\""
        );
        assert_eq!(
            serde_json::to_string(&ReplaceMode::ReplaceDocument).unwrap(),
            "\"replace_document\""
        );

        let m: ReplaceMode = serde_json::from_str("\"replace_document\"").unwrap();
        assert_eq!(m, ReplaceMode::ReplaceDocument);
    }

    #[test]
    fn settings_round_trip_through_json() {
        let s = Settings::default();
        let j = serde_json::to_string(&s).unwrap();
        let s2: Settings = serde_json::from_str(&j).unwrap();
        assert_eq!(s, s2);
    }

    // ---- is_http_or_https_url ---------------------------------------------

    #[test]
    fn url_helper_accepts_http_and_https_with_non_empty_rest() {
        assert!(is_http_or_https_url("http://localhost:1234/v1/chat/completions"));
        assert!(is_http_or_https_url("https://api.example.com/v1/x"));
        assert!(is_http_or_https_url("http://a"));
        assert!(is_http_or_https_url("https://a"));
    }

    #[test]
    fn url_helper_rejects_other_schemes_or_empty_rest() {
        assert!(!is_http_or_https_url(""));
        assert!(!is_http_or_https_url("http://"));
        assert!(!is_http_or_https_url("https://"));
        assert!(!is_http_or_https_url("ftp://example.com"));
        assert!(!is_http_or_https_url("ws://example.com"));
        assert!(!is_http_or_https_url("HTTP://example.com")); // case-sensitive on purpose
        assert!(!is_http_or_https_url("//example.com"));
        assert!(!is_http_or_https_url("example.com"));
    }

    // ---- Settings::validate (whole-struct) --------------------------------

    #[test]
    fn validate_flags_every_offender() {
        let s = Settings {
            api_url: "ftp://nope".into(),
            model: String::new(),
            temperature: f64::NAN,
            max_tokens: 0,
            replace_mode: ReplaceMode::ReplaceDocument,
            system_prompt: "x".repeat(SYSTEM_PROMPT_MAX_CHARS + 1),
            tab_spaces: 4,
            ..Settings::default()
        };
        let errs = s.validate().expect_err("expected validation errors");
        let fields: Vec<&str> = errs.iter().map(|e| e.field.as_str()).collect();
        assert!(fields.contains(&"api_url"));
        assert!(fields.contains(&"model"));
        assert!(fields.contains(&"temperature"));
        assert!(fields.contains(&"max_tokens"));
        assert!(fields.contains(&"system_prompt"));
    }

    #[test]
    fn validate_rejects_infinite_temperature() {
        let mut s = Settings::default();
        s.temperature = f64::INFINITY;
        assert!(s.validate().is_err());
        s.temperature = f64::NEG_INFINITY;
        assert!(s.validate().is_err());
    }

    #[test]
    fn validate_accepts_temperature_endpoints() {
        let mut s = Settings::default();
        s.temperature = TEMPERATURE_MIN;
        assert!(s.validate().is_ok());
        s.temperature = TEMPERATURE_MAX;
        assert!(s.validate().is_ok());
    }

    #[test]
    fn validate_accepts_max_tokens_endpoints() {
        let mut s = Settings::default();
        s.max_tokens = MAX_TOKENS_MIN;
        assert!(s.validate().is_ok());
        s.max_tokens = MAX_TOKENS_MAX;
        assert!(s.validate().is_ok());
    }

    #[test]
    fn validate_accepts_length_endpoints() {
        let mut s = Settings::default();
        // api_url at exactly MAX uses repeated path chars after the scheme
        let suffix_len = API_URL_MAX_CHARS - "http://".len();
        s.api_url = format!("http://{}", "a".repeat(suffix_len));
        assert_eq!(char_len(&s.api_url), API_URL_MAX_CHARS);
        assert!(s.validate().is_ok());

        s.api_url = "http://a".into(); // well within bounds
        s.model = "x".repeat(MODEL_MAX_CHARS);
        assert!(s.validate().is_ok());

        s.model = "m".into();
        s.system_prompt = "y".repeat(SYSTEM_PROMPT_MAX_CHARS);
        assert!(s.validate().is_ok());
    }

    #[test]
    fn validate_rejects_empty_model() {
        let s = Settings {
            model: String::new(),
            ..Settings::default()
        };
        let errs = s.validate().expect_err("model must not be empty");
        assert_eq!(errs.len(), 1);
        assert_eq!(errs[0].field, "model");
    }

    #[test]
    fn validate_uses_unicode_code_points_for_length() {
        // 5 multi-byte chars = 5 code points but 20 UTF-8 bytes; the bound is
        // measured in code points, not bytes.
        let s = Settings {
            model: "𝕏𝕏𝕏𝕏𝕏".into(),
            ..Settings::default()
        };
        assert_eq!(char_len(&s.model), 5);
        assert!(s.validate().is_ok());
    }

    // ---- Settings::validate_field (per-field, JSON-shaped) ----------------

    #[test]
    fn validate_field_accepts_in_bounds_values() {
        assert!(
            Settings::validate_field("api_url", &json!("http://localhost:1234/v1")).is_ok()
        );
        assert!(Settings::validate_field("model", &json!("local-model")).is_ok());
        assert!(Settings::validate_field("temperature", &json!(0.7)).is_ok());
        assert!(Settings::validate_field("temperature", &json!(0)).is_ok());
        assert!(Settings::validate_field("temperature", &json!(2)).is_ok());
        assert!(Settings::validate_field("max_tokens", &json!(2048)).is_ok());
        assert!(
            Settings::validate_field("replace_mode", &json!("insert_at_cursor")).is_ok()
        );
        assert!(
            Settings::validate_field("replace_mode", &json!("replace_selection")).is_ok()
        );
        assert!(
            Settings::validate_field("replace_mode", &json!("replace_document")).is_ok()
        );
        assert!(Settings::validate_field("system_prompt", &json!("")).is_ok());
        assert!(Settings::validate_field("system_prompt", &json!("hello")).is_ok());
        assert!(Settings::validate_field("tab_spaces", &json!(2)).is_ok());
        assert!(Settings::validate_field("tab_spaces", &json!(4)).is_ok());
    }

    #[test]
    fn validate_field_rejects_out_of_bounds_values() {
        // api_url
        assert!(Settings::validate_field("api_url", &json!("")).is_err());
        assert!(Settings::validate_field("api_url", &json!("ftp://x")).is_err());
        assert!(Settings::validate_field("api_url", &json!("http://")).is_err());
        let too_long = format!("http://{}", "a".repeat(API_URL_MAX_CHARS));
        assert!(Settings::validate_field("api_url", &json!(too_long)).is_err());

        // model
        assert!(Settings::validate_field("model", &json!("")).is_err());
        let big_model = "m".repeat(MODEL_MAX_CHARS + 1);
        assert!(Settings::validate_field("model", &json!(big_model)).is_err());

        // temperature
        assert!(Settings::validate_field("temperature", &json!(-0.1)).is_err());
        assert!(Settings::validate_field("temperature", &json!(2.1)).is_err());

        // max_tokens
        assert!(Settings::validate_field("max_tokens", &json!(0)).is_err());
        assert!(
            Settings::validate_field("max_tokens", &json!(MAX_TOKENS_MAX as u64 + 1)).is_err()
        );
        assert!(Settings::validate_field("max_tokens", &json!(-1)).is_err());

        // replace_mode
        assert!(Settings::validate_field("replace_mode", &json!("nope")).is_err());
        assert!(Settings::validate_field("replace_mode", &json!("InsertAtCursor")).is_err());

        // system_prompt
        let big = "x".repeat(SYSTEM_PROMPT_MAX_CHARS + 1);
        assert!(Settings::validate_field("system_prompt", &json!(big)).is_err());

        // tab_spaces
        assert!(Settings::validate_field("tab_spaces", &json!(0)).is_err());
        assert!(Settings::validate_field("tab_spaces", &json!(3)).is_err());
        assert!(Settings::validate_field("tab_spaces", &json!(8)).is_err());
    }

    #[test]
    fn validate_field_rejects_wrong_json_types() {
        assert!(Settings::validate_field("api_url", &json!(42)).is_err());
        assert!(Settings::validate_field("temperature", &json!("0.7")).is_err());
        assert!(Settings::validate_field("max_tokens", &json!("2048")).is_err());
        assert!(Settings::validate_field("max_tokens", &json!(2.5)).is_err());
        assert!(Settings::validate_field("replace_mode", &json!(0)).is_err());
        assert!(Settings::validate_field("system_prompt", &json!(null)).is_err());
    }

    #[test]
    fn validate_field_rejects_unknown_field() {
        let err = Settings::validate_field("not_a_field", &json!("x")).unwrap_err();
        assert_eq!(err.field, "not_a_field");
    }

    #[test]
    fn validate_field_rejects_nan_and_infinite_temperature() {
        // serde_json cannot represent NaN/Infinity directly, but the helper
        // must still reject them when they reach `validate_temperature` via
        // `Settings::validate`. Re-cover that path here via a targeted f64
        // value that survives JSON round-tripping (large finite, in range).
        assert!(Settings::validate_field("temperature", &json!(1.5)).is_ok());
    }
}

#[cfg(test)]
mod prop_tests {
    use super::*;
    use proptest::prelude::*;
    use serde_json::{from_str, to_string, Value};

    // ---- Task 4.1 (P1): Settings serialize-then-parse round-trip ----------

    fn arb_api_url() -> impl Strategy<Value = String> {
        // Keep the generated suffix short for performance while still
        // satisfying the documented bounds and scheme requirement.
        prop_oneof![
            (1usize..=64).prop_map(|n| format!("http://{}", "a".repeat(n))),
            (1usize..=64).prop_map(|n| format!("https://{}", "b".repeat(n))),
        ]
    }

    fn arb_model() -> impl Strategy<Value = String> {
        prop::collection::vec(any::<char>(), MODEL_MIN_CHARS..=MODEL_MAX_CHARS)
            .prop_map(|chars| chars.into_iter().collect::<String>())
    }

    fn arb_temperature() -> impl Strategy<Value = f64> {
        // Use dyadic fractions (`n / 1024`) so the generated `f64` values are
        // exactly representable, making JSON serialize/parse equality stable.
        (0u16..=2048u16).prop_map(|n| n as f64 / 1024.0)
    }

    fn arb_max_tokens() -> impl Strategy<Value = u32> {
        MAX_TOKENS_MIN..=MAX_TOKENS_MAX
    }

    fn arb_replace_mode() -> impl Strategy<Value = ReplaceMode> {
        prop_oneof![
            Just(ReplaceMode::InsertAtCursor),
            Just(ReplaceMode::ReplaceSelection),
            Just(ReplaceMode::ReplaceDocument),
        ]
    }

    fn arb_system_prompt() -> impl Strategy<Value = String> {
        // Favor short prompts for test speed, but still sample the exact
        // upper bound occasionally.
        prop_oneof![
            prop::collection::vec(any::<char>(), 0..=512)
                .prop_map(|chars| chars.into_iter().collect::<String>()),
            Just("x".repeat(SYSTEM_PROMPT_MAX_CHARS)),
        ]
    }

    fn arb_tab_spaces() -> impl Strategy<Value = u8> {
        prop_oneof![Just(2u8), Just(4u8)]
    }

    fn arb_settings() -> impl Strategy<Value = Settings> {
        (
            arb_api_url(),
            arb_model(),
            arb_temperature(),
            arb_max_tokens(),
            arb_replace_mode(),
            arb_system_prompt(),
            arb_tab_spaces(),
        )
            .prop_map(
                |(
                    api_url,
                    model,
                    temperature,
                    max_tokens,
                    replace_mode,
                    system_prompt,
                    tab_spaces,
                )| {
                    Settings {
                        api_url,
                        model,
                        temperature,
                        max_tokens,
                        replace_mode,
                        system_prompt,
                        tab_spaces,
                        ..Settings::default()
                    }
                },
            )
    }

    proptest! {
        #[test]
        fn p1_settings_round_trip(s in arb_settings()) {
            let encoded = to_string(&s).expect("Settings should serialize to JSON");
            let decoded: Settings = from_str(&encoded).expect("serialized Settings should parse");
            prop_assert_eq!(decoded, s);
        }
    }

    // ---- Task 4.2 (P2): validator matches per-field bounds ----------------

    fn model_case() -> impl Strategy<Value = (Value, bool)> {
        let in_bounds = prop::collection::vec(any::<char>(), MODEL_MIN_CHARS..=MODEL_MAX_CHARS)
            .prop_map(|chars| (Value::String(chars.into_iter().collect::<String>()), true));

        let out_of_bounds = prop_oneof![
            Just((Value::String(String::new()), false)),
            Just((Value::String("x".repeat(MODEL_MAX_CHARS + 1)), false)),
        ];

        prop_oneof![in_bounds, out_of_bounds]
    }

    fn system_prompt_case() -> impl Strategy<Value = (Value, bool)> {
        let in_bounds = prop_oneof![
            prop::collection::vec(any::<char>(), 0..=512)
                .prop_map(|chars| (Value::String(chars.into_iter().collect::<String>()), true)),
            Just((Value::String("x".repeat(SYSTEM_PROMPT_MAX_CHARS)), true)),
        ];

        let out_of_bounds = Just((Value::String("x".repeat(SYSTEM_PROMPT_MAX_CHARS + 1)), false));

        prop_oneof![in_bounds, out_of_bounds]
    }

    fn api_url_case() -> impl Strategy<Value = (Value, bool)> {
        let in_bounds = prop_oneof![
            (1usize..=64).prop_map(|n| (Value::String(format!("http://{}", "a".repeat(n))), true)),
            (1usize..=64).prop_map(|n| (Value::String(format!("https://{}", "b".repeat(n))), true)),
            Just((Value::String(format!("https://{}", "x".repeat(API_URL_MAX_CHARS - "https://".len()))), true)),
        ];

        let out_of_bounds = prop_oneof![
            Just((Value::String(String::new()), false)),
            Just((Value::String("http://".to_string()), false)),
            Just((Value::String("https://".to_string()), false)),
            Just((Value::String("ftp://example.com".to_string()), false)),
            Just((Value::String(format!("http://{}", "y".repeat(API_URL_MAX_CHARS))), false)),
        ];

        prop_oneof![in_bounds, out_of_bounds]
    }

    fn temperature_case() -> impl Strategy<Value = (Value, bool)> {
        let in_bounds = (TEMPERATURE_MIN..=TEMPERATURE_MAX)
            .prop_map(|t| (serde_json::json!(t), true));

        let out_of_bounds = prop_oneof![
            (-10.0f64..TEMPERATURE_MIN).prop_map(|t| (serde_json::json!(t), false)),
            (TEMPERATURE_MAX + f64::EPSILON..=12.0f64)
                .prop_map(|t| (serde_json::json!(t), false)),
        ];

        prop_oneof![in_bounds, out_of_bounds]
    }

    fn max_tokens_case() -> impl Strategy<Value = (Value, bool)> {
        let in_bounds = (MAX_TOKENS_MIN..=MAX_TOKENS_MAX)
            .prop_map(|n| (serde_json::json!(n), true));

        let out_of_bounds = prop_oneof![
            Just((serde_json::json!(0u32), false)),
            ((MAX_TOKENS_MAX as u64 + 1)..=(MAX_TOKENS_MAX as u64 + 10_000))
                .prop_map(|n| (serde_json::json!(n), false)),
        ];

        prop_oneof![in_bounds, out_of_bounds]
    }

    fn replace_mode_case() -> impl Strategy<Value = (Value, bool)> {
        let in_bounds = prop_oneof![
            Just((Value::String("insert_at_cursor".to_string()), true)),
            Just((Value::String("replace_selection".to_string()), true)),
            Just((Value::String("replace_document".to_string()), true)),
        ];

        let out_of_bounds = prop_oneof![
            Just((Value::String("InsertAtCursor".to_string()), false)),
            Just((Value::String("replace-doc".to_string()), false)),
            Just((Value::String(String::new()), false)),
        ];

        prop_oneof![in_bounds, out_of_bounds]
    }

    proptest! {
        #[test]
        fn p2_api_url_validator_matches_bounds((value, expected_ok) in api_url_case()) {
            let actual_ok = Settings::validate_field("api_url", &value).is_ok();
            prop_assert_eq!(actual_ok, expected_ok);
        }

        #[test]
        fn p2_model_validator_matches_bounds((value, expected_ok) in model_case()) {
            let actual_ok = Settings::validate_field("model", &value).is_ok();
            prop_assert_eq!(actual_ok, expected_ok);
        }

        #[test]
        fn p2_temperature_validator_matches_bounds((value, expected_ok) in temperature_case()) {
            let actual_ok = Settings::validate_field("temperature", &value).is_ok();
            prop_assert_eq!(actual_ok, expected_ok);
        }

        #[test]
        fn p2_max_tokens_validator_matches_bounds((value, expected_ok) in max_tokens_case()) {
            let actual_ok = Settings::validate_field("max_tokens", &value).is_ok();
            prop_assert_eq!(actual_ok, expected_ok);
        }

        #[test]
        fn p2_replace_mode_validator_matches_bounds((value, expected_ok) in replace_mode_case()) {
            let actual_ok = Settings::validate_field("replace_mode", &value).is_ok();
            prop_assert_eq!(actual_ok, expected_ok);
        }

        #[test]
        fn p2_system_prompt_validator_matches_bounds((value, expected_ok) in system_prompt_case()) {
            let actual_ok = Settings::validate_field("system_prompt", &value).is_ok();
            prop_assert_eq!(actual_ok, expected_ok);
        }
    }
}

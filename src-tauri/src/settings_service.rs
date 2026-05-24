// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — settings_service.rs
//
// Settings_Service: persist `Settings` as a single `settings.json` file
// inside the OS-standard per-user config directory and load it back on
// launch (Req 10.1, 10.4–10.7).
//
// Public surface (per design.md "settings_service.rs"):
//
//   pub fn config_dir() -> Result<PathBuf, SettingsError>;
//   pub fn settings_path() -> Result<PathBuf, SettingsError>;
//   pub fn load() -> LoadOutcome;
//   pub fn save(s: &Settings) -> Result<(), SettingsError>;
//
//   pub enum LoadOutcome {
//       Ok(Settings),
//       DefaultsCreated(Settings),
//       DefaultsFromError(Settings, String),
//   }
//
// `load` implements the four-step branch from the design:
//   1. Resolve `settings_path()`. If the parent directory is absent, create
//      it recursively. Filesystem failure → `DefaultsFromError(default,
//      reason)`. (Req 10.4, 10.7)
//   2. If the file does not exist, write `Settings::default()` to it via the
//      atomic temp+fsync+rename pipeline → `DefaultsCreated`. Write failure
//      → `DefaultsFromError`. (Req 10.4, 10.7)
//   3. Read file → parse as `serde_json::Value`. Failure →
//      `DefaultsFromError(default, "settings parse failed: ...")`. The
//      on-disk file is *not* rewritten. (Req 10.5)
//   4. Field-by-field overlay onto `Settings::default()`: for each known
//      field, if present in the JSON object and validates via
//      `Settings::validate_field`, take it; if absent, keep the default
//      (Req 10.6); if present and invalid, the whole document is invalid →
//      `DefaultsFromError`. (Req 10.5, 10.6)
//   5. Return `Ok(merged)`.
//
// `save` writes via the same atomic temp+fsync+rename pattern as
// `file_service::write_file`: write to `<path>.tmp.<pid>.<rand>`, fsync,
// rename. Any IO error triggers a best-effort delete of the temp file before
// returning `SettingsError::IoWrite`. (Req 10.7, 11.9)
//
// Internally the heavy lifting lives in `load_from(dir)` and `save_to(dir,
// s)` so unit tests can drive the pipeline against a `tempfile::tempdir()`
// without touching the real OS config directory.
//
// References:
// - Requirements:
//     10.1 — settings.json in OS_Config_Dir
//     10.4 — defaults written when file is absent
//     10.5 — parse / validation failure -> defaults in memory; file untouched
//     10.6 — absent fields filled from defaults
//     10.7 — IO failure -> defaults in memory + reason for Status_Bar
//     11.9 — Save failure -> "settings could not be saved: ..." surface
// - design.md "Settings_Service" pins the LoadOutcome shape and pipeline.
// - design.md "Backend error catalog" pins the error Display strings (the
//   `SettingsError::*` variants in `error.rs` already implement them).

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::SettingsError;
use crate::settings::Settings;

// -----------------------------------------------------------------------------
// LoadOutcome
// -----------------------------------------------------------------------------

/// Result of `Settings_Service::load`.
///
/// Three arms cover the design's load-time branches without losing
/// information:
///
/// - `Ok(s)`: the on-disk file existed, parsed cleanly, and every present
///   field validated. Any absent fields were filled from
///   `Settings::default()` per Req 10.6.
/// - `DefaultsCreated(s)`: the file did not exist; the service created it
///   populated with `Settings::default()` (Req 10.4). The returned `s` is
///   the defaults.
/// - `DefaultsFromError(s, reason)`: a parse, validation, or filesystem
///   failure occurred. The service falls back to `Settings::default()` in
///   memory (Req 10.5, 10.7); the `reason` is the user-facing message that
///   the Status_Bar will render verbatim. The on-disk file is left
///   untouched in the parse / validation cases (Req 10.5).
#[derive(Debug, Clone, PartialEq)]
pub enum LoadOutcome {
    Ok(Settings),
    DefaultsCreated(Settings),
    DefaultsFromError(Settings, String),
}

// -----------------------------------------------------------------------------
// Public path helpers
// -----------------------------------------------------------------------------

/// Resolve the OS-standard per-user config directory and append the
/// application sub-directory (`LLIMEdit`).
///
/// On macOS this resolves to `~/Library/Application Support/LLIMEdit`; on
/// Windows, `%APPDATA%\LLIMEdit`. The function does *not* create the
/// directory; that is the responsibility of `load_from` (Req 10.4).
///
/// `dirs::config_dir()` returns `None` only when the OS cannot expose a
/// config directory at all (e.g. a stripped-down test image). Per the task
/// guidance we surface that as a `SettingsError::DirCreate` carrying a
/// `NotFound` IO error so the caller's status-bar message is still
/// well-formed.
pub fn config_dir() -> Result<PathBuf, SettingsError> {
    match dirs::config_dir() {
        Some(d) => Ok(d.join("LLIMEdit")),
        None => Err(SettingsError::DirCreate(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no OS config dir",
        ))),
    }
}

/// `config_dir().join("settings.json")` (Req 10.1).
pub fn settings_path() -> Result<PathBuf, SettingsError> {
    Ok(config_dir()?.join(SETTINGS_FILE_NAME))
}

/// Bare file name of the settings JSON, factored out so `load_from` /
/// `save_to` can re-use it without duplicating the literal.
const SETTINGS_FILE_NAME: &str = "settings.json";

// -----------------------------------------------------------------------------
// Public load / save
// -----------------------------------------------------------------------------

/// Load settings from `settings_path()`.
///
/// Never panics. The returned `LoadOutcome` always carries a usable
/// `Settings` value; `Settings::default()` is the in-memory fallback for
/// every failure mode.
pub fn load() -> LoadOutcome {
    match config_dir() {
        Ok(dir) => load_from(&dir),
        Err(e) => LoadOutcome::DefaultsFromError(Settings::default(), e.to_string()),
    }
}

/// Persist settings to `settings_path()` via atomic write.
pub fn save(s: &Settings) -> Result<(), SettingsError> {
    let dir = config_dir()?;
    save_to(&dir, s)
}

// -----------------------------------------------------------------------------
// Testable cores: load_from / save_to
// -----------------------------------------------------------------------------

/// Load settings from `dir/settings.json`.
///
/// This is the testable core of `load`; tests pass a `tempfile::tempdir()`
/// path so they never touch the real OS config directory. `load` itself is
/// the trivial wrapper that resolves `config_dir()` and forwards.
pub fn load_from(dir: &Path) -> LoadOutcome {
    let default = Settings::default();

    // Step 1: ensure the directory exists. `create_dir_all` is a no-op when
    // the directory is already present, so we don't gate on existence first
    // (avoids a TOCTOU race against parallel writers).
    if let Err(e) = std::fs::create_dir_all(dir) {
        return LoadOutcome::DefaultsFromError(
            default,
            SettingsError::DirCreate(e).to_string(),
        );
    }

    let path = dir.join(SETTINGS_FILE_NAME);

    // Step 2: bootstrap the file with defaults if it is absent.
    if !path.exists() {
        match save_to(dir, &default) {
            Ok(()) => return LoadOutcome::DefaultsCreated(default),
            Err(e) => return LoadOutcome::DefaultsFromError(default, e.to_string()),
        }
    }

    // Step 3: read and parse. Failure to read is a filesystem error
    // (Req 10.7); failure to parse is a "settings parse failed" surface
    // (Req 10.5). In neither case do we rewrite the file.
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            return LoadOutcome::DefaultsFromError(
                default,
                SettingsError::IoRead(e).to_string(),
            );
        }
    };

    let value: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => {
            return LoadOutcome::DefaultsFromError(
                default,
                SettingsError::Parse(format!("settings parse failed: {e}")).to_string(),
            );
        }
    };

    // Step 4: field-by-field overlay. The top-level value must be an object
    // for the overlay to make sense; anything else is treated as a parse
    // failure surface (Req 10.5).
    let obj = match value.as_object() {
        Some(o) => o,
        None => {
            return LoadOutcome::DefaultsFromError(
                Settings::default(),
                SettingsError::Parse(
                    "settings parse failed: expected a JSON object at top level".into(),
                )
                .to_string(),
            );
        }
    };

    match overlay_onto_default(obj) {
        Ok(merged) => LoadOutcome::Ok(merged),
        Err(reason) => LoadOutcome::DefaultsFromError(
            Settings::default(),
            SettingsError::Validation(reason).to_string(),
        ),
    }
}

/// Persist `s` to `dir/settings.json` via atomic temp+fsync+rename.
///
/// Errors at any step trigger a best-effort delete of the temp file before
/// returning `SettingsError::IoWrite`, mirroring `file_service::write_file`.
pub fn save_to(dir: &Path, s: &Settings) -> Result<(), SettingsError> {
    // Ensure the destination directory exists before constructing the temp
    // path; `create_dir_all` is a no-op if the directory is already present.
    if let Err(e) = std::fs::create_dir_all(dir) {
        return Err(SettingsError::DirCreate(e));
    }

    let path = dir.join(SETTINGS_FILE_NAME);
    let temp = temp_path_for(&path).ok_or_else(|| {
        SettingsError::IoWrite(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "destination path has no file name",
        ))
    })?;

    // Pretty-printing keeps the on-disk file human-editable; the round-trip
    // property test in Task 4.1 only requires structural equality, so the
    // exact whitespace is irrelevant to correctness.
    let bytes = match serde_json::to_vec_pretty(s) {
        Ok(b) => b,
        Err(e) => {
            return Err(SettingsError::IoWrite(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                e,
            )));
        }
    };

    let write_result: std::io::Result<()> = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(&bytes)?;
        file.flush()?;
        file.sync_data()?;
        // Drop the handle before the rename. Some platforms (notably
        // Windows) require the source handle to be closed before a rename
        // can succeed.
        drop(file);
        std::fs::rename(&temp, &path)?;
        Ok(())
    })();

    if let Err(e) = write_result {
        // Best-effort cleanup; if the rename succeeded the temp file is
        // already gone and the remove is a no-op.
        let _ = std::fs::remove_file(&temp);
        return Err(SettingsError::IoWrite(e));
    }

    Ok(())
}

// -----------------------------------------------------------------------------
// Field-by-field overlay (Req 10.6)
// -----------------------------------------------------------------------------

/// Names of the fields recognised in `settings.json`. Listed in struct
/// declaration order so the overlay surfaces validation errors in a
/// deterministic order (matching `Settings::validate`).
const FIELDS: &[&str] = &[
    "api_url",
    "model",
    "temperature",
    "max_tokens",
    "replace_mode",
    "system_prompt",
];

/// Take each known field from `obj` if present and valid; fall back to
/// `Settings::default()` otherwise. Returns the first validation failure as
/// a string suitable for `SettingsError::Validation` (Req 10.5, 10.6).
///
/// This routes every present field through `Settings::validate_field`, which
/// already enforces every Req 10.2 / 10.3 bound. Any invalid field demotes
/// the entire document to defaults; per Req 10.5 the *whole* settings set
/// must fall back, not just the offending field.
fn overlay_onto_default(
    obj: &serde_json::Map<String, serde_json::Value>,
) -> Result<Settings, String> {
    // Validate any present known field up-front. We do this against the raw
    // JSON values rather than the struct deserialization so a single bad
    // field surfaces a precise per-field reason instead of a generic
    // "missing field" / "invalid type" serde error.
    for &name in FIELDS {
        if let Some(v) = obj.get(name) {
            if let Err(e) = Settings::validate_field(name, v) {
                return Err(format!("{}: {}", e.field, e.reason));
            }
        }
    }

    // Build a complete JSON object by overlaying any present fields onto
    // `Settings::default()`. Then deserialize that complete object into
    // `Settings`. Because every present field has already been validated
    // and every absent field is supplied by the default, deserialization is
    // guaranteed to succeed for any input that survived the loop above.
    let default_value =
        serde_json::to_value(Settings::default()).expect("Settings::default serializes");
    let mut merged = default_value
        .as_object()
        .expect("Settings serializes as an object")
        .clone();
    for &name in FIELDS {
        if let Some(v) = obj.get(name) {
            merged.insert(name.to_string(), v.clone());
        }
    }

    serde_json::from_value::<Settings>(serde_json::Value::Object(merged))
        .map_err(|e| format!("settings deserialize failed: {e}"))
}

// -----------------------------------------------------------------------------
// Temp-path helper (private)
// -----------------------------------------------------------------------------

/// Build a sibling temp-file path for `dest`.
///
/// Mirrors `file_service::temp_path_for`: the temp file lives in the same
/// directory as `dest` so the final `std::fs::rename` is intra-filesystem
/// (the only shape POSIX guarantees as atomic). Name combines the original
/// file name, the current pid, and a sub-second nanosecond suffix so
/// concurrent writers — even within the same process — pick disjoint names
/// without depending on a random number generator crate.
fn temp_path_for(dest: &Path) -> Option<PathBuf> {
    let parent = dest.parent()?;
    let file_name = dest.file_name()?.to_string_lossy().into_owned();
    let pid = std::process::id();
    let rand = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    Some(parent.join(format!("{file_name}.tmp.{pid}.{rand}")))
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::ReplaceMode;
    use serde_json::json;
    use std::fs;
    use tempfile::TempDir;

    /// Names of every entry in `dir`. Used to assert that successful saves
    /// leave no `*.tmp.*` siblings behind.
    fn entry_names(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .expect("read_dir")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .collect()
    }

    fn fresh_dir() -> TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    // -- Req 10.4: file absent → DefaultsCreated ----------------------------

    #[test]
    fn load_creates_defaults_file_when_absent() {
        let dir = fresh_dir();
        let outcome = load_from(dir.path());
        match outcome {
            LoadOutcome::DefaultsCreated(s) => {
                assert_eq!(s, Settings::default());
            }
            other => panic!("expected DefaultsCreated, got {other:?}"),
        }
        // The on-disk file must now exist and parse back to the defaults.
        let path = dir.path().join("settings.json");
        assert!(path.exists(), "settings.json should have been created");
        let bytes = fs::read(&path).expect("read");
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).expect("on-disk JSON parses");
        let parsed: Settings =
            serde_json::from_value(value).expect("on-disk JSON deserializes to Settings");
        assert_eq!(parsed, Settings::default());
    }

    // -- Req 10.6: absent-field overlay → Ok with defaults filled -----------

    #[test]
    fn load_overlays_absent_fields_with_defaults() {
        let dir = fresh_dir();
        // Write a partial settings file: only `model` and `temperature` are
        // present (and valid). Every other field must come from defaults.
        let partial = json!({
            "model": "custom-model",
            "temperature": 0.9,
        });
        fs::write(
            dir.path().join("settings.json"),
            serde_json::to_vec(&partial).unwrap(),
        )
        .expect("seed file");

        let outcome = load_from(dir.path());
        match outcome {
            LoadOutcome::Ok(s) => {
                assert_eq!(s.model, "custom-model");
                assert!((s.temperature - 0.9).abs() < f64::EPSILON);
                // Absent fields filled from defaults.
                assert_eq!(s.api_url, Settings::default().api_url);
                assert_eq!(s.max_tokens, Settings::default().max_tokens);
                assert_eq!(s.replace_mode, Settings::default().replace_mode);
                assert_eq!(s.system_prompt, Settings::default().system_prompt);
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    // -- Valid file → Ok with parsed values ---------------------------------

    #[test]
    fn load_returns_ok_for_valid_full_file() {
        let dir = fresh_dir();
        let s = Settings {
            api_url: "https://api.example.com/v1/chat/completions".into(),
            model: "gpt-fake".into(),
            temperature: 1.5,
            max_tokens: 4096,
            replace_mode: ReplaceMode::InsertAtCursor,
            system_prompt: "You are a helpful editor.".into(),
        };
        fs::write(
            dir.path().join("settings.json"),
            serde_json::to_vec(&s).unwrap(),
        )
        .expect("seed");

        match load_from(dir.path()) {
            LoadOutcome::Ok(loaded) => assert_eq!(loaded, s),
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    // -- Req 10.5: corrupt JSON → DefaultsFromError, file unchanged ---------

    #[test]
    fn load_returns_defaults_from_error_for_corrupt_json() {
        let dir = fresh_dir();
        let path = dir.path().join("settings.json");
        let on_disk = b"{this is not valid json";
        fs::write(&path, on_disk).expect("seed");

        let outcome = load_from(dir.path());
        match outcome {
            LoadOutcome::DefaultsFromError(s, reason) => {
                assert_eq!(s, Settings::default());
                assert!(
                    reason.starts_with("settings could not be loaded; using defaults: "),
                    "reason should use the load-side prefix; got {reason:?}"
                );
                assert!(
                    reason.contains("settings parse failed"),
                    "reason should mention parse failure; got {reason:?}"
                );
            }
            other => panic!("expected DefaultsFromError, got {other:?}"),
        }
        // Req 10.5: the on-disk file must be byte-for-byte unchanged.
        let after = fs::read(&path).expect("read");
        assert_eq!(after, on_disk);
    }

    // -- Req 10.5: out-of-bounds value → DefaultsFromError, file unchanged --

    #[test]
    fn load_returns_defaults_from_error_for_out_of_bounds_value() {
        let dir = fresh_dir();
        let path = dir.path().join("settings.json");
        // temperature out of [0.0, 2.0]
        let bad = json!({
            "api_url": "http://localhost:1234/v1/chat/completions",
            "model": "local-model",
            "temperature": 5.0,
            "max_tokens": 2048,
            "replace_mode": "replace_document",
            "system_prompt": ""
        });
        let on_disk = serde_json::to_vec(&bad).unwrap();
        fs::write(&path, &on_disk).expect("seed");

        let outcome = load_from(dir.path());
        match outcome {
            LoadOutcome::DefaultsFromError(s, reason) => {
                assert_eq!(s, Settings::default());
                assert!(reason.starts_with("settings could not be loaded; using defaults: "));
                assert!(
                    reason.contains("temperature"),
                    "reason should mention the offending field; got {reason:?}"
                );
            }
            other => panic!("expected DefaultsFromError, got {other:?}"),
        }
        // File untouched.
        let after = fs::read(&path).expect("read");
        assert_eq!(after, on_disk);
    }

    #[test]
    fn load_returns_defaults_from_error_when_top_level_is_not_object() {
        let dir = fresh_dir();
        let path = dir.path().join("settings.json");
        // Valid JSON but not the object shape Settings expects.
        let on_disk = b"[1, 2, 3]";
        fs::write(&path, on_disk).expect("seed");

        match load_from(dir.path()) {
            LoadOutcome::DefaultsFromError(s, reason) => {
                assert_eq!(s, Settings::default());
                assert!(reason.contains("expected a JSON object"));
            }
            other => panic!("expected DefaultsFromError, got {other:?}"),
        }
        let after = fs::read(&path).expect("read");
        assert_eq!(after, on_disk);
    }

    #[test]
    fn load_returns_defaults_from_error_for_invalid_replace_mode() {
        let dir = fresh_dir();
        let path = dir.path().join("settings.json");
        let bad = json!({ "replace_mode": "Insert" });
        let on_disk = serde_json::to_vec(&bad).unwrap();
        fs::write(&path, &on_disk).expect("seed");

        match load_from(dir.path()) {
            LoadOutcome::DefaultsFromError(s, reason) => {
                assert_eq!(s, Settings::default());
                assert!(reason.contains("replace_mode"));
            }
            other => panic!("expected DefaultsFromError, got {other:?}"),
        }
        let after = fs::read(&path).expect("read");
        assert_eq!(after, on_disk);
    }

    // -- Save: happy path round-trips ---------------------------------------

    #[test]
    fn save_writes_json_that_round_trips() {
        let dir = fresh_dir();
        let s = Settings {
            api_url: "http://localhost:9999/v1/chat/completions".into(),
            model: "round-trip-model".into(),
            temperature: 0.42,
            max_tokens: 1234,
            replace_mode: ReplaceMode::ReplaceSelection,
            system_prompt: "be terse".into(),
        };
        save_to(dir.path(), &s).expect("save");

        // Loading the saved file must yield the exact same Settings.
        match load_from(dir.path()) {
            LoadOutcome::Ok(loaded) => assert_eq!(loaded, s),
            other => panic!("expected Ok after save, got {other:?}"),
        }
    }

    // -- Save: no `.tmp.*` siblings remain ----------------------------------

    #[test]
    fn save_leaves_no_tmp_siblings() {
        let dir = fresh_dir();
        save_to(dir.path(), &Settings::default()).expect("save");
        let names = entry_names(dir.path());
        assert_eq!(
            names,
            vec!["settings.json".to_string()],
            "directory should contain only the destination file"
        );
        assert!(!names.iter().any(|n| n.contains(".tmp.")));
    }

    #[test]
    fn save_overwrites_existing_file() {
        let dir = fresh_dir();
        save_to(dir.path(), &Settings::default()).expect("seed");

        let mut updated = Settings::default();
        updated.model = "overwritten".into();
        save_to(dir.path(), &updated).expect("overwrite");

        let bytes = fs::read(dir.path().join("settings.json")).expect("read");
        let loaded: Settings = serde_json::from_slice(&bytes).expect("parse");
        assert_eq!(loaded.model, "overwritten");
    }

    // -- Path helpers --------------------------------------------------------

    #[test]
    fn settings_path_appends_settings_json() {
        // The real `settings_path` is OS-dependent; the assertion we can make
        // portably is that it ends with the expected file name.
        let p = settings_path().expect("settings_path");
        assert_eq!(
            p.file_name().and_then(|s| s.to_str()),
            Some("settings.json")
        );
    }

    #[test]
    fn config_dir_appends_app_subdir() {
        let p = config_dir().expect("config_dir");
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some("LLIMEdit"));
    }
}

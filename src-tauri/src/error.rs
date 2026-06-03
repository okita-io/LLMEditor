// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — error.rs
//
// One error enum per backend layer, with hand-written `Display` impls that
// reproduce the exact strings in the design's "Backend error catalog". Each
// type converts directly into the `String` returned by the public Tauri
// commands via `impl From<X> for String`, so a `Result<T, FileError>` from a
// service can be `?`-propagated through a `Result<T, String>` command after a
// trivial `.map_err(Into::into)`.
//
// References:
// - design.md "Backend error catalog" pins each Display message.
// - Requirements:
//     14.1 / 14.2 / 14.3 / 14.4 / 14.5 — LlmError variants
//     15.1 / 15.2                      — FileError IO surfaces
//     15.7                             — FileError::Path* (validate_path)
//     10.5 / 10.7 / 11.9               — SettingsError load and save
//
// `thiserror` is intentionally not added; the task explicitly allows
// hand-written impls and we keep the dependency footprint small.

use std::fmt;
use std::io;

// -----------------------------------------------------------------------------
// FileError
// -----------------------------------------------------------------------------

/// Errors produced by `validate_path` and the `File_Service` read/write
/// pipelines.
///
/// The path-validation variants live here (rather than on a separate
/// `PathError`) because every caller of `validate_path` is a `File_Service`
/// command boundary (`open_file`, `save_file`); collapsing them keeps the
/// `Result` shape consistent for those commands.
#[derive(Debug)]
pub enum FileError {
    /// `validate_path` rejected an empty path argument. Req 15.7.
    PathEmpty,
    /// `validate_path` rejected a non-absolute path. Req 15.7.
    PathNotAbsolute,
    /// `validate_path` rejected a path containing an interior NUL byte. Req 15.7.
    PathNullByte,
    /// File contents are not valid UTF-8 after BOM stripping. Req 4.8, 15.1.
    Encoding,
    /// `std::fs::read` (or its surrounding open) failed. Req 4.9, 15.1.
    IoRead(io::Error),
    /// Atomic-write pipeline failed (temp write, fsync, or rename).
    /// Req 5.5, 6.6, 15.2.
    IoWrite(io::Error),
}

impl fmt::Display for FileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FileError::PathEmpty => f.write_str("path is empty"),
            FileError::PathNotAbsolute => f.write_str("path is not absolute"),
            FileError::PathNullByte => f.write_str("path contains null byte"),
            FileError::Encoding => f.write_str("file is not valid UTF-8"),
            FileError::IoRead(e) => write!(f, "could not read file: {e}"),
            FileError::IoWrite(e) => write!(f, "could not save file: {e}"),
        }
    }
}

impl std::error::Error for FileError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            FileError::IoRead(e) | FileError::IoWrite(e) => Some(e),
            _ => None,
        }
    }
}

impl From<FileError> for String {
    fn from(e: FileError) -> Self {
        e.to_string()
    }
}

// -----------------------------------------------------------------------------
// SettingsError
// -----------------------------------------------------------------------------

/// Errors produced by `Settings_Service` and the `Settings::validate` path.
///
/// All load-side variants share the design-mandated prefix
/// `"settings could not be loaded; using defaults"` followed by the underlying
/// reason. The save-side variant uses `"settings could not be saved: {e}"` so
/// the Settings_Modal can render a precise reason inline (Req 11.9).
#[derive(Debug)]
pub enum SettingsError {
    /// `serde_json::from_str` failed on the on-disk JSON. Req 10.5.
    Parse(String),
    /// One or more fields fell outside their declared bounds. Req 10.2, 10.3, 10.5.
    Validation(String),
    /// `std::fs::read` of `settings.json` failed. Req 10.7.
    IoRead(io::Error),
    /// Atomic write of `settings.json` failed. Req 10.7, 11.9.
    IoWrite(io::Error),
    /// Could not create the OS_Config_Dir. Req 10.4, 10.7.
    DirCreate(io::Error),
}

impl fmt::Display for SettingsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SettingsError::Parse(reason) => write!(
                f,
                "settings could not be loaded; using defaults: {reason}"
            ),
            SettingsError::Validation(reason) => write!(
                f,
                "settings could not be loaded; using defaults: {reason}"
            ),
            SettingsError::IoRead(e) => write!(
                f,
                "settings could not be loaded; using defaults: {e}"
            ),
            SettingsError::DirCreate(e) => write!(
                f,
                "settings could not be loaded; using defaults: {e}"
            ),
            SettingsError::IoWrite(e) => write!(f, "settings could not be saved: {e}"),
        }
    }
}

impl std::error::Error for SettingsError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            SettingsError::IoRead(e)
            | SettingsError::IoWrite(e)
            | SettingsError::DirCreate(e) => Some(e),
            _ => None,
        }
    }
}

impl From<SettingsError> for String {
    fn from(e: SettingsError) -> Self {
        e.to_string()
    }
}

// -----------------------------------------------------------------------------
// LlmError
// -----------------------------------------------------------------------------

/// Errors produced by `LLM_Client` (both `call_blocking` and the streaming
/// task). The Display strings are emitted verbatim on `tauri://llm-complete`
/// per Req 14.6 and rendered in the Status_Bar.
#[derive(Debug)]
pub enum LlmError {
    /// TCP connect did not complete within the 5s `connect_timeout`, or
    /// `reqwest::Error::is_connect()` returned true. Req 14.1.
    ConnectionFailed,
    /// No bytes from the response stream for 60s. Req 14.2.
    StreamTimedOut,
    /// HTTP connection closed/reset before `[DONE]` and no other variant
    /// matched. Req 14.5.
    ConnectionLost,
    /// An SSE `data:` payload could not be parsed as the chat-completions
    /// chunk envelope, or the non-streaming response body did not contain the
    /// expected fields. Req 14.4.
    InvalidResponse,
    /// `Response::status() != 200`. The Display includes the decimal status,
    /// e.g. `"HTTP 503"`. Req 14.3.
    HttpStatus(u16),
    /// User cancelled via Stop / Escape while a turn was in flight.
    Cancelled,
}

impl fmt::Display for LlmError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LlmError::ConnectionFailed => f.write_str("connection failed"),
            LlmError::StreamTimedOut => f.write_str("stream timed out"),
            LlmError::ConnectionLost => f.write_str("connection lost"),
            LlmError::InvalidResponse => f.write_str("invalid response"),
            LlmError::HttpStatus(code) => write!(f, "HTTP {code}"),
            LlmError::Cancelled => f.write_str(""),
        }
    }
}

impl std::error::Error for LlmError {}

impl From<LlmError> for String {
    fn from(e: LlmError) -> Self {
        e.to_string()
    }
}

// -----------------------------------------------------------------------------
// CommandError
// -----------------------------------------------------------------------------

/// Top-level adapter that wraps any layer-specific error so a Tauri command
/// can `?`-propagate uniformly while still returning `Result<T, String>` to
/// the frontend.
///
/// The variants are deliberately thin; `Display` simply forwards to the
/// inner type. `Message` carries free-form strings used by the design for
/// surfaces that are not bound to any layer enum (e.g. the
/// `"a stream is already active"` rejection from `StreamRegistry`).
#[derive(Debug)]
pub enum CommandError {
    File(FileError),
    Settings(SettingsError),
    Llm(LlmError),
    Message(String),
}

impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CommandError::File(e) => fmt::Display::fmt(e, f),
            CommandError::Settings(e) => fmt::Display::fmt(e, f),
            CommandError::Llm(e) => fmt::Display::fmt(e, f),
            CommandError::Message(s) => f.write_str(s),
        }
    }
}

impl std::error::Error for CommandError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            CommandError::File(e) => Some(e),
            CommandError::Settings(e) => Some(e),
            CommandError::Llm(e) => Some(e),
            CommandError::Message(_) => None,
        }
    }
}

impl From<FileError> for CommandError {
    fn from(e: FileError) -> Self {
        CommandError::File(e)
    }
}

impl From<SettingsError> for CommandError {
    fn from(e: SettingsError) -> Self {
        CommandError::Settings(e)
    }
}

impl From<LlmError> for CommandError {
    fn from(e: LlmError) -> Self {
        CommandError::Llm(e)
    }
}

impl From<String> for CommandError {
    fn from(s: String) -> Self {
        CommandError::Message(s)
    }
}

impl From<&str> for CommandError {
    fn from(s: &str) -> Self {
        CommandError::Message(s.to_string())
    }
}

impl From<CommandError> for String {
    fn from(e: CommandError) -> Self {
        e.to_string()
    }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::ErrorKind;

    #[test]
    fn file_error_messages_match_design_catalog() {
        assert_eq!(FileError::PathEmpty.to_string(), "path is empty");
        assert_eq!(FileError::PathNotAbsolute.to_string(), "path is not absolute");
        assert_eq!(FileError::PathNullByte.to_string(), "path contains null byte");
        assert_eq!(FileError::Encoding.to_string(), "file is not valid UTF-8");

        let read = FileError::IoRead(io::Error::new(ErrorKind::NotFound, "missing"));
        assert_eq!(read.to_string(), "could not read file: missing");

        let write = FileError::IoWrite(io::Error::new(ErrorKind::PermissionDenied, "denied"));
        assert_eq!(write.to_string(), "could not save file: denied");
    }

    #[test]
    fn llm_error_messages_match_design_catalog() {
        assert_eq!(LlmError::ConnectionFailed.to_string(), "connection failed");
        assert_eq!(LlmError::StreamTimedOut.to_string(), "stream timed out");
        assert_eq!(LlmError::ConnectionLost.to_string(), "connection lost");
        assert_eq!(LlmError::InvalidResponse.to_string(), "invalid response");
        assert_eq!(LlmError::HttpStatus(503).to_string(), "HTTP 503");
    }

    #[test]
    fn settings_error_load_messages_share_load_prefix() {
        let parse = SettingsError::Parse("expected `,` at line 1".into());
        assert_eq!(
            parse.to_string(),
            "settings could not be loaded; using defaults: expected `,` at line 1"
        );

        let validation = SettingsError::Validation("temperature out of range".into());
        assert_eq!(
            validation.to_string(),
            "settings could not be loaded; using defaults: temperature out of range"
        );

        let io_read = SettingsError::IoRead(io::Error::new(ErrorKind::Other, "io"));
        assert!(io_read
            .to_string()
            .starts_with("settings could not be loaded; using defaults: "));

        let dir = SettingsError::DirCreate(io::Error::new(ErrorKind::PermissionDenied, "denied"));
        assert!(dir
            .to_string()
            .starts_with("settings could not be loaded; using defaults: "));
    }

    #[test]
    fn settings_error_save_uses_save_message() {
        let save = SettingsError::IoWrite(io::Error::new(ErrorKind::PermissionDenied, "denied"));
        assert_eq!(save.to_string(), "settings could not be saved: denied");
    }

    #[test]
    fn errors_convert_into_string_via_from() {
        let s: String = FileError::PathEmpty.into();
        assert_eq!(s, "path is empty");

        let s: String = LlmError::HttpStatus(500).into();
        assert_eq!(s, "HTTP 500");

        let s: String = SettingsError::IoWrite(io::Error::new(ErrorKind::Other, "x")).into();
        assert_eq!(s, "settings could not be saved: x");

        let s: String = CommandError::from(FileError::Encoding).into();
        assert_eq!(s, "file is not valid UTF-8");
    }

    #[test]
    fn command_error_wraps_each_layer() {
        assert_eq!(
            CommandError::from(FileError::PathEmpty).to_string(),
            "path is empty"
        );
        assert_eq!(
            CommandError::from(LlmError::InvalidResponse).to_string(),
            "invalid response"
        );
        assert_eq!(
            CommandError::from("a stream is already active").to_string(),
            "a stream is already active"
        );
    }
}

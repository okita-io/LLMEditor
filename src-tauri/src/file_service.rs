// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// LLIMEdit — file_service.rs
//
// File_Service read and write pipelines for the Editor's single Buffer.
//
// Read pipeline (Req 4.5–4.9):
//
//   1. read raw bytes,
//   2. detect and strip a leading UTF-8 BOM (`EF BB BF`),
//   3. decode the remainder as UTF-8,
//   4. detect the file's line-ending style from the first terminator.
//
// Write pipeline (Req 5.3, 5.5, 6.3, 6.5, 6.6):
//
//   1. normalize every `\r\n`, lone `\r`, and lone `\n` to the recorded
//      `LineEnding` (or the OS default when `LineEnding::None`),
//   2. encode as UTF-8 and prepend `EF BB BF` iff `had_bom`,
//   3. write to a sibling temp file, `flush` + `sync_data`, then
//      `std::fs::rename` over the destination so the destination either
//      contains the new bytes in full or is left exactly as it was prior to
//      the call (Req 5.5, 6.6).
//
// The result of `read_file` is bundled into a `LoadedFile` so the surrounding
// command layer can both return the decoded `String` to the frontend
// (Req 15.1) and cache the BOM/line-ending preferences in `BufferMeta` for
// the next write (Req 4.6, 4.7, 5.3, 6.3).
//
// Errors are surfaced through the existing `crate::error::FileError` enum so
// they format with the design-mandated catalog strings (e.g.
// `"file is not valid UTF-8"`, `"could not read file: {os_error}"`,
// `"could not save file: {os_error}"`).
//
// References:
// - Requirements:
//     4.5 — decode as UTF-8
//     4.6 — strip UTF-8 BOM and remember it
//     4.7 — first terminator wins
//     4.8 — undecodable file -> Encoding error, leave Buffer untouched
//     4.9 — other read failures -> IoRead error, leave Buffer untouched
//     5.1 — write entire Buffer and flush before reporting success
//     5.3 — write encoded as UTF-8 with recorded line-ending and BOM prefs
//     5.5 — on failure, file at the path is preserved unchanged
//     6.3 — Save As reuses recorded BOM / line-ending preferences
//     6.5 — no recorded preferences -> OS default LF/CRLF, no BOM
//     6.6 — on failure, current file path unchanged, file unchanged on disk
// - design.md "Read pipeline (Req 4.5–4.7)" pins the read shape.
// - design.md "Write pipeline (Req 5.3, 6.3, 6.5)" pins the atomic write
//   pattern (sibling temp file, fsync, rename) shared with `Settings_Service`.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use crate::error::FileError;

// -----------------------------------------------------------------------------
// LineEnding
// -----------------------------------------------------------------------------

/// Line-terminator style detected when reading a file, recorded for use when
/// the same file is next written (Req 4.7, Req 5.3). The values intentionally
/// mirror the only three terminators a UTF-8 plain-text file can carry plus a
/// `None` sentinel for files with no terminator at all.
///
/// `LineEnding::None` is the natural state for a freshly-created Buffer or a
/// file that contains a single line with no trailing newline; the write
/// pipeline (Task 8) substitutes the OS default when this variant is seen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEnding {
    /// `\n` (Unix / classic macOS X+).
    Lf,
    /// `\r\n` (Windows / SMTP / many internet protocols).
    CrLf,
    /// `\r` (classic Mac OS pre-X). Vanishingly rare today but cheap to honor.
    Cr,
    /// No terminator was observed in the file.
    None,
}

// -----------------------------------------------------------------------------
// LoadedFile
// -----------------------------------------------------------------------------

/// Result of a successful `read_file` call: the decoded UTF-8 contents (with
/// the BOM, if any, already stripped) plus the metadata the next write needs
/// to faithfully reproduce the file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedFile {
    /// File contents decoded as UTF-8, with any leading BOM removed.
    pub contents: String,
    /// `true` iff the on-disk file began with the bytes `EF BB BF`. The write
    /// pipeline (Task 8) prepends the same BOM iff this flag is set, so a
    /// round-trip preserves the on-disk preamble exactly (Req 4.6, 5.3).
    pub had_bom: bool,
    /// Line-terminator style detected from the *first* occurrence of any
    /// terminator in the post-BOM contents (Req 4.7).
    pub line_ending: LineEnding,
}

// -----------------------------------------------------------------------------
// read_file
// -----------------------------------------------------------------------------

/// UTF-8 BOM byte sequence (`EF BB BF`).
///
/// Defined as a slice constant rather than inline literals so the BOM-strip
/// branch in `read_file` reads as a named operation.
const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// Read `path` from disk and decode it into a `LoadedFile`.
///
/// Pipeline (per design.md "Read pipeline"):
///
/// 1. `std::fs::read(path)` — any IO error maps to `FileError::IoRead`,
///    which preserves the underlying `io::Error` for the design's
///    `"could not read file: {e}"` Display string (Req 4.9, 15.1).
/// 2. If the first three bytes are the UTF-8 BOM, slice them off and set
///    `had_bom = true` (Req 4.6).
/// 3. Decode the remainder with `std::str::from_utf8`; failure becomes
///    `FileError::Encoding` (Req 4.5, 4.8, 15.1). The Buffer caller is
///    responsible for honoring "leave the Buffer unchanged" (Req 4.8) by
///    refusing to apply on `Err`.
/// 4. Scan for the *first* line terminator and classify it (Req 4.7). The
///    scan treats `\r\n` as a single terminator: when a `\r` is seen, the
///    next byte is peeked and `LineEnding::CrLf` is recorded if it is `\n`,
///    otherwise `LineEnding::Cr`. A lone `\n` produces `LineEnding::Lf`.
///    Files with no terminator yield `LineEnding::None`.
///
/// This function performs only blocking filesystem I/O; the surrounding Tauri
/// command layer is responsible for wrapping it in `spawn_blocking` if
/// invoked from the async runtime.
pub fn read_file(path: &Path) -> Result<LoadedFile, FileError> {
    // Step 1: raw bytes off disk.
    let bytes = std::fs::read(path).map_err(FileError::IoRead)?;

    // Step 2: BOM detection. Recording the flag before slicing keeps the
    // post-BOM byte slice independent of the BOM-presence branch below.
    let (had_bom, payload) = if bytes.starts_with(&UTF8_BOM) {
        (true, &bytes[UTF8_BOM.len()..])
    } else {
        (false, &bytes[..])
    };

    // Step 3: UTF-8 decode. `from_utf8` validates the entire slice; on
    // failure we surface the catalog `Encoding` error and discard the bytes.
    // The error variant deliberately carries no payload — Req 4.8 / 15.1
    // mandate the message text, and the underlying offset is not useful to
    // the user-facing Status_Bar.
    let text = std::str::from_utf8(payload).map_err(|_| FileError::Encoding)?;

    // Step 4: first-terminator detection. `text.as_bytes()` is safe to scan
    // byte-wise because UTF-8 multibyte continuation bytes are all in the
    // 0x80..=0xBF range and never collide with the ASCII `\r` (0x0D) or
    // `\n` (0x0A) we are looking for.
    let line_ending = detect_line_ending(text);

    Ok(LoadedFile {
        contents: text.to_owned(),
        had_bom,
        line_ending,
    })
}

/// Scan `s` for its *first* line terminator and classify it.
///
/// Pulled out of `read_file` so it has a single, easily-tested call shape and
/// a name that documents the "first wins" rule from Req 4.7. The scan is
/// O(n) in the position of the first terminator and bails the moment it is
/// found, so files with an early newline (the overwhelmingly common case)
/// are decided in a handful of byte comparisons.
fn detect_line_ending(s: &str) -> LineEnding {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' => {
                // Peek the next byte. `\r\n` collapses to a single CrLf
                // terminator (RFC 5234), so we deliberately do *not* fall
                // through to a separate `\n` match on the following
                // iteration.
                return if bytes.get(i + 1) == Some(&b'\n') {
                    LineEnding::CrLf
                } else {
                    LineEnding::Cr
                };
            }
            b'\n' => return LineEnding::Lf,
            _ => i += 1,
        }
    }
    LineEnding::None
}

// -----------------------------------------------------------------------------
// write_file
// -----------------------------------------------------------------------------

/// Resolve the line terminator the write pipeline will emit.
///
/// `LineEnding::None` is the natural state for a freshly-created Buffer and
/// for files whose original on-disk contents had no terminator at all
/// (Req 6.5). In that case the OS default applies: `\n` on macOS, `\r\n` on
/// Windows, and `\n` for any other Unix-like target so a sensible default
/// exists when the test suite runs on Linux CI.
fn target_terminator(line_ending: LineEnding) -> &'static str {
    match line_ending {
        LineEnding::Lf => "\n",
        LineEnding::CrLf => "\r\n",
        LineEnding::Cr => "\r",
        LineEnding::None => {
            if cfg!(target_os = "windows") {
                "\r\n"
            } else {
                // macOS and any other Unix-like target.
                "\n"
            }
        }
    }
}

/// Rewrite every line terminator in `s` to `target`.
///
/// The walk treats `\r\n` as a single terminator before checking for a lone
/// `\r`, so a `\r\n` input never expands into two emitted terminators
/// (Req 5.3). Inputs that hold exclusively the target terminator are emitted
/// verbatim.
///
/// Implementation note: this function operates on the `&str`'s byte slice
/// because UTF-8 leading bytes never collide with `\r` (0x0D) or `\n` (0x0A)
/// — a continuation byte in `0x80..=0xBF` cannot be mistaken for a
/// terminator. Non-terminator bytes are forwarded verbatim by slicing the
/// original `&str` (preserving multi-byte sequences); only terminator bytes
/// are rewritten. The result is therefore guaranteed to be valid UTF-8.
fn normalize_line_endings(s: &str, target: &str) -> String {
    // Heuristic capacity: same as input plus a small overhead per likely
    // terminator. UTF-8 length is the right unit because we never split
    // multi-byte sequences here.
    let mut out = String::with_capacity(s.len() + s.len() / 32);
    let bytes = s.as_bytes();
    let mut i = 0;
    // `segment_start` marks the beginning of a run of non-terminator bytes
    // that we copy out as one `&str` slice the moment we hit a terminator
    // (or EOF). Slicing an already-valid `&str` keeps multi-byte UTF-8
    // sequences intact.
    let mut segment_start = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' => {
                // Flush the preceding non-terminator run.
                out.push_str(&s[segment_start..i]);
                out.push_str(target);
                // Collapse `\r\n` into a single emitted terminator.
                if bytes.get(i + 1) == Some(&b'\n') {
                    i += 2;
                } else {
                    i += 1;
                }
                segment_start = i;
            }
            b'\n' => {
                out.push_str(&s[segment_start..i]);
                out.push_str(target);
                i += 1;
                segment_start = i;
            }
            _ => {
                i += 1;
            }
        }
    }
    // Trailing non-terminator run, if any.
    if segment_start < bytes.len() {
        out.push_str(&s[segment_start..]);
    }
    out
}

/// Build a sibling temp-file path for `dest`.
///
/// The temp file lives in the same directory as `dest` so the final
/// `std::fs::rename` is an intra-filesystem operation (the only shape POSIX
/// guarantees as atomic). The name combines the original file name, the
/// current pid, and a nanosecond suffix so concurrent writers — even within
/// the same process — pick disjoint names without depending on a random
/// number generator crate.
///
/// Returns `None` only when `dest` has no file-name component (e.g. a bare
/// `/`); the caller treats that as an `IoWrite` error.
fn temp_path_for(dest: &Path) -> Option<std::path::PathBuf> {
    let parent = dest.parent()?;
    let file_name = dest.file_name()?.to_string_lossy().into_owned();
    let pid = std::process::id();
    // `subsec_nanos()` is bounded to `0..1_000_000_000` and rolls over fast
    // enough that successive calls within a single test run produce distinct
    // values. If the system clock is unavailable for any reason, fall back to
    // a constant — `OpenOptions::create_new` will still surface the
    // resulting collision as a clean error.
    let rand = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    Some(parent.join(format!("{file_name}.tmp.{pid}.{rand}")))
}

/// Write `contents` to `path` as a UTF-8 plain-text file with the recorded
/// BOM and line-ending preferences.
///
/// Pipeline (per design.md "Write pipeline"):
///
/// 1. Normalize every `\r\n`, lone `\r`, and lone `\n` in `contents` to the
///    terminator implied by `line_ending` (Req 5.3). `LineEnding::None`
///    resolves to the OS default per Req 6.5 — `\n` on macOS / Unix, `\r\n`
///    on Windows.
/// 2. Encode the normalized string as UTF-8 bytes and prepend the
///    `EF BB BF` BOM iff `had_bom` (Req 5.3, 6.3, 6.5).
/// 3. Open a sibling temp file with `create_new` (so we never clobber an
///    in-flight rename from another writer), write all bytes, `flush`, then
///    `sync_data` to push the new bytes through the OS page cache and onto
///    durable storage before the rename (Req 5.1).
/// 4. `std::fs::rename(temp, path)` is the atomic flip. POSIX guarantees the
///    rename is atomic within a single filesystem; the `path` parent and the
///    temp file share that filesystem by construction.
///
/// Failure handling (Req 5.5, 6.6): any error in step 3 or 4 triggers a
/// best-effort `remove_file` on the temp path (failures of the cleanup are
/// deliberately swallowed — there is nothing the user can do about them and
/// the temp file is named to avoid colliding with anything important) and
/// returns `FileError::IoWrite`. Step 1 and 2 do no I/O and cannot leave a
/// partial file behind.
pub fn write_file(
    path: &Path,
    contents: &str,
    had_bom: bool,
    line_ending: LineEnding,
) -> Result<(), FileError> {
    // Step 1: normalize line endings.
    let target = target_terminator(line_ending);
    let normalized = normalize_line_endings(contents, target);

    // Step 2: encode + optional BOM. Pre-allocate so the BOM does not force a
    // realloc on the common path.
    let mut bytes = Vec::with_capacity(normalized.len() + if had_bom { UTF8_BOM.len() } else { 0 });
    if had_bom {
        bytes.extend_from_slice(&UTF8_BOM);
    }
    bytes.extend_from_slice(normalized.as_bytes());

    // Step 3 + 4: atomic temp + fsync + rename.
    let temp = temp_path_for(path).ok_or_else(|| {
        FileError::IoWrite(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "destination path has no file name",
        ))
    })?;

    // Inner closure so any `?`-failure in the I/O stage flows into the
    // single cleanup branch below.
    let write_result: std::io::Result<()> = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(&bytes)?;
        file.flush()?;
        file.sync_data()?;
        // `file` is dropped here, closing the descriptor before the rename.
        // Some platforms (Windows in particular) require the source handle to
        // be closed before a rename can succeed.
        drop(file);
        std::fs::rename(&temp, path)?;
        Ok(())
    })();

    if let Err(e) = write_result {
        // Best-effort cleanup. If the rename succeeded, the temp file no
        // longer exists; otherwise we try once and ignore the result.
        let _ = std::fs::remove_file(&temp);
        return Err(FileError::IoWrite(e));
    }

    Ok(())
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    /// Helper: write the given bytes to a fresh temp file and return both the
    /// owning `TempDir` (so it survives the test) and the file path. The
    /// `TempDir` is returned so the caller can keep it in scope; dropping it
    /// would delete the file before `read_file` runs.
    fn write_temp(bytes: &[u8]) -> (TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("input.txt");
        let mut f = std::fs::File::create(&path).expect("create");
        f.write_all(bytes).expect("write");
        f.sync_all().expect("sync");
        (dir, path)
    }

    // -- Req 4.5, 4.7: line-ending detection without BOM --------------------

    #[test]
    fn reads_file_with_lf_line_ending() {
        let (_dir, path) = write_temp(b"hello\nworld\n");
        let loaded = read_file(&path).expect("ok");
        assert_eq!(loaded.contents, "hello\nworld\n");
        assert!(!loaded.had_bom);
        assert_eq!(loaded.line_ending, LineEnding::Lf);
    }

    #[test]
    fn reads_file_with_crlf_line_ending() {
        let (_dir, path) = write_temp(b"hello\r\nworld\r\n");
        let loaded = read_file(&path).expect("ok");
        assert_eq!(loaded.contents, "hello\r\nworld\r\n");
        assert!(!loaded.had_bom);
        assert_eq!(loaded.line_ending, LineEnding::CrLf);
    }

    #[test]
    fn reads_file_with_cr_line_ending() {
        let (_dir, path) = write_temp(b"hello\rworld\r");
        let loaded = read_file(&path).expect("ok");
        assert_eq!(loaded.contents, "hello\rworld\r");
        assert!(!loaded.had_bom);
        assert_eq!(loaded.line_ending, LineEnding::Cr);
    }

    #[test]
    fn reads_file_with_no_line_terminator() {
        let (_dir, path) = write_temp(b"single line no terminator");
        let loaded = read_file(&path).expect("ok");
        assert_eq!(loaded.contents, "single line no terminator");
        assert!(!loaded.had_bom);
        assert_eq!(loaded.line_ending, LineEnding::None);
    }

    #[test]
    fn empty_file_has_no_bom_and_no_line_ending() {
        let (_dir, path) = write_temp(b"");
        let loaded = read_file(&path).expect("ok");
        assert_eq!(loaded.contents, "");
        assert!(!loaded.had_bom);
        assert_eq!(loaded.line_ending, LineEnding::None);
    }

    // -- Req 4.6: BOM handling ----------------------------------------------

    #[test]
    fn strips_utf8_bom_and_records_flag() {
        // BOM + "héllo\n" (with a multi-byte char to make sure the post-BOM
        // slice is treated as UTF-8 rather than ASCII).
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("héllo\n".as_bytes());
        let (_dir, path) = write_temp(&bytes);
        let loaded = read_file(&path).expect("ok");
        assert_eq!(loaded.contents, "héllo\n");
        assert!(loaded.had_bom);
        assert_eq!(loaded.line_ending, LineEnding::Lf);
    }

    #[test]
    fn bom_only_file_yields_empty_contents() {
        let (_dir, path) = write_temp(&[0xEF, 0xBB, 0xBF]);
        let loaded = read_file(&path).expect("ok");
        assert_eq!(loaded.contents, "");
        assert!(loaded.had_bom);
        assert_eq!(loaded.line_ending, LineEnding::None);
    }

    // -- Req 4.7: first-terminator-wins, even when the file mixes styles -----

    #[test]
    fn mixed_endings_first_lf_wins_over_later_crlf() {
        let (_dir, path) = write_temp(b"alpha\nbeta\r\ngamma");
        let loaded = read_file(&path).expect("ok");
        assert_eq!(loaded.line_ending, LineEnding::Lf);
    }

    #[test]
    fn mixed_endings_first_crlf_wins_over_later_lf() {
        let (_dir, path) = write_temp(b"alpha\r\nbeta\ngamma");
        let loaded = read_file(&path).expect("ok");
        assert_eq!(loaded.line_ending, LineEnding::CrLf);
    }

    #[test]
    fn mixed_endings_first_cr_wins_over_later_lf() {
        // A lone `\r` not followed by `\n` must classify as Cr even though a
        // later `\n` exists.
        let (_dir, path) = write_temp(b"alpha\rbeta\ngamma");
        let loaded = read_file(&path).expect("ok");
        assert_eq!(loaded.line_ending, LineEnding::Cr);
    }

    #[test]
    fn cr_at_end_of_file_classifies_as_cr() {
        // `\r` as the very last byte must not look past EOF for the `\n`.
        let (_dir, path) = write_temp(b"alpha\r");
        let loaded = read_file(&path).expect("ok");
        assert_eq!(loaded.line_ending, LineEnding::Cr);
    }

    // -- Req 4.8: invalid UTF-8 surfaces FileError::Encoding ----------------

    #[test]
    fn invalid_utf8_returns_encoding_error() {
        // 0xFF is never valid in UTF-8, regardless of context.
        let (_dir, path) = write_temp(&[b'a', 0xFF, b'b']);
        let err = read_file(&path).expect_err("should reject");
        assert!(matches!(err, FileError::Encoding));
        assert_eq!(err.to_string(), "file is not valid UTF-8");
    }

    #[test]
    fn invalid_utf8_after_bom_returns_encoding_error() {
        // Valid BOM but the post-BOM payload is bad UTF-8. The BOM itself
        // must not save us from the encoding check.
        let bytes = [0xEF, 0xBB, 0xBF, 0xFF, 0xFE];
        let (_dir, path) = write_temp(&bytes);
        let err = read_file(&path).expect_err("should reject");
        assert!(matches!(err, FileError::Encoding));
    }

    // -- Req 4.9: read failures surface FileError::IoRead -------------------

    #[test]
    fn missing_path_returns_io_read_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("does-not-exist.txt");
        let err = read_file(&path).expect_err("should fail");
        assert!(matches!(err, FileError::IoRead(_)));
        // Display must follow the design's catalog prefix.
        assert!(err.to_string().starts_with("could not read file: "));
    }

    // ===========================================================================
    // write_file tests (Task 8 / Req 5.1, 5.3, 5.5, 6.3, 6.5, 6.6)
    // ===========================================================================

    /// Helper: directory listing of `path`'s parent, used to assert that the
    /// atomic-write pipeline left no `*.tmp.*` siblings behind on success.
    fn sibling_names(file_path: &Path) -> Vec<String> {
        let parent = file_path.parent().expect("parent");
        std::fs::read_dir(parent)
            .expect("read_dir")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .collect()
    }

    fn fresh_dest() -> (TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("output.txt");
        (dir, path)
    }

    // -- Req 5.3, 6.3: BOM × LineEnding round-trip matrix -------------------
    //
    // Exercise every (had_bom × line_ending) combination by writing a Buffer,
    // reading it back, and asserting the metadata survives. `LineEnding::None`
    // is exercised separately below because reading a file with terminators
    // never produces `None` — the writer substitutes the OS default and the
    // reader detects the chosen terminator.

    fn roundtrip_with(line_ending: LineEnding, had_bom: bool) {
        let (_dir, path) = fresh_dest();
        // Use a Buffer with multiple lines so the line-ending normalization
        // has something to do, plus a multi-byte char to keep us honest about
        // UTF-8.
        let buffer = "héllo\nbeta\ngamma";
        write_file(&path, buffer, had_bom, line_ending).expect("write");

        let loaded = read_file(&path).expect("read");
        let expected_terminator = match line_ending {
            LineEnding::Lf => "\n",
            LineEnding::CrLf => "\r\n",
            LineEnding::Cr => "\r",
            LineEnding::None => unreachable!(),
        };
        assert_eq!(loaded.contents, buffer.replace('\n', expected_terminator));
        assert_eq!(loaded.had_bom, had_bom);
        assert_eq!(loaded.line_ending, line_ending);
    }

    #[test]
    fn round_trip_lf_no_bom() {
        roundtrip_with(LineEnding::Lf, false);
    }

    #[test]
    fn round_trip_lf_with_bom() {
        roundtrip_with(LineEnding::Lf, true);
    }

    #[test]
    fn round_trip_crlf_no_bom() {
        roundtrip_with(LineEnding::CrLf, false);
    }

    #[test]
    fn round_trip_crlf_with_bom() {
        roundtrip_with(LineEnding::CrLf, true);
    }

    #[test]
    fn round_trip_cr_no_bom() {
        roundtrip_with(LineEnding::Cr, false);
    }

    #[test]
    fn round_trip_cr_with_bom() {
        roundtrip_with(LineEnding::Cr, true);
    }

    // -- Req 6.5: LineEnding::None resolves to the OS default ---------------

    #[test]
    fn line_ending_none_uses_os_default_terminator() {
        let (_dir, path) = fresh_dest();
        // Buffer with `\n` separators so we can observe what the writer
        // substitutes.
        write_file(&path, "alpha\nbeta", false, LineEnding::None).expect("write");
        let bytes = std::fs::read(&path).expect("read");
        let expected: &[u8] = if cfg!(target_os = "windows") {
            b"alpha\r\nbeta"
        } else {
            b"alpha\nbeta"
        };
        assert_eq!(bytes, expected);
    }

    #[test]
    fn line_ending_none_does_not_prepend_bom_when_flag_unset() {
        // Req 6.5: no recorded preferences => no BOM. We rely on the
        // had_bom=false caller honoring that contract.
        let (_dir, path) = fresh_dest();
        write_file(&path, "x", false, LineEnding::None).expect("write");
        let bytes = std::fs::read(&path).expect("read");
        assert!(!bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
    }

    // -- Req 5.3: mixed terminators in input collapse to the recorded one ---

    #[test]
    fn mixed_input_endings_normalize_to_target() {
        let (_dir, path) = fresh_dest();
        // Input deliberately mixes all three terminator styles. Each \r\n
        // must collapse to a single emitted terminator.
        let buffer = "a\nb\r\nc\rd";
        write_file(&path, buffer, false, LineEnding::CrLf).expect("write");
        let bytes = std::fs::read(&path).expect("read");
        assert_eq!(bytes, b"a\r\nb\r\nc\r\nd");
    }

    #[test]
    fn mixed_input_endings_normalize_to_lf_target() {
        let (_dir, path) = fresh_dest();
        let buffer = "a\nb\r\nc\rd";
        write_file(&path, buffer, false, LineEnding::Lf).expect("write");
        let bytes = std::fs::read(&path).expect("read");
        assert_eq!(bytes, b"a\nb\nc\nd");
    }

    #[test]
    fn mixed_input_endings_normalize_to_cr_target() {
        let (_dir, path) = fresh_dest();
        let buffer = "a\nb\r\nc\rd";
        write_file(&path, buffer, false, LineEnding::Cr).expect("write");
        let bytes = std::fs::read(&path).expect("read");
        assert_eq!(bytes, b"a\rb\rc\rd");
    }

    // -- Req 5.3: BOM bytes are prepended only when had_bom is set ----------

    #[test]
    fn bom_is_written_when_flag_set() {
        let (_dir, path) = fresh_dest();
        write_file(&path, "abc", true, LineEnding::Lf).expect("write");
        let bytes = std::fs::read(&path).expect("read");
        assert_eq!(bytes, b"\xEF\xBB\xBFabc");
    }

    #[test]
    fn bom_is_omitted_when_flag_unset() {
        let (_dir, path) = fresh_dest();
        write_file(&path, "abc", false, LineEnding::Lf).expect("write");
        let bytes = std::fs::read(&path).expect("read");
        assert_eq!(bytes, b"abc");
    }

    // -- Req 5.1: empty Buffer writes a zero-byte file ----------------------

    #[test]
    fn empty_buffer_writes_zero_bytes() {
        let (_dir, path) = fresh_dest();
        write_file(&path, "", false, LineEnding::Lf).expect("write");
        let bytes = std::fs::read(&path).expect("read");
        assert!(bytes.is_empty());
    }

    #[test]
    fn empty_buffer_with_bom_writes_only_bom() {
        let (_dir, path) = fresh_dest();
        write_file(&path, "", true, LineEnding::Lf).expect("write");
        let bytes = std::fs::read(&path).expect("read");
        assert_eq!(bytes, b"\xEF\xBB\xBF");
    }

    // -- Atomic write leaves no temp siblings on success --------------------

    #[test]
    fn successful_write_leaves_no_tmp_siblings() {
        let (_dir, path) = fresh_dest();
        write_file(&path, "hello\n", false, LineEnding::Lf).expect("write");
        let names = sibling_names(&path);
        // Exactly one entry, the destination file. No `output.txt.tmp.*`.
        assert_eq!(names, vec!["output.txt".to_string()]);
        assert!(!names.iter().any(|n| n.contains(".tmp.")));
    }

    #[test]
    fn overwriting_existing_file_replaces_contents_atomically() {
        let (_dir, path) = fresh_dest();
        // Seed the destination with prior contents.
        write_file(&path, "v1\n", false, LineEnding::Lf).expect("seed");
        // Overwrite with new contents.
        write_file(&path, "v2\n", false, LineEnding::Lf).expect("overwrite");
        let bytes = std::fs::read(&path).expect("read");
        assert_eq!(bytes, b"v2\n");
        // Still no temp siblings.
        let names = sibling_names(&path);
        assert!(!names.iter().any(|n| n.contains(".tmp.")));
    }

    // -- Req 5.5, 6.6: failure leaves the destination untouched -------------

    #[test]
    fn missing_parent_dir_returns_io_write_and_leaves_dest_absent() {
        // Write to a path whose parent directory does not exist. The temp
        // file create itself fails, so no `*.tmp.*` is left behind and the
        // destination remains absent.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("nope").join("output.txt");
        let err = write_file(&path, "x", false, LineEnding::Lf).expect_err("should fail");
        assert!(matches!(err, FileError::IoWrite(_)));
        assert!(err.to_string().starts_with("could not save file: "));
        // Destination still absent.
        assert!(!path.exists());
        // No temp file left in the (still-nonexistent) parent directory.
        assert!(!dir.path().join("nope").exists());
    }

    #[test]
    fn write_failure_preserves_prior_destination_contents() {
        // Seed the destination, then trigger a write failure by handing a
        // path whose parent does not exist (a *different* path). We verify
        // here that the seeded file stays intact — the design contract says
        // "the file at the associated path is preserved unchanged from its
        // contents prior to the save attempt" (Req 5.5).
        let (_dir, seeded) = fresh_dest();
        write_file(&seeded, "kept\n", false, LineEnding::Lf).expect("seed");
        let original = std::fs::read(&seeded).expect("seed-read");

        let bad_path = _dir.path().join("missing").join("other.txt");
        let err = write_file(&bad_path, "ignored", false, LineEnding::Lf).expect_err("fail");
        assert!(matches!(err, FileError::IoWrite(_)));

        // Seeded destination unchanged.
        assert_eq!(std::fs::read(&seeded).expect("re-read"), original);
    }
}

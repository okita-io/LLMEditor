<!--
SPDX-License-Identifier: MIT
Copyright (c) 2026 okita.io
-->

# LLIMEdit Cross-Platform Smoke Runbook

This runbook is executed against the **packaged** `cargo tauri build` output on
each release-candidate (macOS `.app` bundle, Windows `.exe` installer +
unpacked `.exe`). It is intentionally short; deep coverage lives in the unit,
property, and integration suites under `src-tauri/` and `src/__tests__/`.

The runbook is intended to be run by a CI matrix containing one macOS runner
and one Windows runner. Steps are numbered; each step links back to the
acceptance criterion it exercises. Steps marked **(driver)** are exercised by
the `tauri-driver`-backed automation harness in `scripts/smoke.sh`; the
remaining steps are manual fallbacks for when `tauri-driver` is unavailable
on the runner.

## 0. Pre-requisites

- `cargo tauri build` has produced a release artifact:
  - macOS: `src-tauri/target/release/bundle/macos/LLIMEdit.app` and the `.app`
    bundle's executable at `LLIMEdit.app/Contents/MacOS/llimedit`.
  - Windows: `src-tauri/target/release/bundle/nsis/LLIMEdit_<version>_x64-setup.exe`
    plus the unpacked binary at `src-tauri/target/release/llimedit.exe`.
- A clean per-OS config dir so settings start at defaults (Req 10.4):
  - macOS: `rm -rf "$HOME/Library/Application Support/LLIMEdit"`
  - Windows: `Remove-Item -Recurse -Force "$env:APPDATA/LLIMEdit"`
- A small fixture file `scripts/fixtures/hello.txt` containing the bytes
  `hello, world\n` (created on demand by the harness).
- A stub LM-Studio-shaped HTTP server is **not** spun up here; the streamed
  completion in step 6 is exercised through `tauri-driver` event injection
  against the production `tauri://llm-token` / `tauri://llm-complete` event
  channel.

## 1. Launch and shell assertions (Req 1.1, 1.2) **(driver)**

1. Launch the packaged binary.
2. Assert the single visible window's title is exactly `LLIMEdit` (Req 1.1).
3. Assert the window's outer size is at least 800 x 600 px (Req 1.1).
4. Assert keyboard focus is in the `<textarea id="buffer">` element (Req 1.2).
5. Assert the AI menu items are enabled within 2 s of launch (settings warm-up
   completed; Req 1.6).

## 2. Open a `.txt` fixture (Req 4.4) **(driver)**

1. Drive `File -> Open` (or `Cmd/Ctrl+O`) and select `scripts/fixtures/hello.txt`.
2. Assert the editor buffer's value equals the fixture contents.
3. Assert the status bar shows the absolute path of the fixture and the
   character count `12` (code-point length of `hello, world` after the LF
   terminator is stripped per Req 4.7 detection; the textarea normalizes the
   final newline to the editor's view, so the rendered count is the buffer's
   `<textarea>.value.length` per `String.prototype.length`).
4. Assert no leading `*` (the buffer is clean; Req 9.7).

## 3. Dirty -> Save -> Reopen round-trip (Req 9.6, 9.7, 4.4)

1. Type the literal characters `xyz` at the end of the buffer.
2. Assert the status bar's path segment is prefixed with `*` (Req 9.6).
3. Drive `File -> Save` (`Cmd/Ctrl+S`).
4. Assert the `*` disappears from the status bar (Req 9.7).
5. Close and reopen the same file via `File -> Open`.
6. Assert the buffer contents equal `hello, worldxyz\n` (Req 4.4 round-trip)
   and the status bar shows the correct path + code-point count.

## 4. Settings model change reflected within 200 ms (Req 9.5) **(driver)**

1. Drive `AI -> Settings`.
2. Assert every input is pre-populated with the value currently stored on disk
   (Req 11.1).
3. Replace the `model` field's value with `smoke-model`.
4. Click `Save`. Record the wall-clock timestamp at which the click event was
   dispatched.
5. Assert the modal closes (Req 11.3).
6. Assert the status bar text contains `smoke-model` within 200 ms of the
   click timestamp (Req 9.5).

## 5. Streamed completion via stub backend (Req 13, 14.7) **(driver)**

This step does not require a live LM Studio. Instead the harness uses
`tauri-driver`'s event-injection API to push synthetic `tauri://llm-token`
and `tauri://llm-complete` events at the running app, exercising the
frontend stream-handling path end to end. The backend stream task is
short-circuited by overriding the `api_url` in settings to a bound but
non-listening port; the frontend is driven entirely by the injected events.

1. Set the buffer to `tell me a joke`.
2. Drive `AI -> Send to Model` (`Cmd/Ctrl+L`). Assert `bufferEl.disabled`
   becomes `true` and the status bar shows the in-progress indicator
   (Req 12.6).
3. Inject three `tauri://llm-token` events with payloads `"Why "`, `"did "`,
   `"the chicken cross"`.
4. Assert each token is appended to the buffer (insertion mode is the
   `replace_document` default per Req 10.4, so the entire buffer should now
   be the concatenation of the three fragments).
5. Inject one `tauri://llm-complete` event with no error reason.
6. Assert `bufferEl.disabled === false` (Req 14.7) and the status bar's
   in-progress indicator is cleared.
7. Assert the editor accepts a typed character and the dirty asterisk
   appears (the buffer is now editable again).

## 6. Restart persistence (Req 10.4, 10.8 round-trip) **(driver)**

1. Quit the app cleanly via `File -> Quit`.
2. Relaunch the packaged binary.
3. Drive `AI -> Settings`. Assert `model` is exactly `smoke-model`.
4. Cancel the modal.

## 7. Cleanup

- Restore the fixture file from git: `git checkout -- scripts/fixtures/hello.txt`.
- Reset settings: remove the OS_Config_Dir per step 0 so subsequent runs are
  reproducible.

## CI invocation

The harness in `scripts/smoke.sh` orchestrates the build (`cargo tauri build`),
ensures the fixture exists, and then drives steps 1-6 via `tauri-driver`
when present. If `tauri-driver` is not on `PATH` the harness exits with a
non-zero status and the runbook above MUST be executed manually before the
release is tagged. CI runners on macOS and Windows both invoke the same
`scripts/smoke.sh` (executed via `bash` on Windows runners through Git Bash
or WSL).

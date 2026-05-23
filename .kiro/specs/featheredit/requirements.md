# Requirements Document

## Introduction

LLIMEdit is a minimal, cross-platform (macOS and Windows) plain-text editor built on Tauri (Rust backend, vanilla HTML/CSS/JS frontend). Its purpose is to provide a fast-launching, low-memory, MIT-licensed editor for plain-text files (.txt, .md, .yaml, .pencil, etc.) with first-class integration to a locally running LM Studio instance via the OpenAI-compatible chat completions API. Users can send the entire document or a selection to the model, stream the response back into the editor, and configure the endpoint, model, and generation parameters through a settings modal. The v0.1 scope is intentionally narrow: single window, single buffer, no tabs, no syntax highlighting, no themes, no plugins.

## Glossary

- **LLIMEdit**: The application as a whole (Tauri shell, Rust backend, and HTML/JS frontend).
- **Editor**: The frontend component that hosts the single text buffer and handles user input.
- **Buffer**: The in-memory text content currently loaded in the Editor.
- **Backend**: The Rust process exposing Tauri commands to the frontend.
- **File_Service**: The Backend subsystem responsible for reading and writing files on disk.
- **LLM_Client**: The Backend subsystem responsible for HTTP communication with the LM Studio endpoint.
- **Settings_Service**: The Backend subsystem responsible for loading and persisting user settings.
- **Settings_Store**: The on-disk JSON file that persists user settings.
- **LM_Studio_Endpoint**: An HTTP endpoint that conforms to the OpenAI `/v1/chat/completions` API contract (default `http://localhost:1234/v1/chat/completions`).
- **Stream**: A single in-flight Server-Sent-Events response from the LM_Studio_Endpoint to the LLM_Client.
- **Insertion_Mode**: One of `insert_at_cursor`, `replace_selection`, or `replace_document`, controlling how an LLM response is applied to the Buffer.
- **Dirty_Buffer**: A Buffer whose contents differ from the last loaded or saved file contents (or has never been saved).
- **Status_Bar**: The fixed bar at the bottom of the window displaying file path, character count, and model name.
- **Settings_Modal**: The modal dialog presenting editable settings fields.
- **OS_Config_Dir**: The OS-standard per-user configuration directory (`~/Library/Application Support/LLIMEdit/` on macOS, `%APPDATA%\LLIMEdit\` on Windows).
- **Edit_Group**: A sequence of Buffer mutations grouped together such that one Undo invocation reverts every mutation in the sequence and one Redo invocation reapplies every mutation in the sequence.
- **Undo_Stack**: An in-memory ordered collection of Edit_Groups maintained by the Editor, where the most recently committed Edit_Group is the topmost element and Undo operates on the topmost element.
- **Redo_Stack**: An in-memory ordered collection of Edit_Groups maintained by the Editor, populated by Edit_Groups removed from the Undo_Stack via Undo and consumed by Redo to reapply them to the Buffer.

## Requirements

### Requirement 1: Application Shell and Launch

**User Story:** As a user, I want LLIMEdit to launch quickly into a single editor window, so that I can start writing or editing text immediately.

#### Acceptance Criteria

1. WHEN LLIMEdit is launched, THE LLIMEdit SHALL display a single window titled "LLIMEdit" with an initial size of at least 800 pixels wide and 600 pixels tall, containing a menu bar at the top of the window, an Editor occupying the vertical space between the menu bar and the Status_Bar, and a Status_Bar at the bottom of the window.
2. WHEN LLIMEdit is launched, THE LLIMEdit SHALL initialize the Buffer to an empty string with no associated file path and SHALL place keyboard focus in the Editor.
3. WHILE the Settings_Service is loading settings during launch, THE LLIMEdit SHALL render every item of the AI menu in a disabled state such that activating any item produces no action.
4. THE LLIMEdit SHALL build to a `.app` bundle on macOS and an `.exe` on Windows using the default Tauri build pipeline.
5. THE LLIMEdit SHALL be distributed under the MIT License.
6. WHEN the Settings_Service completes the launch-time settings load, whether by returning successfully parsed values from the Settings_Store or by falling back to default values per the Settings_Service contract, THE LLIMEdit SHALL enable every item of the AI menu.

### Requirement 2: Menu Bar Structure

**User Story:** As a user, I want a familiar menu bar, so that I can discover and trigger actions without memorizing shortcuts.

#### Acceptance Criteria

1. THE LLIMEdit SHALL display a horizontal menu bar at the top of the application window containing top-level menus in the left-to-right order: File, Edit, AI, Help.
2. THE LLIMEdit SHALL provide a File menu containing, in top-to-bottom order, the items labeled "Open", "Save", "Save As", and "Quit".
3. THE LLIMEdit SHALL provide an Edit menu containing, in top-to-bottom order, the items labeled "Undo", "Redo", "Cut", "Copy", and "Paste".
4. THE LLIMEdit SHALL provide an AI menu containing, in top-to-bottom order, the items labeled "Send to Model" and "Settings".
5. THE LLIMEdit SHALL provide a Help menu containing the item labeled "About".
6. WHILE the Settings_Service has not yet successfully completed loading settings on launch, THE LLIMEdit SHALL render the AI menu items in a disabled state that does not respond to activation.
7. WHEN the user activates a menu item via mouse click or keyboard activation (including platform menu navigation keys), THE LLIMEdit SHALL invoke the same action handler that the corresponding keyboard shortcut defined in Requirement 3 invokes, or for menu items that have no shortcut defined in Requirement 3, the action named by the item's label as defined in this document.
8. WHEN the user activates the Help → About item, THE LLIMEdit SHALL display a modal dialog containing the application name "LLIMEdit", the current application version, and a notice that the application is distributed under the MIT License.

### Requirement 3: Keyboard Shortcuts

**User Story:** As a user, I want standard keyboard shortcuts, so that I can work efficiently without using the menu.

#### Acceptance Criteria

1. WHEN the user presses Ctrl+O on Windows or Cmd+O on macOS, THE LLIMEdit SHALL invoke the Open File action and suppress the host platform's default action for that key combination.
2. WHEN the user presses Ctrl+S on Windows or Cmd+S on macOS, THE LLIMEdit SHALL invoke the Save File action and suppress the host platform's default action for that key combination.
3. WHEN the user presses Ctrl+Shift+S on Windows or Cmd+Shift+S on macOS, THE LLIMEdit SHALL invoke the Save As action and suppress the host platform's default action for that key combination.
4. WHEN the user presses Ctrl+L on Windows or Cmd+L on macOS, THE LLIMEdit SHALL invoke the Send to Model action and suppress the host platform's default action for that key combination.
5. WHILE a Stream is active, WHEN the user presses the Escape key, THE LLIMEdit SHALL cancel the Stream.
6. WHILE the Settings_Modal is open, IF the user presses Ctrl+O, Ctrl+S, Ctrl+Shift+S, or Ctrl+L on Windows, or Cmd+O, Cmd+S, Cmd+Shift+S, or Cmd+L on macOS, THEN THE LLIMEdit SHALL not invoke the corresponding action and SHALL leave the Buffer and current file path unchanged.
7. WHILE a Stream is active, IF the user presses Ctrl+O, Ctrl+S, or Ctrl+Shift+S on Windows, or Cmd+O, Cmd+S, or Cmd+Shift+S on macOS, THEN THE LLIMEdit SHALL not invoke the corresponding action and SHALL leave the Buffer and current file path unchanged.
8. IF the user presses the Escape key while no Stream is active, THEN THE LLIMEdit SHALL leave the Buffer, the current file path, and the Settings_Modal open/closed state unchanged.

### Requirement 4: Open File

**User Story:** As a user, I want to open an existing text file, so that I can edit its contents.

#### Acceptance Criteria

1. WHEN the user invokes the Open File action, THE LLIMEdit SHALL display a native file picker filtered to show files with extensions `.txt`, `.md`, `.yaml`, `.yml`, `.pencil`, with an "All files" option.
2. IF the user cancels the Open File picker without selecting a file, THEN THE LLIMEdit SHALL leave the Buffer, the current file path, and the Status_Bar unchanged.
3. WHEN the user selects a file in the Open File picker and the Buffer is a Dirty_Buffer, THE LLIMEdit SHALL display a prompt offering Save, Discard, and Cancel before loading the new file, where Save behaves per Requirement 7 criterion 3, Discard behaves per Requirement 7 criterion 4, and Cancel aborts the open and leaves the Buffer, current file path, and Status_Bar unchanged.
4. WHEN the File_Service successfully reads a selected file, THE Editor SHALL replace the Buffer with the file contents, record the file path as the current path, mark the Buffer as not a Dirty_Buffer, and update the Status_Bar to display the absolute file path and the current character count of the Buffer expressed in Unicode code points.
5. THE File_Service SHALL decode file contents as UTF-8.
6. WHERE a file begins with a UTF-8 byte-order mark, THE File_Service SHALL strip the byte-order mark from the Buffer contents and record the byte-order mark preference as present for use when the file is next written.
7. THE File_Service SHALL detect the line-ending style of a file as the first line terminator encountered in the file (one of `\r\n`, `\n`, or `\r`) and record that style for use when the file is next written.
8. IF the File_Service cannot decode the selected file as UTF-8, THEN THE LLIMEdit SHALL leave the Buffer, the current file path, and the Dirty_Buffer state unchanged and display an encoding-error reason in the Status_Bar.
9. IF the File_Service fails to read the selected file for any other reason, THEN THE LLIMEdit SHALL leave the Buffer, the current file path, and the Dirty_Buffer state unchanged and display the failure reason in the Status_Bar.

### Requirement 5: Save File

**User Story:** As a user, I want to save the current Buffer to disk, so that my changes persist.

#### Acceptance Criteria

1. WHEN the user invokes the Save File action and the Buffer has an associated absolute file path, THE File_Service SHALL write the entire Buffer contents to that path and flush the written bytes to the operating system before reporting success.
2. WHEN the user invokes the Save File action and the Buffer has no associated file path, THE LLIMEdit SHALL invoke the Save As action.
3. WHEN the File_Service writes the Buffer, THE File_Service SHALL encode the contents as UTF-8 using the line-ending style and byte-order mark preference recorded for the current file.
4. WHEN the File_Service successfully writes the Buffer, THE LLIMEdit SHALL mark the Buffer as not a Dirty_Buffer.
5. IF the File_Service fails to write the Buffer, THEN THE LLIMEdit SHALL leave the Buffer marked as a Dirty_Buffer, preserve the file at the associated path unchanged from its contents prior to the save attempt, and display the failure reason in the Status_Bar.

### Requirement 6: Save As

**User Story:** As a user, I want to save the Buffer to a new file path, so that I can create new files or copies.

#### Acceptance Criteria

1. WHEN the user invokes the Save As action, THE LLIMEdit SHALL display a native save dialog with the suggested filename's extension set to the current file's extension if one is associated with the Buffer, otherwise to `.txt`.
2. IF the user cancels the Save As dialog without confirming a path, THEN THE LLIMEdit SHALL leave the Buffer, the current file path, and the Status_Bar unchanged.
3. WHEN the user confirms a path in the Save As dialog, THE File_Service SHALL write the Buffer to that path encoded as UTF-8 using the line-ending style and byte-order mark preference recorded for the current file when such preferences exist.
4. WHEN the File_Service successfully writes the Buffer via Save As, THE LLIMEdit SHALL record the chosen absolute path as the current file path, retain the line-ending and byte-order mark preferences for that path, mark the Buffer as not a Dirty_Buffer, and update the Status_Bar to display the new path.
5. WHERE the Buffer had no previously detected line-ending style, THE File_Service SHALL write line endings using the OS default (`\n` on macOS, `\r\n` on Windows) and SHALL NOT prepend a byte-order mark.
6. IF the File_Service fails to write the Buffer via Save As, THEN THE LLIMEdit SHALL leave the current file path unchanged, leave the Buffer marked as a Dirty_Buffer, and display the failure reason in the Status_Bar.

### Requirement 7: Quit and Unsaved-Changes Protection

**User Story:** As a user, I want LLIMEdit to warn me before discarding unsaved changes, so that I do not lose work.

#### Acceptance Criteria

1. WHEN the user invokes the Quit action and the Buffer is a Dirty_Buffer, THE LLIMEdit SHALL display a modal prompt with three labeled buttons (Save, Discard, Cancel) and SHALL block process exit until the user selects one of those buttons.
2. WHEN the user attempts to close the application window and the Buffer is a Dirty_Buffer, THE LLIMEdit SHALL display the same modal prompt with Save, Discard, and Cancel buttons and SHALL block window closure until the user selects one of those buttons.
3. WHEN the user invokes the Quit action or attempts to close the application window and the Buffer is not a Dirty_Buffer, THE LLIMEdit SHALL proceed with the requested exit without displaying the unsaved-changes prompt.
4. WHEN the user selects Save in the unsaved-changes prompt, THE LLIMEdit SHALL invoke the Save File action.
5. WHEN the Save File action invoked from the unsaved-changes prompt completes successfully, THE LLIMEdit SHALL proceed with the original Quit or window-close action.
6. IF the Save File action invoked from the unsaved-changes prompt fails or the user cancels the Save As dialog that it triggers, THEN THE LLIMEdit SHALL abort the original Quit or window-close action, leave the Buffer marked as a Dirty_Buffer, and display the failure reason in the Status_Bar.
7. WHEN the user selects Discard in the unsaved-changes prompt, THE LLIMEdit SHALL proceed with the original Quit or window-close action without writing the Buffer.
8. WHEN the user selects Cancel in the unsaved-changes prompt, THE LLIMEdit SHALL abort the original Quit or window-close action and leave the Buffer unchanged.

### Requirement 8: Editor Buffer and Edit Operations

**User Story:** As a user, I want to type, edit, undo, redo, cut, copy, and paste in the Editor, so that I can compose and modify text.

#### Acceptance Criteria

1. WHILE no Stream is active, WHEN the user types a printable character or presses a text-modifying key in the Editor, THE Editor SHALL update the Buffer to reflect the change before the next user input event is processed.
2. WHILE no Stream is active, WHEN the user invokes Undo or Redo, THE Editor SHALL update the Buffer, the Undo_Stack, and the Redo_Stack per the semantics defined in Requirement 18.
3. WHILE no Stream is active, WHEN the user invokes Cut or Copy with a selection of one or more Unicode code points, THE Editor SHALL apply the host platform's default clipboard behavior using the current selection.
4. WHILE no Stream is active, IF the user invokes Cut or Copy with a zero-length selection, THEN THE Editor SHALL leave the Buffer and the system clipboard unchanged.
5. WHILE no Stream is active, WHEN the user invokes Paste, THE Editor SHALL apply the host platform's default paste behavior, replacing the current selection with the clipboard text content if a selection exists, otherwise inserting the clipboard text content at the cursor position.
6. IF the contents of the Buffer differ from the last loaded or saved file contents, or the Buffer has never been saved and contains any text, THEN THE LLIMEdit SHALL mark the Buffer as a Dirty_Buffer.
7. WHEN the contents of the Buffer once again match the last loaded or saved file contents (for example, after Undo), THE LLIMEdit SHALL mark the Buffer as not a Dirty_Buffer.
8. WHEN the contents of the Buffer change, THE Status_Bar SHALL update the displayed character count to match the current Buffer length in Unicode code points before the next user input event is processed.

### Requirement 9: Status Bar

**User Story:** As a user, I want a status bar showing the current file, size, and active model, so that I have context at a glance.

#### Acceptance Criteria

1. WHILE the Buffer is associated with a file path, THE Status_Bar SHALL display that absolute file path.
2. WHILE the Buffer is not associated with any file path, THE Status_Bar SHALL display the literal text "Untitled".
3. THE Status_Bar SHALL display the current character count of the Buffer expressed in Unicode code points as a non-negative integer.
4. THE Status_Bar SHALL display the value of the `model` field from the current settings, or the literal text "(no model)" if that value is an empty string.
5. WHEN the Settings_Service successfully writes updated settings via the Settings_Modal Save action, THE Status_Bar SHALL update the displayed model name to match the new `model` value within 200 milliseconds of the write completing.
6. WHILE the Buffer is a Dirty_Buffer, THE Status_Bar SHALL display the asterisk character `*` immediately preceding the file path or the "Untitled" text, with no intervening characters.
7. WHILE the Buffer is not a Dirty_Buffer, THE Status_Bar SHALL NOT display the asterisk character `*` preceding the file path or the "Untitled" text.

### Requirement 10: Settings Storage and Defaults

**User Story:** As a user, I want my settings to persist across launches, so that I do not have to reconfigure the app every time.

#### Acceptance Criteria

1. THE Settings_Service SHALL persist settings as a single JSON file named `settings.json` located in the OS_Config_Dir.
2. THE Settings_Service SHALL define settings fields: `api_url` (string, 1 to 2048 characters), `model` (string, 1 to 256 characters), `temperature` (number in the closed interval [0.0, 2.0]), `max_tokens` (positive integer between 1 and 1,048,576), `replace_mode` (string), `system_prompt` (string, 0 to 32,768 characters).
3. THE Settings_Service SHALL accept the values `insert_at_cursor`, `replace_selection`, and `replace_document` as the only valid values for `replace_mode`.
4. WHEN LLIMEdit is launched and the settings file does not exist, THE Settings_Service SHALL create the OS_Config_Dir if it is absent and create `settings.json` populated with the default values: `api_url` = `"http://localhost:1234/v1/chat/completions"`, `model` = `"local-model"`, `temperature` = `0.2`, `max_tokens` = `2048`, `replace_mode` = `"replace_document"`, `system_prompt` = `""`.
5. IF the settings file exists but cannot be parsed as JSON, OR the parsed JSON contains a value for any field defined in criterion 2 whose type or value falls outside the bounds and allowed values specified in criteria 2 and 3, THEN THE Settings_Service SHALL load the default values for the entire settings set in memory, leave the existing file untouched on disk, and display a warning message in the Status_Bar indicating that settings could not be loaded and defaults are in use.
6. WHEN the settings file is parsed successfully and one or more fields defined in criterion 2 are absent from the parsed object, THE Settings_Service SHALL substitute the default value defined in criterion 4 for each absent field while preserving the values of fields that are present and valid.
7. IF the Settings_Service fails to create or write `settings.json` due to a filesystem error, THEN THE Settings_Service SHALL retain the default settings in memory for the current session and display the failure reason in the Status_Bar.
8. THE Settings_Service SHALL provide a serialize-then-parse round-trip such that for any valid Settings value, parsing the serialized form SHALL produce a Settings value equal to the original.

### Requirement 11: Settings Modal

**User Story:** As a user, I want to edit my settings through a modal, so that I can change the endpoint, model, and generation parameters.

#### Acceptance Criteria

1. WHEN the user selects AI → Settings, THE LLIMEdit SHALL display the Settings_Modal with each input pre-populated with the corresponding current value loaded from the Settings_Service.
2. THE Settings_Modal SHALL provide editable text inputs for `api_url`, `model`, and `system_prompt`, numeric inputs for `temperature` and `max_tokens`, a selector for `replace_mode` restricted to the values `insert_at_cursor`, `replace_selection`, and `replace_document`, a Save button, and a Cancel button.
3. WHEN the user clicks Save in the Settings_Modal and all fields pass validation, THE Settings_Service SHALL write the updated settings to the Settings_Store and the Settings_Modal SHALL close.
4. IF the user enters a value for `temperature` that is not a number or that lies outside the closed interval [0.0, 2.0], THEN THE Settings_Modal SHALL display an inline validation error adjacent to the `temperature` field and SHALL NOT save.
5. IF the user enters a value for `max_tokens` that is not an integer in the closed interval [1, 1000000], THEN THE Settings_Modal SHALL display an inline validation error adjacent to the `max_tokens` field and SHALL NOT save.
6. IF the user enters a value for `api_url` that is not a syntactically valid absolute URL with scheme `http` or `https`, THEN THE Settings_Modal SHALL display an inline validation error adjacent to the `api_url` field and SHALL NOT save.
7. IF the user enters an empty string for `model`, THEN THE Settings_Modal SHALL display an inline validation error adjacent to the `model` field and SHALL NOT save.
8. WHEN the user clicks Cancel in the Settings_Modal or presses the Escape key while the Settings_Modal is open, THE Settings_Modal SHALL close without writing to the Settings_Store and SHALL discard any in-modal edits.
9. IF the Settings_Service fails to write the updated settings to the Settings_Store, THEN THE Settings_Modal SHALL remain open, SHALL display an error message indicating the failure, and the prior values in the Settings_Store SHALL remain unchanged.

### Requirement 12: Send to Model

**User Story:** As a user, I want to send the document or my selection to LM Studio, so that the model can help me modify or extend my text.

#### Acceptance Criteria

1. WHEN the user invokes the Send to Model action and a non-empty selection exists in the Editor, THE LLM_Client SHALL append to the request `messages` array an entry with `role` set to `"user"` and `content` set to the exact selected text.
2. WHEN the user invokes the Send to Model action and no selection exists in the Editor, THE LLM_Client SHALL append to the request `messages` array an entry with `role` set to `"user"` and `content` set to the entire current Buffer contents.
3. IF the Send to Model action is invoked when the resolved user-message `content` (per criteria 1 and 2) has length zero in Unicode code points, THEN THE LLIMEdit SHALL display the literal text "Nothing to send" in the Status_Bar and SHALL NOT open a connection to the LM_Studio_Endpoint.
4. WHEN the LLM_Client sends a request, THE LLM_Client SHALL POST to the `api_url` from the current settings a JSON body containing `model` set to the current settings `model` value, `messages` set to the constructed messages array, `temperature` set to the current settings `temperature` value, `max_tokens` set to the current settings `max_tokens` value, and `stream` set to `true`.
5. WHERE the current settings `system_prompt` value has length greater than zero in Unicode code points, THE LLM_Client SHALL prepend to the request `messages` array a single entry with `role` set to `"system"` and `content` set to the `system_prompt` value, positioned before the user-message entry.
6. WHILE a Stream is active, THE LLIMEdit SHALL reject all keyboard and paste input that would modify the Buffer and SHALL display in the Status_Bar a visible indicator that a Stream is in progress.
7. WHILE a Stream is active, WHEN the user invokes the Send to Model action, THE LLIMEdit SHALL discard the new invocation without sending an additional HTTP request and SHALL display the literal text "A request is already in progress" in the Status_Bar.

### Requirement 13: Streaming Response Handling

**User Story:** As a user, I want streamed tokens to appear in the editor as they arrive, so that I get fast feedback.

#### Acceptance Criteria

1. WHEN the LM_Studio_Endpoint returns a streaming response, THE LLM_Client SHALL emit one `tauri://llm-token` event for each non-empty assistant text fragment parsed from the response, in the order the fragments are received, with the fragment text as the event payload.
2. WHEN a `tauri://llm-token` event is received and the active `replace_mode` is `insert_at_cursor`, THE Editor SHALL insert the event payload at the cursor position recorded when the Stream began and advance that recorded position by the number of Unicode code points in the payload.
3. WHEN a `tauri://llm-token` event is received and the active `replace_mode` is `replace_selection`, THE Editor SHALL on the first token replace the selection captured at Stream start with the event payload, or, if that selection was empty, insert the event payload at the cursor position captured at Stream start, and on each subsequent token append the event payload immediately after the text inserted from the previous token.
4. WHEN a `tauri://llm-token` event is received and the active `replace_mode` is `replace_document`, THE Editor SHALL on the first token replace the entire Buffer with the event payload, and on each subsequent token append the event payload to the end of the Buffer.
5. WHEN the LM_Studio_Endpoint signals end of stream, THE LLM_Client SHALL emit a `tauri://llm-complete` event with no error reason within 1 second of receiving the end-of-stream signal.
6. WHEN a `tauri://llm-complete` event with no error reason is received, THE LLIMEdit SHALL restore the Editor to writable.
7. WHEN the user presses the Escape key while a Stream is active, THE LLM_Client SHALL close the underlying HTTP connection and emit a `tauri://llm-complete` event within 1 second of the keypress, and THE Editor SHALL retain all token payloads already applied to the Buffer.
8. WHILE a Stream is active, THE LLM_Client SHALL maintain at most one in-flight HTTP request to the LM_Studio_Endpoint.
9. WHEN a Stream begins, THE Editor SHALL begin a single Edit_Group that accumulates every Buffer mutation produced by `tauri://llm-token` events received during that Stream regardless of the active `replace_mode`, and WHEN that Stream terminates by the end-of-stream signal per criterion 5, by user cancellation per criterion 7, or by any error reason defined in Requirement 14, THE Editor SHALL push that Edit_Group onto the Undo_Stack as a single entry.

### Requirement 14: LM Studio Error Handling

**User Story:** As a user, I want clear, non-destructive feedback when LM Studio is unreachable or returns an error, so that I do not lose work or get stuck.

#### Acceptance Criteria

1. IF the LLM_Client cannot establish a TCP connection to the LM_Studio_Endpoint within 5 seconds of initiating the request, THEN THE LLM_Client SHALL abort the request and emit a `tauri://llm-complete` event whose error reason equals the literal string "connection failed".
2. WHILE a Stream is active, IF the LM_Studio_Endpoint sends no bytes for 60 consecutive seconds, THEN THE LLM_Client SHALL close the underlying HTTP connection and emit a `tauri://llm-complete` event whose error reason equals the literal string "stream timed out".
3. IF the LM_Studio_Endpoint returns an HTTP status code other than 200, THEN THE LLM_Client SHALL abort the request and emit a `tauri://llm-complete` event whose error reason is a string that includes the decimal representation of the returned HTTP status code.
4. IF the LM_Studio_Endpoint returns a response body that the LLM_Client cannot parse as the streaming chat-completions format consumed in Requirement 13, THEN THE LLM_Client SHALL abort the request and emit a `tauri://llm-complete` event whose error reason equals the literal string "invalid response".
5. WHILE a Stream is active, IF the underlying HTTP connection to the LM_Studio_Endpoint closes or is reset before the end-of-stream signal has been received and no other criterion in this requirement applies, THEN THE LLM_Client SHALL emit a `tauri://llm-complete` event whose error reason equals the literal string "connection lost".
6. WHEN a `tauri://llm-complete` event is emitted with a non-empty error reason, THE LLIMEdit SHALL display the error reason text verbatim in the Status_Bar, mark the Stream as no longer active so that subsequent Send to Model invocations are accepted, and restore the Editor to writable.
7. IF any error covered by criteria 1 through 5 occurs after one or more tokens have already been inserted into the Buffer during the current Stream, THEN THE LLIMEdit SHALL retain those tokens in the Buffer and SHALL NOT revert the Buffer to its pre-Stream contents.

### Requirement 15: Backend Tauri Commands

**User Story:** As a frontend developer, I want a stable set of backend commands, so that I can drive file and LLM operations from JavaScript.

#### Acceptance Criteria

1. THE Backend SHALL expose a Tauri command `open_file(path: String) -> Result<String, String>` that on success returns Ok with the UTF-8 decoded file contents, and on failure returns Err with a non-empty human-readable error string identifying the cause (for example, file not found, permission denied, or invalid UTF-8).
2. THE Backend SHALL expose a Tauri command `save_file(path: String, contents: String) -> Result<(), String>` that on success returns Ok after writing the contents as UTF-8 and flushing the bytes to the operating system, and on failure returns Err with a non-empty human-readable error string and SHALL leave no partially written file at the target path.
3. THE Backend SHALL expose a Tauri command `call_llm(text: String, settings: Settings) -> Result<String, String>` that on success returns Ok with the assistant message content from a non-streaming chat completion, and on failure returns Err with a non-empty human-readable error string identifying the cause.
4. THE Backend SHALL expose a Tauri command `stream_llm(text: String, settings: Settings) -> Result<(), String>` that initiates a Stream and returns within 200 milliseconds of invocation, with subsequent tokens delivered via `tauri://llm-token` events and exactly one terminal `tauri://llm-complete` event signaling completion or error per Requirements 13 and 14.
5. THE Backend SHALL expose a Tauri command `load_settings() -> Result<Settings, String>` that on success returns Ok with the current Settings, and on failure returns Err with a non-empty human-readable error string.
6. THE Backend SHALL expose a Tauri command `save_settings(settings: Settings) -> Result<(), String>` that on success persists the Settings via the Settings_Service and returns Ok, and on failure returns Err with a non-empty human-readable error string.
7. IF any Backend command receives a `path` argument that is not an absolute path for the host operating system, is empty, or contains a null byte, THEN THE Backend SHALL return Err with a non-empty human-readable error string and SHALL NOT perform any file I/O.
8. WHILE a Stream is active, IF `stream_llm` is invoked, THEN THE Backend SHALL return Err with a non-empty human-readable error string indicating that a Stream is already active and SHALL NOT initiate a second Stream.

### Requirement 16: Frontend JavaScript API

**User Story:** As a frontend developer, I want a small set of JavaScript functions and Tauri events, so that the UI logic stays simple.

#### Acceptance Criteria

1. THE Editor SHALL expose globally accessible JavaScript functions `openFile()`, `saveFile()`, `saveFileAs()`, `sendToLLM()`, `applyLLMResponse(mode)`, `loadSettings()`, and `saveSettings()`, where invoking each function SHALL trigger the same action defined for its name in the corresponding requirement (Open File per Requirement 4, Save File per Requirement 5, Save As per Requirement 6, Send to Model per Requirement 12, applying an LLM response per the supplied Insertion_Mode per Requirement 13, loading settings per Requirement 10, and saving settings per Requirement 11).
2. THE Editor SHALL register handlers for the Tauri events `tauri://file-opened`, `tauri://llm-token`, and `tauri://llm-complete` such that the `tauri://file-opened` handler replaces the Buffer with the event payload contents and updates the Status_Bar per Requirement 4, the `tauri://llm-token` handler invokes `applyLLMResponse(mode)` using the `replace_mode` recorded at Stream start per Requirement 13, and the `tauri://llm-complete` handler restores the Editor to writable and surfaces any error reason in the Status_Bar per Requirements 13 and 14.
3. IF `applyLLMResponse(mode)` is called with a `mode` argument whose value is not exactly one of the strings `insert_at_cursor`, `replace_selection`, or `replace_document`, THEN THE Editor SHALL synchronously throw a JavaScript Error indicating an invalid Insertion_Mode before performing any Buffer modification or Backend invocation, and SHALL leave the Buffer unchanged.

### Requirement 17: v0.1 Non-Goals

**User Story:** As a maintainer, I want v0.1 to stay narrow, so that the product ships fast and remains lightweight.

#### Acceptance Criteria

1. THE LLIMEdit SHALL NOT display tabs, split views, or any UI element that exposes more than one Buffer concurrently, and SHALL maintain exactly one Editor and exactly one Buffer at all times.
2. THE LLIMEdit SHALL NOT apply colorization, bold, italic, or underline styling to Buffer contents based on parsed file syntax, and SHALL render all Buffer contents in a single uniform text style.
3. THE LLIMEdit SHALL NOT provide any user-facing control, menu item, or Settings_Modal field that configures application colors, fonts, or other visual themes.
4. THE LLIMEdit SHALL NOT load, register, discover, or execute any third-party code at runtime through a plugin mechanism, and SHALL NOT expose any Backend command or UI surface for installing plugins.
5. THE LLIMEdit SHALL NOT write the Buffer to disk on any trigger other than a user-invoked Save or Save As action, including but not limited to timer-based, idle-based, focus-change-based, or interval-based triggers.
6. THE LLIMEdit SHALL NOT render Markdown, HTML, or any other formatted preview of the Buffer, and SHALL render the Buffer as plain text only.
7. THE LLIMEdit SHALL NOT provide any UI control that toggles a preview view or alternative rendering mode for the Buffer.

### Requirement 18: Undo and Redo Stack

**User Story:** As a user, I want a predictable Undo and Redo behavior that treats a streamed LLM response as a single step, so that I can revert or restore an entire model response with one keystroke and so that the editor's history does not drift from what I see on screen.

#### Acceptance Criteria

1. THE Editor SHALL maintain an in-memory Undo_Stack of Edit_Groups and an in-memory Redo_Stack of Edit_Groups, both initialized to empty when LLIMEdit is launched.
2. WHILE no Stream is active, WHEN the user types a printable character keystroke in the Editor and the most recent Edit_Group on the Undo_Stack was produced by typed-input keystrokes, the time elapsed since the previous keystroke applied to that Edit_Group is less than or equal to 1000 milliseconds, the Editor cursor position has not been moved between that previous keystroke and the current keystroke by any cursor-moving input (including arrow keys, Home, End, Page Up, Page Down, mouse click, or programmatic selection change), and the current keystroke is not the Enter key, THE Editor SHALL append the resulting Buffer mutation to that most recent Edit_Group.
3. WHILE no Stream is active, WHEN the user types a printable character keystroke in the Editor and the conditions in criterion 2 are not all satisfied, THE Editor SHALL begin a new Edit_Group on the Undo_Stack containing the resulting Buffer mutation.
4. WHILE no Stream is active, WHEN the user presses the Enter key in the Editor, THE Editor SHALL begin a new Edit_Group on the Undo_Stack containing the resulting Buffer mutation, and any subsequent typed-input keystroke SHALL be evaluated against criterion 2 against this new Edit_Group rather than any earlier Edit_Group.
5. WHILE no Stream is active, WHEN the user invokes Paste and the Editor applies the clipboard text content to the Buffer per Requirement 8 criterion 5, THE Editor SHALL push a single Edit_Group onto the Undo_Stack containing exactly the Buffer mutation produced by that paste invocation.
6. WHILE no Stream is active, WHEN the user invokes Cut on a non-zero-length selection per Requirement 8 criterion 3, THE Editor SHALL push a single Edit_Group onto the Undo_Stack containing exactly the Buffer mutation that removed the selected text.
7. WHEN a Stream begins, THE Editor SHALL allocate a single Edit_Group dedicated to that Stream, and every Buffer mutation produced by a `tauri://llm-token` event received during that Stream SHALL be appended to that Edit_Group regardless of the active `replace_mode`.
8. WHEN a Stream terminates by the end-of-stream signal defined in Requirement 13 criterion 5, THE Editor SHALL push the Stream's Edit_Group onto the Undo_Stack as a single entry such that one subsequent Undo invocation reverts every Buffer mutation produced during that Stream.
9. WHEN a Stream terminates by user cancellation as defined in Requirement 13 criterion 7, THE Editor SHALL push the Stream's Edit_Group onto the Undo_Stack as a single entry containing the Buffer mutations produced by every `tauri://llm-token` event received before the cancellation, such that one subsequent Undo invocation reverts every Buffer mutation produced before the cancellation.
10. WHEN a Stream terminates by any error reason defined in Requirement 14 and one or more `tauri://llm-token` events were received during that Stream, THE Editor SHALL push the Stream's Edit_Group onto the Undo_Stack as a single entry such that one subsequent Undo invocation reverts every Buffer mutation produced before the error.
11. WHILE no Stream is active, WHEN the user invokes Undo and the Undo_Stack contains at least one Edit_Group, THE Editor SHALL remove the topmost Edit_Group from the Undo_Stack, revert every Buffer mutation in that Edit_Group in reverse order so that the Buffer matches the state immediately before the Edit_Group was applied, and push that Edit_Group onto the Redo_Stack.
12. WHILE no Stream is active, IF the user invokes Undo and the Undo_Stack is empty, THEN THE Editor SHALL leave the Buffer, the Undo_Stack, and the Redo_Stack unchanged.
13. WHILE no Stream is active, WHEN the user invokes Redo and the Redo_Stack contains at least one Edit_Group, THE Editor SHALL remove the topmost Edit_Group from the Redo_Stack, reapply every Buffer mutation in that Edit_Group in original order, and push that Edit_Group onto the Undo_Stack.
14. WHILE no Stream is active, IF the user invokes Redo and the Redo_Stack is empty, THEN THE Editor SHALL leave the Buffer, the Undo_Stack, and the Redo_Stack unchanged.
15. WHEN the Editor pushes a new Edit_Group onto the Undo_Stack from any source other than Redo (including typed-input grouping per criteria 2 through 4, Paste per criterion 5, Cut per criterion 6, or Stream completion per criteria 8 through 10), THE Editor SHALL clear the Redo_Stack of all entries.
16. WHEN the File_Service successfully reads a selected file via the Open File action and the Editor replaces the Buffer per Requirement 4 criterion 4, THE Editor SHALL clear the Undo_Stack of all entries and clear the Redo_Stack of all entries.
17. WHEN the user invokes the Save File action per Requirement 5 or the Save As action per Requirement 6, THE Editor SHALL leave the Undo_Stack and the Redo_Stack unchanged regardless of whether the underlying File_Service write succeeds or fails.
18. THE Editor SHALL bound the Undo_Stack to a maximum capacity of 200 Edit_Groups and SHALL bound the Redo_Stack to a maximum capacity of 200 Edit_Groups.
19. WHEN the Editor would push a new Edit_Group onto the Undo_Stack and the Undo_Stack already contains 200 Edit_Groups, THE Editor SHALL remove the oldest (bottom-most) Edit_Group from the Undo_Stack before pushing the new Edit_Group such that the resulting Undo_Stack contains exactly 200 Edit_Groups.
20. WHEN the Editor would push a new Edit_Group onto the Redo_Stack via Undo per criterion 11 and the Redo_Stack already contains 200 Edit_Groups, THE Editor SHALL remove the oldest (bottom-most) Edit_Group from the Redo_Stack before pushing the new Edit_Group such that the resulting Redo_Stack contains exactly 200 Edit_Groups.
21. WHILE a Stream is active, IF the user invokes Undo or Redo, THEN THE Editor SHALL leave the Buffer, the Undo_Stack, and the Redo_Stack unchanged, consistent with the read-only behavior defined in Requirement 12 criterion 6.

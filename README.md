# **📘 Project Spec: LLIMEdit (v0.1)**  
*A minimal cross‑platform text editor with LM Studio integration.*

---

## **1. Purpose**
Create a **super lightweight**, **open‑source**, **cross‑platform** (Windows/macOS) text editor that:

- Opens and saves plain text files (`.txt`, `.md`, `.yaml`, `.pencil`, etc.)
- Sends the current document (or selection) to LM Studio via OpenAI‑compatible API
- Receives and inserts/overwrites text from the model
- Has zero heavy dependencies, zero bundlers, and minimal build times

![SCREENSHOT](./docs/screenshot.jpg)

---

## **2. Tech Stack**
### **Primary Framework**
**Tauri (Rust backend + HTML/CSS/JS frontend)**  
- MIT/Apache licensed  
- Tiny binary footprint  
- Fast builds  
- No Electron, no Chromium bundle  
- UI can be pure HTML/CSS/JS (no React/Vite/etc.)

### **Backend Language**
**Rust**  
- Handles file I/O  
- Handles LM Studio API calls  
- Exposes commands to the frontend  

### **Frontend**
**Vanilla HTML + Vanilla JS**  
- Single window  
- Single `<textarea>` or `<div contenteditable>`  
- Optional: CodeMirror (if syntax highlighting needed later)

---

## **3. Core Features (v0.1)**

### **3.1 File Operations**
- **Open File**
  - Native file picker
  - Load file contents into editor
- **Save File**
  - Save current editor contents to disk
- **Save As**
  - Save to new path

### **3.2 Editor**
- Single text buffer
- Basic keyboard shortcuts:
  - `Ctrl/Cmd + O` → Open
  - `Ctrl/Cmd + S` → Save
  - `Ctrl/Cmd + Shift + S` → Save As
  - `Ctrl/Cmd + L` → Send to LLM

### **3.3 LM Studio Integration**
- Configurable API endpoint (default: `http://localhost:1234/v1/chat/completions`)
- Configurable model name
- Two modes:
  1. **Send entire document**
  2. **Send selected text only**
- Streaming response (append to editor as tokens arrive)
- Replace or insert modes:
  - Replace selection
  - Insert at cursor
  - Replace entire document

### **3.4 Settings**
- Stored in a small JSON file
- Fields:
  - `api_url`
  - `model`
  - `temperature`
  - `max_tokens`
  - `replace_mode` (insert/replace)

---

## **4. UI Layout (v0.1)**

### **Window**
- Title bar: “LLIMEdit”
- Menu bar:
  - File → Open, Save, Save As, Quit
  - Edit → Undo, Redo, Cut, Copy, Paste
  - AI → Send to Model, Settings
  - Help → About

### **Main Area**
- Full‑window text editor
- Status bar (bottom):
  - File path
  - Character count
  - Model name

### **Settings Modal**
- Text inputs for:
  - API URL
  - Model name
  - Temperature
  - Max tokens
- Save button

---

## **5. Backend API (Rust)**

### **Commands**
#### `open_file(path: String) -> String`
Reads file contents.

#### `save_file(path: String, contents: String)`
Writes file contents.

#### `call_llm(text: String, settings: Settings) -> String`
Sends text to LM Studio and returns model output.

#### `stream_llm(text: String, settings: Settings)`
Streams tokens back to frontend via Tauri event.

---

## **6. Frontend API (JS)**

### **Functions**
- `openFile()`
- `saveFile()`
- `saveFileAs()`
- `sendToLLM()`
- `applyLLMResponse(mode)`
- `loadSettings()`
- `saveSettings()`

### **Events**
- `tauri://file-opened`
- `tauri://llm-token`
- `tauri://llm-complete`

---

## **7. Data Structures**

### **Settings**
```json
{
  "api_url": "http://localhost:1234/v1/chat/completions",
  "model": "local-model",
  "temperature": 0.2,
  "max_tokens": 2048,
  "replace_mode": "replace"
}
```

### **LLM Request Body**
```json
{
  "model": "local-model",
  "messages": [
    { "role": "user", "content": "<text>" }
  ],
  "temperature": 0.2,
  "max_tokens": 2048,
  "stream": true
}
```

---

## **8. Non‑Goals (v0.1)**
These are explicitly *not* included in the first build:

- Tabs
- Multiple documents
- Syntax highlighting
- Themes
- Plugins
- Autosave
- Undo history beyond browser default
- Rich text
- Markdown preview

These can be added in v0.2+.

---

## **9. Build & Packaging**
- Tauri default build pipeline
- Output:
  - macOS `.app`
  - Windows `.exe`
- No installers required for v0.1

---

## **Development**

### Prerequisites

- **Rust** (1.77.2+) — install via [rustup](https://rustup.rs/)
- **Node.js** (18+) and **npm** — for the frontend test suite
- **Tauri CLI** (optional, for `cargo tauri dev` / `cargo tauri build`):
  ```bash
  cargo install tauri-cli
  ```
- Platform dependencies for Tauri 2.x (see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/))

### Setup

```bash
# Clone the repo
git clone https://github.com/your-org/LLMEditor.git
cd LLMEditor

# Install frontend test dependencies
npm install
```

### Run in development mode

```bash
cargo tauri dev
```

This launches the app with hot-reload for the frontend (`src/`) and recompiles the Rust backend on changes.

### Run tests

```bash
# Backend (Rust) — 127 tests
cargo test --manifest-path src-tauri/Cargo.toml

# Frontend (Vitest + jsdom) — unit tests
npm test

# Live LM Studio smoke tests (requires a running server + tool-capable model)
LLM_SMOKE=1 LLM_API_URL=http://10.0.1.5:1234/v1/chat/completions npm run test:smoke
```

Smoke tests exercise the real agent loop against LM Studio: tool calls (`replace_range`, `insert_text`, `delete_range`), the selection-centered context window on large files, and **Undo** after agent edits. They are skipped by default; set `LLM_SMOKE=1` to enable.

Optional env vars:

| Variable | Default | Purpose |
|----------|---------|---------|
| `LLM_API_URL` | `http://10.0.1.5:1234/v1/chat/completions` | LM Studio chat endpoint |
| `LLM_MODEL` | first loaded model | Model id override |
| `LLM_TEMPERATURE` | `0.1` | Lower = more deterministic smoke runs |
| `LLM_MAX_TOKENS` | `2048` | Max tokens per turn |
| `LLM_SMOKE_TIMEOUT_MS` | `120000` | Per-test timeout |

Use a model with native tool use (e.g. Qwen2.5-Instruct, Llama 3.1+).

### Build for release

```bash
cargo tauri build
```

Produces:
- macOS: `src-tauri/target/release/bundle/macos/LLIMEdit.app`
- Windows: `src-tauri/target/release/bundle/nsis/LLIMEdit_0.1.0_x64-setup.exe`

### Example system prompt

```json
{
  "name": "Romance Novel Author and Editor",
  "role": "An experienced romance novelist and editor with an excellent grasp of language, storytelling techniques, and the conventions of the romance genre. You are skilled at crafting engaging plots, memorable characters, and passionate love scenes. As an editor, you have a keen eye for detail, ensuring the manuscript is polished, structurally sound, and true to the author's unique voice.",
  "skills": [
    "Writing compelling romantic plots with clear character arcs",
    "Creating believable, relatable characters with depth and complexity",
    "Pacing romance novels effectively to build tension and emotional stakes",
    "Crafting sensual and steamy love scenes that are tasteful yet evocative",
    "Editing for grammar, spelling, punctuation, and consistency in style and tone",
    "Providing constructive feedback on plot development, character motivation, and overall story structure"
  ],
  "personality": [
    "Creative and imaginative with a knack for dreaming up captivating love stories",
    "Attentive to detail and committed to producing high-quality work",
    "Supportive and encouraging as both a writing partner and editor",
    "Understanding of the romance genre's conventions while open to unique twists"
  ],
  "style": {
    "formatting": "Markdown or JSON format for easy organization and reference of story elements",
    "preferred_genre": "Romance (various sub-genres such as historical, contemporary, paranormal)",
    "target_audience": "Adult romance readers seeking emotional depth, engaging characters, and satisfying love stories"
  },
  "capabilities": [
    "Drafting original romance novels or providing ghostwriting services",
    "Editing manuscripts for content, structure, grammar, and style",
    "Brainstorming story ideas, character profiles, and plot developments with authors",
    "Offering writing workshops or coaching sessions on the craft of romance novel writing"
  ]
}
```

### Project structure

```
LLMEditor/
├── Cargo.toml              # Workspace manifest (keeps Cargo.lock at root)
├── package.json            # Frontend test deps (vitest, fast-check, jsdom)
├── vitest.config.js        # Vitest configuration
├── src/                    # Frontend (vanilla HTML/CSS/JS, no bundler)
│   ├── index.html
│   ├── styles.css
│   ├── main.js             # Bootstrap + event wiring
│   ├── api.js              # Tauri invoke wrappers
│   ├── editor.js           # Buffer state, undo/redo, insertion modes
│   ├── status_bar.js       # Status bar rendering
│   ├── menu.js             # Menu bar + keyboard shortcuts
│   ├── settings_modal.js   # Settings modal + validation
│   └── __tests__/          # Vitest test files
├── src-tauri/              # Rust backend (Tauri 2.x)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs         # Binary entry point
│       ├── lib.rs          # Tauri builder + bootstrap
│       ├── commands.rs     # #[tauri::command] handlers
│       ├── settings.rs     # Settings struct + validation
│       ├── settings_service.rs  # Load/save from OS config dir
│       ├── file_service.rs # Read/write with BOM + line-ending handling
│       ├── llm_client.rs   # HTTP client + SSE parser + streaming
│       ├── state.rs        # AppState, StreamRegistry
│       ├── error.rs        # Error enums + Display impls
│       └── events.rs       # Event name constants + emit helpers
├── scripts/
│   ├── smoke.md            # End-to-end smoke test runbook
│   ├── smoke.sh            # CI smoke harness
│   └── fixtures/           # Test fixture files
└── .kiro/specs/            # Kiro spec documents
```

---

## **10. License**
- MIT License
- Public GitHub repo


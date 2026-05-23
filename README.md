# **📘 Project Spec: “FeatherEdit” (v0.1)**  
*A minimal cross‑platform text editor with LM Studio integration.*

---

## **1. Purpose**
Create a **super lightweight**, **open‑source**, **cross‑platform** (Windows/macOS) text editor that:

- Opens and saves plain text files (`.txt`, `.md`, `.yaml`, `.pencil`, etc.)
- Sends the current document (or selection) to LM Studio via OpenAI‑compatible API
- Receives and inserts/overwrites text from the model
- Has zero heavy dependencies, zero bundlers, and minimal build times

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
- Title bar: “FeatherEdit”
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

## **10. License**
- MIT License
- Public GitHub repo


# LLIMEdit — tool-use sandbox

A lightweight, cross-platform **Tauri** app for experimenting with **LM Studio tool calling** against a live plain-text document. Use it to prototype custom tools, tune system prompts, and watch multi-turn agent loops apply edits in real time.

![SCREENSHOT](./docs/screenshot.jpg)

---

## What it is

LLIMEdit is a **tool-use sandbox**, not a full IDE:

- **Document buffer** — open/save plain text, line numbers, selection-aware context for large files
- **Agent loop** — multi-turn chat with native `tool_calls` against LM Studio (OpenAI-compatible API)
- **Tool editor** — write your own tools in JavaScript with JSON schemas (`.lmtool` / `.lmtools` files)
- **Starter document tools** — [`default.lmtools`](default.lmtools) in this repo is a ready-made set of seven text-editing tools; load it when you want the agent to read and write the buffer
- **Starter system prompt** — [`default.prompt`](default.prompt) is a plain-text persona you can open in the inference panel when you want a sensible default assistant

The app ships with **no tools loaded** and **no prompt file open**. Until you load a tool file, the LLM sees an empty tool list and the agent cannot call anything. That keeps your sandbox isolated until you choose what to expose.

The main text buffer stays unstyled; **syntax highlighting** is enabled in the tool **Implementation (JS)** and **Schema (JSON)** panes only.

### Chat panel color codes

The chat column uses color-coded bubbles so you can scan a long agent run. Theme tokens are defined in [`src/styles.css`](src/styles.css) (`:root`).

| Bubble | Label | Border / accent | Meaning |
|--------|-------|-----------------|---------|
| **Your message** | Gray (`--text-muted`) | Neutral gray (`--border`) | What you typed in the chat input |
| **Your message (failed)** | Gray | **Red** (`#f14c4c`) | Send or API error; use **Retry** on the bubble |
| **Assistant** | Blue (`--accent`, `#569cd6`) | Blue solid | Final model reply (model id as the label) |
| **LLM input** | Blue | Blue solid | Full request context: system prompt, messages, settings |
| **Turn request** | Blue | Blue **dashed** | Outgoing payload for one agent turn (subset of LLM input) |
| **Model (tool turn)** | Yellow (`--warning`, `#dcdcaa`) | Yellow solid | Assistant text emitted *before* tool calls in that turn |
| **Tool call** | Yellow, `TOOL CALL` | **Amber left stripe** + warm tint | A tool the model is invoking; shows `name({...args})` and formatted arguments |
| **Tool result** | Teal (`--success`, `#4ec9b0`), `TOOL RESULT` | **Teal left stripe** | Tool finished successfully; invocation repeated at the top |
| **Tool failed** | Red, `TOOL FAILED` | **Red left stripe** | Tool returned `ok: false` or bad arguments — compare the invocation line to the error summary |
| **Reasoning** | Purple (`--reasoning`, `#c586c0`) | Purple (glows while streaming) | Model reasoning / thinking stream when enabled |

**Tool invocation line** — On tool call and tool result bubbles, a monospace block shows exactly what the model sent, e.g. `replace_line({"line":1,"text":"hello"})`. Invalid JSON is shown raw so you can spot malformed `tool_calls` without digging into logs.

**Other UI colors** (outside chat bubbles): `--danger` (`#f48771`) for destructive actions; status bar uses `--bg-status` (`#007acc`).

---

## Tech stack

| Layer | Choice |
|-------|--------|
| Shell | [Tauri 2](https://v2.tauri.app/) (Rust + HTML/CSS/JS) |
| UI | Vanilla JS — no bundler, no React |
| LLM | LM Studio `/v1/chat/completions` with tools |
| Tests | Vitest (frontend), `cargo test` (backend) |

---

## Quick start

### Prerequisites

- **Rust** 1.77.2+ — [rustup](https://rustup.rs/)
- **Node.js** 18+ and **npm** — frontend tests
- **Tauri CLI** (optional): `cargo install tauri-cli`
- Platform deps: [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

### Setup and run

```bash
git clone https://github.com/your-org/LLMEditor.git
cd LLMEditor
npm install
npm run dev
```

`npm run dev` kills stale dev processes, starts a Python static server for `src/` on port 1420, then launches Tauri pointed at `http://127.0.0.1:1420`. If the window is blank or you see a port-bind error, run `npm run dev:clean` first, then `npm run dev` again.

Point **Settings → API URL** at your LM Studio server (default `http://localhost:1234/v1/chat/completions`). Use a model with native tool use (e.g. Qwen2.5-Instruct, Llama 3.1+).

### Load the starter tools

1. In the tool editor pane, click **Load**.
2. Open [`default.lmtools`](default.lmtools) from this repo (same folder as `README.md`).
3. Confirm the schema status shows **✓ 7 tools** and the implementation pane contains the shared `run` dispatcher.

You can read and edit `default.lmtools` like any other tool file — it is not bundled into the app. Save a copy under another name if you want to experiment without changing the original.

### Load the starter system prompt

1. In the inference panel (between chat and the document), find the **Prompt file** bar above the system prompt textarea.
2. Click **Open** and choose [`default.prompt`](default.prompt) from this repo.
3. The textarea fills with the starter instructions; tweak them if you like, then **Save** or **Save as…** to write a copy.

Like `default.lmtools`, `default.prompt` is not bundled — you open it from the repo when you want it.

### Tests

```bash
# Rust backend
cargo test --manifest-path src-tauri/Cargo.toml

# Frontend unit tests
npm test

# Live LM Studio smoke tests (optional)
LLM_SMOKE=1 LLM_API_URL=http://localhost:1234/v1/chat/completions npm run test:smoke
```

---

## Tool files

### `default.lmtools` (starter set, not bundled)

[`default.lmtools`](default.lmtools) lives at the **repository root** as a separate file. The app does **not** load it automatically — you open it with **Load** in the tool editor when you want document-editing tools.

It contains seven OpenAI-style function schemas plus one JavaScript implementation that dispatches to the host `editorTools` runtime:

```javascript
/**
 * Default document tools for LLIMEdit.
 * Load this file in the tool editor (Load → default.lmtools) to give the agent
 * read/write access to the document buffer.
 */
async function run(args, ctx) {
  const name = ctx.toolName;
  if (!name || typeof ctx.editorTools?.executeTool !== "function") {
    return { ok: false, error: "Missing toolName or editorTools", changed: false };
  }
  return ctx.editorTools.executeTool(name, args, ctx);
}
```

Tool names: `get_document`, `goto_line`, `insert_text`, `replace_line`, `replace_span`, `delete_lines`, `delete_span`.

See [`default.lmtools`](default.lmtools) for the full schema array.

### `.lmtool` / `.lmtools` (your custom tools)

Save your own tools from the tool editor bar (**Load** / **Save** / **Save as…**):

```json
{
  "version": 1,
  "implementation": "async function run(args, ctx) {\n  const input = String(args.input ?? '');\n  return { ok: true, result: input.toUpperCase(), changed: false };\n}",
  "schema": {
    "type": "function",
    "function": {
      "name": "shout",
      "description": "Return the input string in upper case.",
      "parameters": {
        "type": "object",
        "properties": {
          "input": { "type": "string", "description": "Text to transform" }
        },
        "required": ["input"],
        "additionalProperties": false
      }
    }
  }
}
```

- **`implementation`** — must define `async function run(args, ctx)`. `ctx` includes `text`, `path`, `contextAnchor`, and `toolName` (the function the model called).
- **`schema`** — a single tool object or an array of tools. Tool names must be unique within the file.
- Set `changed: true` and return `new_text` when mutating the document (same contract as the document edit tools in `default.lmtools`).

---

## System prompt

The **system prompt** lives in the inference panel textarea. Use **Open** / **Save** / **Save as…** on the **Prompt file** bar to work with `.prompt` files (plain text). Your text is also persisted in app settings when you edit the textarea.

[`default.prompt`](default.prompt) is the repo starter — a general LLIMEdit writing-assistant persona. Open it from the inference panel when you are learning the app; fork it under another name to experiment.

Whatever you type is prepended (when non-empty) to a built-in block in [`src/agent.js`](src/agent.js) (`DEFAULT_TOOL_SYSTEM`) that explains line numbers, `>>` selection markers, and that edits must go through tool calls.

Tips:

- **Steer persona and policy** in your prompt; the exact tool names come from whatever file you loaded in the tool editor.
- **Prefer plain text or Markdown** for behavioural guidance.
- **Do not** instruct the model to emit JSON tool calls in `content`; use native `tool_calls`.

### `default.prompt` (starter, not bundled)

```text
You are LLIMEdit, a helpful writing assistant.

You work inside a plain-text document editor. When the user asks you to change the document,
use the tools loaded in the tool editor — do not paste replacement text into chat as a
substitute for tool calls.
…
```

See [`default.prompt`](default.prompt) for the full starter text.

---

## Project layout

```
LLMEditor/
├── default.lmtools          # Starter document tools (load via tool editor)
├── default.prompt           # Starter system prompt (open via inference panel)
├── src/
│   ├── tool_editor.js       # .lmtool editor + tool execution
│   ├── tool_code_highlight.js
│   ├── agent.js             # Multi-turn agent loop
│   ├── editor_tools.js      # Document edit primitives
│   └── ...
├── src-tauri/               # Rust: file I/O, LM HTTP, tool validation
└── package.json             # Vitest dev deps
```

---

## Build release

```bash
cargo tauri build
```

Outputs under `src-tauri/target/release/bundle/` (macOS `.app`, Windows installer).

---

## License

MIT — see [LICENSE](LICENSE).

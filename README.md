# LLMEditor

A lightweight Rust + Tauri text editor with a split view:
- **Left pane**: LLM chat UI with API address, refreshable model list (checkboxes), context indicator, and prompt anchored at the bottom.
- **Right pane**: Text editor with line numbers, a top column ruler, and a status bar showing cursor line/column.

Implemented capabilities:
- Create new files and open/save text-based files (txt, md, json, yaml, html, svg, etc.) by path
- MCP-style edit tool bridge commands exposed from Rust (`get_text`, `get_selected_text`, `replace_text`, `insert_at`, `delete_range`)
- Theme mode selection (`light`, `dark`, `auto`) persisted in a `user.yaml` file located next to the application runtime
- Model discovery against OpenAI-compatible APIs via `/v1/models`

## Local checks

```bash
cd /tmp/workspace/okita-io/LLMEditor/src-tauri
cargo test
cargo check
```

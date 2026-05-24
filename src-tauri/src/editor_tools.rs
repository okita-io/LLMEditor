// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// OpenAI-compatible tool definitions for document editing.

use serde_json::{json, Value};

/// Editor tool schemas sent to LM Studio's `/v1/chat/completions` endpoint.
pub fn tool_definitions() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "get_document",
                "description": "Return the document with 1-based line numbers. For large files this returns the same context window shown in the user message (lines before/after the selection); line numbers are absolute in the full file. Selected lines are marked with >>.",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "goto_line",
                "description": "Move the editor caret to the start of a line (1-based). Returns that line's text.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "line": {
                            "type": "integer",
                            "description": "1-based line number"
                        }
                    },
                    "required": ["line"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "insert_text",
                "description": "Insert text at a 1-based line and column position.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "line": { "type": "integer", "description": "1-based line number" },
                        "column": { "type": "integer", "description": "1-based column (default 1)" },
                        "text": { "type": "string", "description": "Text to insert" }
                    },
                    "required": ["line", "text"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "replace_line",
                "description": "Replace the entire content of a single line. text is the full new line content (not a substring). If text contains newlines, the line expands into multiple lines.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "line": { "type": "integer", "description": "1-based line number" },
                        "text": { "type": "string", "description": "Complete replacement content for the line" }
                    },
                    "required": ["line", "text"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "replace_span",
                "description": "Replace a character span within a single line. Use this to change part of a line without rewriting the whole line. Columns are 1-based and inclusive. Columns past the line end extend to end-of-line (like a text editor selection).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "line": { "type": "integer", "description": "1-based line number" },
                        "start_column": { "type": "integer", "description": "First column to replace (1-based, inclusive)" },
                        "end_column": { "type": "integer", "description": "Last column to replace (1-based, inclusive)" },
                        "text": { "type": "string", "description": "Replacement text for the span" }
                    },
                    "required": ["line", "start_column", "end_column", "text"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "delete_lines",
                "description": "Delete one or more entire lines. start_line and end_line are 1-based and inclusive. To delete a single line, set both to that line number.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "start_line": { "type": "integer", "description": "First line to delete (1-based)" },
                        "end_line": { "type": "integer", "description": "Last line to delete (1-based, inclusive)" }
                    },
                    "required": ["start_line", "end_line"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "delete_span",
                "description": "Delete a character span within a single line. Use this to remove part of a line without deleting the whole line. Columns are 1-based and inclusive. Columns past the line end extend to end-of-line (like a text editor selection).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "line": { "type": "integer", "description": "1-based line number" },
                        "start_column": { "type": "integer", "description": "First column to delete (1-based, inclusive)" },
                        "end_column": { "type": "integer", "description": "Last column to delete (1-based, inclusive)" }
                    },
                    "required": ["line", "start_column", "end_column"],
                    "additionalProperties": false
                }
            }
        }
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_definitions_include_all_editor_tools() {
        let tools = tool_definitions();
        let arr = tools.as_array().expect("tools array");
        let names: Vec<_> = arr
            .iter()
            .filter_map(|t| {
                t.get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(|n| n.as_str())
            })
            .collect();
        for expected in [
            "get_document",
            "goto_line",
            "insert_text",
            "replace_line",
            "replace_span",
            "delete_lines",
            "delete_span",
        ] {
            assert!(names.contains(&expected), "missing tool {expected}");
        }
    }
}

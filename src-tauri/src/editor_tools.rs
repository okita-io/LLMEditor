// SPDX-License-Identifier: MIT
// Copyright (c) 2026 okita.io
//
// OpenAI-compatible tool definitions for document editing.

use serde_json::{json, Value};

/// Validate and normalize tool definitions from the frontend (loaded .lmtool / .lmtools files).
pub fn parse_custom_tool_definitions(tools: &[Value]) -> Result<Vec<Value>, String> {
    let mut out = Vec::with_capacity(tools.len());
    for (index, tool) in tools.iter().enumerate() {
        out.push(validate_custom_tool(tool, index)?);
    }
    Ok(out)
}

/// Build the tools array for the LLM request (default + user tools from the frontend).
pub fn merge_tool_definitions(tools: &[Value]) -> Value {
    json!(tools)
}

fn validate_custom_tool(tool: &Value, index: usize) -> Result<Value, String> {
    let label = format!("custom tool #{index}");
    let obj = tool
        .as_object()
        .ok_or_else(|| format!("{label}: expected an object"))?;

    let tool_type = obj
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("function");
    if tool_type != "function" {
        return Err(format!("{label}: type must be \"function\""));
    }

    let function = obj
        .get("function")
        .and_then(|v| v.as_object())
        .ok_or_else(|| format!("{label}: missing function object"))?;

    let name = function
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("{label}: function.name is required"))?;

    if function.get("parameters").is_none() {
        return Err(format!("{label}: function.parameters is required"));
    }

    Ok(json!({
        "type": "function",
        "function": {
            "name": name,
            "description": function.get("description").cloned().unwrap_or(json!("")),
            "parameters": function.get("parameters").cloned().unwrap_or(json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            })),
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_custom_tool_definitions_validates_and_normalizes() {
        let custom = vec![json!({
            "type": "function",
            "function": {
                "name": "greet",
                "description": "Say hello",
                "parameters": {
                    "type": "object",
                    "properties": { "name": { "type": "string" } },
                    "required": ["name"]
                }
            }
        })];
        let parsed = parse_custom_tool_definitions(&custom).expect("parsed");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0]["function"]["name"], "greet");
    }

    #[test]
    fn merge_tool_definitions_passes_through_tools() {
        let tools = vec![
            json!({
                "type": "function",
                "function": {
                    "name": "get_document",
                    "description": "Read buffer",
                    "parameters": { "type": "object", "properties": {} }
                }
            }),
            json!({
                "type": "function",
                "function": {
                    "name": "greet",
                    "description": "Say hello",
                    "parameters": { "type": "object", "properties": {} }
                }
            }),
        ];
        let merged = merge_tool_definitions(&tools);
        let arr = merged.as_array().expect("array");
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[1]["function"]["name"], "greet");
    }
}

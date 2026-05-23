use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
pub struct FileRequest {
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct SaveRequest {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserSettings {
    pub theme: String,
}

impl Default for UserSettings {
    fn default() -> Self {
        Self {
            theme: "auto".to_string(),
        }
    }
}

pub fn line_col_to_index(content: &str, line: usize, column: usize) -> Result<usize, String> {
    if line == 0 || column == 0 {
        return Err("line and column are 1-based".to_string());
    }

    let mut current_line = 1usize;
    let mut current_col = 1usize;
    let mut idx = 0usize;

    for ch in content.chars() {
        if current_line == line && current_col == column {
            return Ok(idx);
        }

        idx += ch.len_utf8();

        if ch == '\n' {
            current_line += 1;
            current_col = 1;
        } else {
            current_col += 1;
        }
    }

    if current_line == line && current_col == column {
        Ok(idx)
    } else {
        Err("line/column out of range".to_string())
    }
}

pub fn get_settings_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let parent = exe
        .parent()
        .ok_or_else(|| "could not locate executable directory".to_string())?;
    Ok(parent.join("user.yaml"))
}

pub fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn new_file() -> String {
    String::new()
}

pub fn open_file(req: FileRequest) -> Result<String, String> {
    fs::read_to_string(req.path).map_err(|e| e.to_string())
}

pub fn save_file(req: SaveRequest) -> Result<(), String> {
    let path = PathBuf::from(req.path);
    ensure_parent(&path)?;
    fs::write(path, req.content).map_err(|e| e.to_string())
}

pub async fn fetch_models(address: String) -> Result<Vec<String>, String> {
    let trimmed = address.trim_end_matches('/');
    let endpoint = format!("{trimmed}/v1/models");

    let value: Value = reqwest::get(endpoint)
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let models = value
        .get("data")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(|id| id.as_str()))
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(models)
}

pub fn mcp_tool(command: String, content: String, payload: Value) -> Result<Value, String> {
    match command.as_str() {
        "get_text" => Ok(Value::String(content)),
        "get_selected_text" => {
            let start = payload
                .get("start")
                .and_then(Value::as_u64)
                .ok_or_else(|| "missing start".to_string())? as usize;
            let end = payload
                .get("end")
                .and_then(Value::as_u64)
                .ok_or_else(|| "missing end".to_string())? as usize;
            let selected = content
                .get(start..end)
                .ok_or_else(|| "invalid range".to_string())?
                .to_string();
            Ok(Value::String(selected))
        }
        "replace_text" => {
            let start = payload
                .get("start")
                .and_then(Value::as_u64)
                .ok_or_else(|| "missing start".to_string())? as usize;
            let end = payload
                .get("end")
                .and_then(Value::as_u64)
                .ok_or_else(|| "missing end".to_string())? as usize;
            let replacement = payload
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| "missing text".to_string())?;

            let mut result = content;
            result
                .get(start..end)
                .ok_or_else(|| "invalid range".to_string())?;
            result.replace_range(start..end, replacement);
            Ok(Value::String(result))
        }
        "insert_at" => {
            let line = payload
                .get("line")
                .and_then(Value::as_u64)
                .ok_or_else(|| "missing line".to_string())? as usize;
            let column = payload
                .get("column")
                .and_then(Value::as_u64)
                .ok_or_else(|| "missing column".to_string())? as usize;
            let text = payload
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| "missing text".to_string())?;
            let idx = line_col_to_index(&content, line, column)?;

            let mut result = content;
            result.insert_str(idx, text);
            Ok(Value::String(result))
        }
        "delete_range" => {
            let start_line = payload
                .get("start_line")
                .and_then(Value::as_u64)
                .ok_or_else(|| "missing start_line".to_string())? as usize;
            let start_column = payload
                .get("start_column")
                .and_then(Value::as_u64)
                .ok_or_else(|| "missing start_column".to_string())?
                as usize;
            let end_line = payload
                .get("end_line")
                .and_then(Value::as_u64)
                .ok_or_else(|| "missing end_line".to_string())? as usize;
            let end_column = payload
                .get("end_column")
                .and_then(Value::as_u64)
                .ok_or_else(|| "missing end_column".to_string())? as usize;

            let start = line_col_to_index(&content, start_line, start_column)?;
            let end = line_col_to_index(&content, end_line, end_column)?;
            if start > end {
                return Err("range start after end".to_string());
            }

            let mut result = content;
            result
                .get(start..end)
                .ok_or_else(|| "invalid range".to_string())?;
            result.replace_range(start..end, "");
            Ok(Value::String(result))
        }
        _ => Err("unsupported command".to_string()),
    }
}

pub fn load_user_settings() -> Result<UserSettings, String> {
    let path = get_settings_path()?;
    if !path.exists() {
        return Ok(UserSettings::default());
    }

    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_yaml::from_str(&raw).map_err(|e| e.to_string())
}

pub fn save_user_settings(settings: UserSettings) -> Result<(), String> {
    let path = get_settings_path()?;
    ensure_parent(&path)?;
    let yaml = serde_yaml::to_string(&settings).map_err(|e| e.to_string())?;
    fs::write(path, yaml).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{line_col_to_index, mcp_tool};
    use serde_json::json;

    #[test]
    fn maps_line_column_to_index() {
        let text = "one\ntwo";
        assert_eq!(line_col_to_index(text, 1, 1).unwrap(), 0);
        assert_eq!(line_col_to_index(text, 2, 1).unwrap(), 4);
        assert_eq!(line_col_to_index(text, 2, 4).unwrap(), 7);
    }

    #[test]
    fn rejects_zero_positions() {
        let text = "abc";
        assert!(line_col_to_index(text, 0, 1).is_err());
        assert!(line_col_to_index(text, 1, 0).is_err());
    }

    #[test]
    fn edits_text_via_mcp_tool() {
        let edited = mcp_tool(
            "replace_text".to_string(),
            "hello world".to_string(),
            json!({"start": 6, "end": 11, "text": "tauri"}),
        )
        .unwrap();
        assert_eq!(edited.as_str().unwrap(), "hello tauri");
    }
}

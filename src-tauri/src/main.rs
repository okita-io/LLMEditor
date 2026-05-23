#![cfg_attr(all(feature = "desktop", not(debug_assertions)), windows_subsystem = "windows")]

#[cfg(feature = "desktop")]
mod app {
    use llm_editor::{
        FileRequest, SaveRequest, UserSettings, fetch_models as fetch_models_impl,
        load_user_settings as load_user_settings_impl, mcp_tool as mcp_tool_impl, new_file as new_file_impl,
        open_file as open_file_impl, save_file as save_file_impl,
        save_user_settings as save_user_settings_impl,
    };
    use serde_json::Value;

    #[tauri::command]
    fn new_file() -> String {
        new_file_impl()
    }

    #[tauri::command]
    fn open_file(req: FileRequest) -> Result<String, String> {
        open_file_impl(req)
    }

    #[tauri::command]
    fn save_file(req: SaveRequest) -> Result<(), String> {
        save_file_impl(req)
    }

    #[tauri::command]
    async fn fetch_models(address: String) -> Result<Vec<String>, String> {
        fetch_models_impl(address).await
    }

    #[tauri::command]
    fn mcp_tool(command: String, content: String, payload: Value) -> Result<Value, String> {
        mcp_tool_impl(command, content, payload)
    }

    #[tauri::command]
    fn load_user_settings() -> Result<UserSettings, String> {
        load_user_settings_impl()
    }

    #[tauri::command]
    fn save_user_settings(settings: UserSettings) -> Result<(), String> {
        save_user_settings_impl(settings)
    }

    pub fn run() {
        tauri::Builder::default()
            .invoke_handler(tauri::generate_handler![
                new_file,
                open_file,
                save_file,
                fetch_models,
                mcp_tool,
                load_user_settings,
                save_user_settings
            ])
            .run(tauri::generate_context!())
            .expect("error while running tauri application");
    }
}

#[cfg(feature = "desktop")]
fn main() {
    app::run();
}

#[cfg(not(feature = "desktop"))]
fn main() {
    println!("LLMEditor backend library build (desktop feature disabled)");
}

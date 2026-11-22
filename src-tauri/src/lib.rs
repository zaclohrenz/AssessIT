mod claude;
mod config;
mod export;
mod submit;
mod vuln;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // In-app updates: checks the signed manifest on GitHub Releases (see tauri.conf.json).
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            Ok(())
        })
        .manage(claude::ResearchState::default())
        .manage(submit::GraphState::default())
        .invoke_handler(tauri::generate_handler![
            claude::claude_status,
            claude::research_start,
            claude::research_cancel,
            claude::open_claude_setup,
            submit::post_webhook,
            submit::graph_sign_in_start,
            submit::graph_sign_in_wait,
            submit::graph_status,
            submit::graph_sign_out,
            submit::graph_create_item,
            export::export_xlsx,
            export::write_text_file,
            export::read_text_file,
            export::write_binary_file,
            config::config_source,
            config::fetch_config,
            vuln::cve_record,
            vuln::kev_lookup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AssessIT");
}

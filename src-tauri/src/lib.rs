use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

struct InitialDeepLink(Mutex<Option<String>>);

#[tauri::command]
fn toggle_always_on_top(window: tauri::WebviewWindow, enabled: bool) -> Result<bool, String> {
    window.set_always_on_top(enabled).map_err(|e| e.to_string())?;
    Ok(enabled)
}

#[tauri::command]
fn toggle_popout_always_on_top(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("timer-popout") {
        window.set_always_on_top(enabled).map_err(|e| e.to_string())?;
        return Ok(enabled);
    }
    Err("Popout window not found".into())
}

#[tauri::command]
fn is_always_on_top(window: tauri::WebviewWindow) -> Result<bool, String> {
    window.is_always_on_top().map_err(|e| e.to_string())
}

#[tauri::command]
fn minimize_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
fn toggle_maximize_window(window: tauri::WebviewWindow) -> Result<bool, String> {
    let is_max = window.is_maximized().map_err(|e| e.to_string())?;
    if is_max {
        window.unmaximize().map_err(|e| e.to_string())?;
        Ok(false)
    } else {
        window.maximize().map_err(|e| e.to_string())?;
        Ok(true)
    }
}

#[tauri::command]
fn close_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
fn start_dragging(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

#[tauri::command]
fn open_timer_popout(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("timer-popout") {
        window.show().map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    Err("Timer popout window not configured".into())
}

#[tauri::command]
fn close_timer_popout(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("timer-popout") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_initial_deep_link(state: tauri::State<'_, InitialDeepLink>) -> Option<String> {
    state.0.lock().ok()?.take()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut initial_url = None;
    for arg in std::env::args().skip(1) {
        if arg.starts_with("at22://") {
            initial_url = Some(arg);
            break;
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            for arg in argv {
                if arg.starts_with("at22://") {
                    let _ = app.emit("deep-link-received", arg);
                }
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .manage(InitialDeepLink(Mutex::new(initial_url)))
        .setup(|app| {
            #[cfg(desktop)]
            {
                if let Err(e) = app.deep_link().register("at22") {
                    log::warn!("Failed to register at22:// protocol: {}", e);
                }
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            if let Some(popout) = app.get_webview_window("timer-popout") {
                let popout_clone = popout.clone();
                popout.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = popout_clone.hide();
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            toggle_always_on_top,
            toggle_popout_always_on_top,
            is_always_on_top,
            minimize_window,
            toggle_maximize_window,
            close_window,
            start_dragging,
            open_timer_popout,
            close_timer_popout,
            get_initial_deep_link
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

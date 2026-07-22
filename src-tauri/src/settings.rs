use serde::Serialize;
use std::path::Path;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootSelection {
    root: String,
    work_dir: String,
}

fn settings_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("settings.json"))
}

fn read_settings(app: &tauri::AppHandle) -> serde_json::Value {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}))
}

const MAX_RECENT_ROOTS: usize = 10;

#[tauri::command]
pub fn get_last_root(app: tauri::AppHandle) -> Option<String> {
    let settings = read_settings(&app);
    let root = settings.get("last_root")?.as_str()?.to_string();
    Path::new(&root).is_dir().then_some(root)
}

#[tauri::command]
pub fn get_last_selection(app: tauri::AppHandle) -> Option<RootSelection> {
    let settings = read_settings(&app);
    let root = settings.get("last_root")?.as_str()?.to_string();
    if !Path::new(&root).is_dir() {
        return None;
    }
    let work_dir = settings
        .get("work_dirs")
        .and_then(|value| value.get(&root))
        .and_then(serde_json::Value::as_str)
        .filter(|path| Path::new(path).is_dir() && Path::new(path).starts_with(&root))
        .unwrap_or(&root)
        .to_string();
    Some(RootSelection { root, work_dir })
}

#[tauri::command]
pub fn get_work_dir(app: tauri::AppHandle, root: String) -> Option<String> {
    read_settings(&app)
        .get("work_dirs")
        .and_then(|value| value.get(&root))
        .and_then(serde_json::Value::as_str)
        .filter(|path| Path::new(path).is_dir() && Path::new(path).starts_with(&root))
        .map(str::to_string)
}

/// Most-recently-opened roots, newest first; entries whose directory no
/// longer exists are dropped.
#[tauri::command]
pub fn get_recent_roots(app: tauri::AppHandle) -> Vec<String> {
    read_settings(&app)
        .get("recent_roots")
        .and_then(serde_json::Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .filter(|p| Path::new(p).is_dir())
                .take(MAX_RECENT_ROOTS)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub fn set_last_root(app: tauri::AppHandle, root: String, work_dir: Option<String>) {
    let Some(path) = settings_path(&app) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut settings = read_settings(&app);
    let mut recents: Vec<String> = settings
        .get("recent_roots")
        .and_then(serde_json::Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    recents.retain(|r| r != &root);
    recents.insert(0, root.clone());
    recents.truncate(MAX_RECENT_ROOTS);
    let retained: std::collections::HashSet<&str> = recents.iter().map(String::as_str).collect();
    if let Some(work_dirs) = settings
        .get_mut("work_dirs")
        .and_then(serde_json::Value::as_object_mut)
    {
        work_dirs.retain(|root, _| retained.contains(root.as_str()));
    }
    settings["last_root"] = serde_json::Value::String(root.clone());
    if let Some(work_dir) = work_dir {
        if !settings
            .get("work_dirs")
            .is_some_and(serde_json::Value::is_object)
        {
            settings["work_dirs"] = serde_json::json!({});
        }
        settings["work_dirs"][&root] = serde_json::Value::String(work_dir);
    }
    settings["recent_roots"] = serde_json::json!(recents);
    let _ = std::fs::write(path, settings.to_string());
}

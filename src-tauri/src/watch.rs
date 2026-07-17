use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use crate::fs::SKIP_DIRS;

#[derive(Default)]
pub struct WatchState {
    // Recursive watcher on the selected root; dropped (stopped) when a new
    // root is watched. Keeps the frontend in sync with edits made outside
    // the app (other editors, git operations, `astro sync`, …).
    watcher: Mutex<Option<notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>>>,
}

/// Paths whose changes the frontend doesn't care about: build output and
/// dependency churn, plus everything under `.astro` except the generated
/// collection schemas (the dev server rewrites other `.astro` files
/// constantly, which would otherwise spam refreshes).
fn watch_ignored(root: &str, path: &str) -> bool {
    let rel = match path.strip_prefix(root) {
        Some(rel) => rel.trim_start_matches('/'),
        None => return true,
    };
    if rel.starts_with(".astro/") || rel == ".astro" {
        return !rel.starts_with(".astro/collections");
    }
    rel.split('/').any(|segment| {
        matches!(
            segment,
            "node_modules" | ".git" | ".DS_Store" | ".vercel" | ".netlify" | "cache"
        ) || SKIP_DIRS.contains(&segment)
    })
}

/// Watches `root` recursively, emitting debounced `fs-changed` events with
/// the affected absolute paths. Replaces any previous watch.
#[tauri::command]
pub fn watch_root(
    app: tauri::AppHandle,
    state: tauri::State<WatchState>,
    root: String,
) -> Result<(), String> {
    use tauri::Emitter;
    let emit_root = root.clone();
    let mut debouncer = notify_debouncer_mini::new_debouncer(
        Duration::from_millis(500),
        move |result: notify_debouncer_mini::DebounceEventResult| {
            if let Ok(events) = result {
                let paths: Vec<String> = events
                    .iter()
                    .map(|event| event.path.to_string_lossy().to_string())
                    .filter(|path| !watch_ignored(&emit_root, path))
                    .collect();
                if !paths.is_empty() {
                    let _ = app.emit("fs-changed", paths);
                }
            }
        },
    )
    .map_err(|e| e.to_string())?;
    debouncer
        .watcher()
        .watch(Path::new(&root), notify::RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    // Assign last: an error above leaves the previous watch running.
    *state.watcher.lock().unwrap() = Some(debouncer);
    Ok(())
}

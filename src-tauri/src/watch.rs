use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use crate::fs::SKIP_DIRS;

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreRule {
    prefix: Option<String>,
    glob: Option<String>,
    #[serde(default)]
    except_prefixes: Vec<String>,
}

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
fn adapter_ignored(rel: &str, rules: &[IgnoreRule]) -> bool {
    rules.iter().any(|rule| {
        let excepted = rule
            .except_prefixes
            .iter()
            .any(|prefix| rel.starts_with(prefix));
        if excepted {
            return false;
        }
        rule.prefix
            .as_ref()
            .is_some_and(|prefix| rel.starts_with(prefix))
            || rule
                .glob
                .as_ref()
                .is_some_and(|glob| wildcard_match(glob, rel))
    })
}

fn wildcard_match(pattern: &str, value: &str) -> bool {
    let pattern = pattern.as_bytes();
    let value = value.as_bytes();
    let (mut p, mut v, mut star, mut matched) = (0, 0, None, 0);
    while v < value.len() {
        if p < pattern.len() && (pattern[p] == b'?' && value[v] != b'/' || pattern[p] == value[v]) {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            let recursive = p + 1 < pattern.len() && pattern[p + 1] == b'*';
            p += if recursive { 2 } else { 1 };
            star = Some((p, recursive));
            matched = v;
        } else if let Some((after_star, recursive)) = star {
            if !recursive && value[matched] == b'/' {
                return false;
            }
            matched += 1;
            v = matched;
            p = after_star;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

fn watch_ignored(root: &str, path: &str, rules: &[IgnoreRule]) -> bool {
    let rel = match path.strip_prefix(root) {
        Some(rel) => rel.trim_start_matches('/'),
        None => return true,
    };
    if adapter_ignored(rel, rules) {
        return true;
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
    ignore_rules: Option<Vec<IgnoreRule>>,
    extra_paths: Option<Vec<String>>,
) -> Result<(), String> {
    use tauri::Emitter;
    let emit_root = root.clone();
    let ignore_rules = ignore_rules.unwrap_or_default();
    let extra_paths = extra_paths.unwrap_or_default();
    let emit_extra_paths = extra_paths.clone();
    let mut debouncer = notify_debouncer_mini::new_debouncer(
        Duration::from_millis(500),
        move |result: notify_debouncer_mini::DebounceEventResult| {
            if let Ok(events) = result {
                let paths: Vec<String> = events
                    .iter()
                    .map(|event| event.path.to_string_lossy().to_string())
                    .filter(|path| {
                        emit_extra_paths.iter().any(|extra| extra == path)
                            || !watch_ignored(&emit_root, path, &ignore_rules)
                    })
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
    let extra_parents: HashSet<_> = extra_paths
        .iter()
        .filter_map(|extra| Path::new(extra).parent().map(Path::to_path_buf))
        .collect();
    for path in extra_parents {
        if path.is_dir() {
            debouncer
                .watcher()
                .watch(&path, notify::RecursiveMode::NonRecursive)
                .map_err(|e| e.to_string())?;
        }
    }
    // Assign last: an error above leaves the previous watch running.
    *state.watcher.lock().unwrap() = Some(debouncer);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::wildcard_match;

    #[test]
    fn watcher_globs_match_frontend_semantics() {
        assert!(wildcard_match("a/**/b/*.md", "a/nested/deep/b/post.md"));
        assert!(!wildcard_match("a/*/b/*.md", "a/nested/deep/b/post.md"));
    }
}

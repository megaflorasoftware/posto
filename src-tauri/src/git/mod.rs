use serde::Serialize;
use std::path::Path;
use std::process::Command;

pub(crate) fn run_git(root: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.success() {
        Ok(stdout)
    } else {
        Err(if stderr.trim().is_empty() { stdout } else { stderr })
    }
}

#[derive(Serialize)]
pub struct ChangedFile {
    /// Porcelain XY status collapsed to one code: "M", "A", "D", "R", "??", ...
    status: String,
    path: String,
}

#[tauri::command]
pub fn changed_files(root: String) -> Result<Vec<ChangedFile>, String> {
    let output = run_git(&root, &["status", "--porcelain"])?;
    Ok(output
        .lines()
        .filter(|line| line.len() > 3)
        .map(|line| ChangedFile {
            status: line[..2].trim().to_string(),
            path: line[3..].to_string(),
        })
        .collect())
}

/// Reverts one changed file to its committed state. `path` is repo-relative
/// (as reported by `changed_files`). Untracked files have no committed state,
/// so revert means deleting them.
#[tauri::command]
pub fn revert_file(root: String, path: String) -> Result<(), String> {
    // `git status --porcelain` paths are relative to the repository root,
    // which is not necessarily the chosen directory.
    let toplevel = run_git(&root, &["rev-parse", "--show-toplevel"])?;
    let toplevel = toplevel.trim();
    let status = run_git(toplevel, &["status", "--porcelain", "--", &path])?;
    if status.starts_with("??") {
        let absolute = Path::new(toplevel).join(&path);
        std::fs::remove_file(&absolute)
            .map_err(|e| format!("Failed to delete {}: {e}", absolute.display()))
    } else {
        // Restores both index and working tree from HEAD.
        run_git(toplevel, &["checkout", "HEAD", "--", &path]).map(|_| ())
    }
}

/// Fetches the remote and reports whether the upstream branch has commits the
/// local branch lacks. Errors out when there is no remote/upstream — callers
/// treat that as "nothing to fetch".
#[tauri::command]
pub async fn fetch_upstream(root: String) -> Result<bool, String> {
    run_git(&root, &["fetch", "--quiet"])?;
    let behind = run_git(&root, &["rev-list", "--count", "HEAD..@{u}"])?;
    Ok(behind.trim().parse::<u64>().unwrap_or(0) > 0)
}

/// Merges the already-fetched upstream branch into the working tree. The
/// server always wins: committed conflicts resolve with `-X theirs`, and when
/// a merge is blocked by uncommitted local edits those are stashed around the
/// merge — reapplied afterwards, except where they collide with what the
/// server changed (the merged version is kept there).
#[tauri::command]
pub async fn pull_upstream(root: String) -> Result<String, String> {
    run_git(&root, &["fetch", "--quiet"])?;
    let merge = || run_git(&root, &["merge", "--no-edit", "-X", "theirs", "@{u}"]);
    if merge().is_ok() {
        return Ok("Updated from server.".to_string());
    }
    let _ = run_git(&root, &["merge", "--abort"]);
    let dirty = !run_git(&root, &["status", "--porcelain"])?.trim().is_empty();
    if !dirty {
        // A clean tree that still can't merge is a real failure (unrelated
        // histories, diverged in a way -X theirs can't settle, …).
        return merge().map(|_| "Updated from server.".to_string());
    }
    run_git(
        &root,
        &["stash", "push", "--include-untracked", "-m", "posto-fetch"],
    )?;
    if let Err(e) = merge() {
        let _ = run_git(&root, &["merge", "--abort"]);
        let _ = run_git(&root, &["stash", "pop"]);
        return Err(e);
    }
    if run_git(&root, &["stash", "pop"]).is_err() {
        // Local edits conflict with what the server changed: keep the merged
        // (server) version of each conflicted file, then drop the stash.
        let conflicted = run_git(&root, &["diff", "--name-only", "--diff-filter=U"])?;
        for file in conflicted.lines().map(str::trim).filter(|l| !l.is_empty()) {
            let _ = run_git(&root, &["checkout", "--ours", "--", file]);
        }
        let _ = run_git(&root, &["reset", "-q"]);
        let _ = run_git(&root, &["stash", "drop"]);
    }
    Ok("Updated from server.".to_string())
}

#[tauri::command]
pub async fn publish(root: String, message: Option<String>) -> Result<String, String> {
    run_git(&root, &["add", "-A"])?;
    let status = run_git(&root, &["status", "--porcelain"])?;
    if status.trim().is_empty() {
        return Ok("Nothing to publish — no local changes.".to_string());
    }
    let message = message
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| "Site updates".to_string());
    run_git(&root, &["commit", "-m", &message])?;
    run_git(&root, &["push", "origin", "HEAD"])?;
    Ok("Published.".to_string())
}

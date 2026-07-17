#![cfg_attr(test, allow(dead_code))]

use crate::git::creds::{platform_creds, remote_callbacks};
use git2::{build::RepoBuilder, FetchOptions, Repository};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use tauri::{Emitter, Manager};

const CLONE_PROGRESS_EVENT: &str = "clone-progress";

#[derive(Clone, Debug, PartialEq)]
struct RepoIdentity {
    owner: String,
    name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ManagedRepo {
    owner: String,
    name: String,
    root: String,
    url: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CloneProgress {
    received_objects: usize,
    total_objects: usize,
    indexed_objects: usize,
    received_bytes: usize,
}

fn err_str(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn valid_segment(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Extracts the owner and repository name from the HTTPS/SSH forms GitHub
/// returns from its API. Restricting managed clones to GitHub is intentional:
/// mobile v1 has GitHub-only authentication.
fn github_identity(url: &str) -> Result<RepoIdentity, String> {
    let path = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("git@github.com:"))
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))
        .ok_or_else(|| "Only GitHub repository URLs are supported".to_string())?;
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.split('/');
    let owner = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default();
    if parts.next().is_some() || !valid_segment(owner) || !valid_segment(name) {
        return Err("Invalid GitHub repository URL".to_string());
    }
    Ok(RepoIdentity {
        owner: owner.to_string(),
        name: name.to_string(),
    })
}

fn managed_repos_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("repos"))
        .map_err(err_str)
}

fn repo_path(base: &Path, identity: &RepoIdentity) -> PathBuf {
    base.join(&identity.owner).join(&identity.name)
}

fn clone_managed<F>(
    base: &Path,
    identity: &RepoIdentity,
    url: &str,
    mut on_progress: F,
) -> Result<PathBuf, String>
where
    F: FnMut(CloneProgress),
{
    let target = repo_path(base, identity);
    if target.exists() {
        return Err(format!(
            "{}/{} is already cloned",
            identity.owner, identity.name
        ));
    }
    let parent = target
        .parent()
        .ok_or_else(|| "Invalid managed repository path".to_string())?;
    std::fs::create_dir_all(base).map_err(err_str)?;
    for path in [base, parent] {
        if std::fs::symlink_metadata(path)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err("Managed repository path cannot contain symlinks".to_string());
        }
    }
    std::fs::create_dir_all(parent).map_err(err_str)?;

    let config = git2::Config::open_default().map_err(err_str)?;
    let mut callbacks = remote_callbacks(config, platform_creds());
    callbacks.transfer_progress(move |stats| {
        on_progress(CloneProgress {
            received_objects: stats.received_objects(),
            total_objects: stats.total_objects(),
            indexed_objects: stats.indexed_objects(),
            received_bytes: stats.received_bytes(),
        });
        true
    });
    let mut fetch = FetchOptions::new();
    fetch.remote_callbacks(callbacks);
    let mut builder = RepoBuilder::new();
    builder.fetch_options(fetch);

    match builder.clone(url, &target) {
        Ok(_) => Ok(target),
        Err(error) => {
            // A failed clone must never appear in the registry or block a
            // clean retry. The target is wholly owned by this operation.
            let _ = std::fs::remove_dir_all(&target);
            let _ = std::fs::remove_dir(parent);
            Err(err_str(error))
        }
    }
}

fn read_managed(base: &Path) -> Vec<ManagedRepo> {
    let mut repos = Vec::new();
    let Ok(owners) = std::fs::read_dir(base) else {
        return repos;
    };
    for owner_entry in owners.flatten() {
        let Ok(owner_type) = owner_entry.file_type() else {
            continue;
        };
        if !owner_type.is_dir() || owner_type.is_symlink() {
            continue;
        }
        let owner = owner_entry.file_name().to_string_lossy().to_string();
        if !valid_segment(&owner) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(owner_entry.path()) else {
            continue;
        };
        for repo_entry in entries.flatten() {
            let Ok(repo_type) = repo_entry.file_type() else {
                continue;
            };
            if !repo_type.is_dir() || repo_type.is_symlink() {
                continue;
            }
            let name = repo_entry.file_name().to_string_lossy().to_string();
            if !valid_segment(&name) {
                continue;
            }
            let root = repo_entry.path();
            let Ok(repo) = Repository::open(&root) else {
                continue;
            };
            let Ok(remote) = repo.find_remote("origin") else {
                continue;
            };
            let Ok(url) = remote.url() else {
                continue;
            };
            repos.push(ManagedRepo {
                owner: owner.clone(),
                name,
                root: root.to_string_lossy().to_string(),
                url: url.to_string(),
            });
        }
    }
    repos.sort_by(|a, b| {
        a.owner
            .to_lowercase()
            .cmp(&b.owner.to_lowercase())
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    repos
}

fn managed_identity_for_root(base: &Path, root: &Path) -> Result<RepoIdentity, String> {
    let relative = root
        .strip_prefix(base)
        .map_err(|_| "Repository is outside the managed repository directory".to_string())?;
    let components: Vec<_> = relative.components().collect();
    if components.len() != 2
        || components
            .iter()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Invalid managed repository path".to_string());
    }
    let owner = components[0].as_os_str().to_string_lossy().to_string();
    let name = components[1].as_os_str().to_string_lossy().to_string();
    if !valid_segment(&owner)
        || !valid_segment(&name)
        || repo_path(
            base,
            &RepoIdentity {
                owner: owner.clone(),
                name: name.clone(),
            },
        ) != root
    {
        return Err("Invalid managed repository path".to_string());
    }
    Ok(RepoIdentity { owner, name })
}

fn remove_managed(base: &Path, root: &Path) -> Result<(), String> {
    let identity = managed_identity_for_root(base, root)?;
    for path in [
        base.to_path_buf(),
        base.join(&identity.owner),
        root.to_path_buf(),
    ] {
        if std::fs::symlink_metadata(path)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err("Managed repository path cannot contain symlinks".to_string());
        }
    }
    if !root.join(".git").is_dir() {
        return Err("Path is not a managed git repository".to_string());
    }
    std::fs::remove_dir_all(root).map_err(err_str)?;
    if let Some(owner_dir) = root.parent() {
        let _ = std::fs::remove_dir(owner_dir);
    }
    Ok(())
}

/// Clones a GitHub repository into app data and returns its sandbox root.
/// Transfer progress is emitted as `clone-progress` events.
#[tauri::command]
pub async fn clone_repo(app: tauri::AppHandle, url: String) -> Result<String, String> {
    let identity = github_identity(&url)?;
    let base = managed_repos_dir(&app)?;
    let progress_app = app.clone();
    let root = tauri::async_runtime::spawn_blocking(move || {
        clone_managed(&base, &identity, &url, |progress| {
            let _ = progress_app.emit(CLONE_PROGRESS_EVENT, progress);
        })
    })
    .await
    .map_err(err_str)??;
    let root = root.to_string_lossy().to_string();
    let _ = app.emit("fs-changed", vec![root.clone()]);
    Ok(root)
}

#[tauri::command]
pub fn list_repos(app: tauri::AppHandle) -> Result<Vec<ManagedRepo>, String> {
    Ok(read_managed(&managed_repos_dir(&app)?))
}

#[tauri::command]
pub async fn remove_repo(app: tauri::AppHandle, root: String) -> Result<(), String> {
    let base = managed_repos_dir(&app)?;
    let remove_root = PathBuf::from(&root);
    tauri::async_runtime::spawn_blocking(move || remove_managed(&base, &remove_root))
        .await
        .map_err(err_str)??;
    let _ = app.emit("fs-changed", vec![root]);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn init_origin(path: &Path) -> PathBuf {
        let origin = path.join("origin.git");
        let mut bare_options = git2::RepositoryInitOptions::new();
        bare_options.bare(true).initial_head("main");
        Repository::init_opts(&origin, &bare_options).unwrap();

        let source = path.join("source");
        let mut source_options = git2::RepositoryInitOptions::new();
        source_options.initial_head("main");
        let repo = Repository::init_opts(&source, &source_options).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "test").unwrap();
        config.set_str("user.email", "test@example.com").unwrap();
        drop(config);
        repo.remote("origin", origin.to_str().unwrap()).unwrap();
        std::fs::write(source.join("README.md"), "hello\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("README.md")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = repo.signature().unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .unwrap();
        repo.find_remote("origin")
            .unwrap()
            .push(&["refs/heads/main:refs/heads/main"], None)
            .unwrap();
        origin
    }

    #[test]
    fn parses_supported_github_urls() {
        let expected = RepoIdentity {
            owner: "megaflorasoftware".into(),
            name: "posto".into(),
        };
        assert_eq!(
            github_identity("https://github.com/megaflorasoftware/posto.git").unwrap(),
            expected
        );
        assert_eq!(
            github_identity("git@github.com:megaflorasoftware/posto.git").unwrap(),
            expected
        );
        assert_eq!(
            github_identity("ssh://git@github.com/megaflorasoftware/posto").unwrap(),
            expected
        );
    }

    #[test]
    fn rejects_non_github_and_unsafe_urls() {
        for url in [
            "https://example.com/owner/repo.git",
            "https://github.com/owner",
            "https://github.com/../repo.git",
            "https://github.com/owner/repo/extra",
        ] {
            assert!(github_identity(url).is_err(), "accepted {url}");
        }
    }

    #[test]
    fn clones_lists_and_removes_a_managed_repo() {
        let temp = tempfile::tempdir().unwrap();
        let origin = init_origin(temp.path());
        let base = temp.path().join("repos");
        let identity = RepoIdentity {
            owner: "owner".into(),
            name: "site".into(),
        };
        let progress = Arc::new(Mutex::new(Vec::new()));
        let captured = progress.clone();
        let root = clone_managed(&base, &identity, origin.to_str().unwrap(), move |update| {
            captured.lock().unwrap().push(update)
        })
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(root.join("README.md")).unwrap(),
            "hello\n"
        );
        // Local-path clones may bypass transfer callbacks entirely. When
        // libgit2 does report them, the counts must stay internally valid.
        assert!(progress
            .lock()
            .unwrap()
            .iter()
            .all(|update| update.received_objects <= update.total_objects));
        assert_eq!(
            read_managed(&base),
            vec![ManagedRepo {
                owner: "owner".into(),
                name: "site".into(),
                root: root.to_string_lossy().to_string(),
                url: origin.to_string_lossy().to_string(),
            }]
        );

        remove_managed(&base, &root).unwrap();
        assert!(!root.exists());
        assert!(!base.join("owner").exists());
        assert!(read_managed(&base).is_empty());
    }

    #[test]
    fn failed_clone_is_cleaned_up_for_retry() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join("repos");
        let identity = RepoIdentity {
            owner: "owner".into(),
            name: "missing".into(),
        };
        let target = repo_path(&base, &identity);
        assert!(clone_managed(&base, &identity, "/does/not/exist", |_| {}).is_err());
        assert!(!target.exists());
        assert!(!base.join("owner").exists());
    }

    #[test]
    fn removal_rejects_paths_outside_the_registry() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join("repos");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(outside.join(".git")).unwrap();
        assert!(remove_managed(&base, &outside).is_err());
        assert!(outside.exists());
        assert!(remove_managed(&base, &base.join("owner/site/extra")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn clone_and_removal_reject_symlinked_owner_paths() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join("repos");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(&base).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, base.join("owner")).unwrap();
        let identity = RepoIdentity {
            owner: "owner".into(),
            name: "site".into(),
        };
        assert!(clone_managed(&base, &identity, "/does/not/matter", |_| {}).is_err());

        std::fs::create_dir_all(outside.join("site/.git")).unwrap();
        assert!(remove_managed(&base, &base.join("owner/site")).is_err());
        assert!(outside.join("site").exists());
    }
}

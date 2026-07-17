#![cfg_attr(test, allow(dead_code))]

use crate::git::creds::{platform_creds, remote_callbacks};
use git2::{build::CheckoutBuilder, build::RepoBuilder, BranchType, FetchOptions, Repository};
use serde::Serialize;
use std::cell::RefCell;
use std::path::{Component, Path, PathBuf};
use std::rc::Rc;
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

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct CloneProgress {
    received_objects: usize,
    total_objects: usize,
    indexed_objects: usize,
    received_bytes: usize,
    checkout_completed: usize,
    checkout_total: usize,
    phase: String,
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

fn is_clone_staging_name(value: &str) -> bool {
    value.starts_with('.') && value.ends_with(".clone")
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

fn clone_staging_path(base: &Path, identity: &RepoIdentity) -> PathBuf {
    base.join(&identity.owner)
        .join(format!(".{}.clone", identity.name))
}

fn remove_clone_path(path: &Path) -> Result<(), String> {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return Ok(());
    };
    if metadata.file_type().is_symlink() {
        return Err("Managed repository path cannot contain symlinks".to_string());
    }
    std::fs::remove_dir_all(path).map_err(err_str)
}

fn clone_error(identity: &RepoIdentity, error: git2::Error) -> String {
    format!(
        "Could not download {}/{}. Check your internet connection and available device storage, keep Posto open, then try again. Any partial download was removed. Details: {}",
        identity.owner,
        identity.name,
        error.message()
    )
}

fn clone_managed<F>(
    base: &Path,
    identity: &RepoIdentity,
    url: &str,
    on_progress: F,
) -> Result<PathBuf, String>
where
    F: FnMut(CloneProgress),
{
    let target = repo_path(base, identity);
    let staging = clone_staging_path(base, identity);
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

    // Clone into a disposable sibling directory. Large repositories can be
    // interrupted by a lost connection, low storage, or iOS suspending the
    // app. The final path appears only after fetch and checkout both finish.
    remove_clone_path(&staging)?;

    let progress = Rc::new(RefCell::new(on_progress));
    let latest = Rc::new(RefCell::new(CloneProgress::default()));

    let config = git2::Config::open_default().map_err(err_str)?;
    let mut callbacks = remote_callbacks(config, platform_creds());
    let transfer_progress = Rc::clone(&progress);
    let transfer_latest = Rc::clone(&latest);
    callbacks.transfer_progress(move |stats| {
        let update = CloneProgress {
            received_objects: stats.received_objects(),
            total_objects: stats.total_objects(),
            indexed_objects: stats.indexed_objects(),
            received_bytes: stats.received_bytes(),
            checkout_completed: 0,
            checkout_total: 0,
            phase: "downloading".to_string(),
        };
        *transfer_latest.borrow_mut() = update.clone();
        (transfer_progress.borrow_mut())(update);
        true
    });
    let mut fetch = FetchOptions::new();
    fetch.remote_callbacks(callbacks);
    // Mobile editing needs the current snapshot, not the entire historical
    // object graph. This can substantially reduce repeat copies of large
    // media while preserving normal commit, fetch, merge, and push behavior.
    if url.starts_with("https://") {
        fetch.depth(1);
    }

    let checkout_progress = Rc::clone(&progress);
    let checkout_latest = Rc::clone(&latest);
    let mut checkout = CheckoutBuilder::new();
    checkout.progress(move |_path, completed, total| {
        let mut update = checkout_latest.borrow().clone();
        update.checkout_completed = completed;
        update.checkout_total = total;
        update.phase = "checking_out".to_string();
        (checkout_progress.borrow_mut())(update);
    });

    let mut builder = RepoBuilder::new();
    builder.fetch_options(fetch);
    builder.with_checkout(checkout);

    match builder.clone(url, &staging) {
        Ok(_) => match std::fs::rename(&staging, &target) {
            Ok(()) => Ok(target),
            Err(error) => {
                let _ = remove_clone_path(&staging);
                let _ = std::fs::remove_dir(parent);
                Err(format!(
                    "The repository downloaded, but could not be prepared for use: {error}"
                ))
            }
        },
        Err(error) => {
            // A failed clone must never appear in the registry or block a
            // clean retry. The staging directory is wholly owned by this operation.
            let _ = remove_clone_path(&staging);
            let _ = std::fs::remove_dir(parent);
            Err(clone_error(identity, error))
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
            if !valid_segment(&name) || is_clone_staging_name(&name) {
                continue;
            }
            let root = repo_entry.path();
            // Keep damaged final directories visible as managed repositories.
            // Opening one can then run the repository doctor and offer a safe
            // remove-and-redownload path instead of trying to clone over it.
            let url = Repository::open(&root)
                .ok()
                .and_then(|repo| {
                    repo.find_remote("origin")
                        .ok()
                        .and_then(|remote| remote.url().ok().map(str::to_owned))
                })
                .unwrap_or_else(|| format!("https://github.com/{owner}/{name}.git"));
            repos.push(ManagedRepo {
                owner: owner.clone(),
                name,
                root: root.to_string_lossy().to_string(),
                url,
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
    if !root.is_dir() {
        return Err("Managed repository directory does not exist".to_string());
    }
    std::fs::remove_dir_all(root).map_err(err_str)?;
    if let Some(owner_dir) = root.parent() {
        let _ = std::fs::remove_dir(owner_dir);
    }
    Ok(())
}

fn doctor_managed(base: &Path, root: &Path, expected_url: &str) -> Result<String, String> {
    let identity = managed_identity_for_root(base, root)?;
    if github_identity(expected_url)? != identity {
        return Err("Repository identity does not match its managed directory".to_string());
    }
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

    let repo = Repository::open(root)
        .map_err(|error| format!("The local Git repository could not be opened: {error}"))?;
    let expected_workdir = std::fs::canonicalize(root).map_err(err_str)?;
    let actual_workdir = repo
        .workdir()
        .and_then(|path| std::fs::canonicalize(path).ok());
    if repo.is_bare() || actual_workdir.as_deref() != Some(expected_workdir.as_path()) {
        return Err("The local repository has an invalid working directory".to_string());
    }

    let mut repaired = false;
    if repo.state() != git2::RepositoryState::Clean {
        repo.cleanup_state().map_err(err_str)?;
        repaired = true;
    }

    let head = repo
        .head()
        .and_then(|reference| reference.peel_to_commit())
        .map_err(|error| format!("The local repository has no readable current commit: {error}"))?;
    let tree = head
        .tree()
        .map_err(|error| format!("The current repository snapshot is unreadable: {error}"))?;

    match repo.find_remote("origin") {
        Ok(remote) if remote.url().ok() == Some(expected_url) => {}
        Ok(_) => {
            repo.remote_set_url("origin", expected_url)
                .map_err(err_str)?;
            repaired = true;
        }
        Err(_) => {
            repo.remote("origin", expected_url).map_err(err_str)?;
            repaired = true;
        }
    }

    let index_healthy = repo.index().and_then(|mut index| index.read(true)).is_ok();
    if !index_healthy {
        let index_path = repo.path().join("index");
        if std::fs::symlink_metadata(&index_path)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err("The repository index cannot be repaired safely".to_string());
        }
        if index_path.exists() {
            std::fs::remove_file(&index_path).map_err(err_str)?;
        }
        let mut index = repo.index().map_err(err_str)?;
        index.read_tree(&tree).map_err(err_str)?;
        index.write().map_err(err_str)?;
        repaired = true;
    }

    if let Some(branch_name) = repo
        .head()
        .ok()
        .and_then(|head| head.shorthand().ok().map(str::to_owned))
    {
        if let Ok(mut branch) = repo.find_branch(&branch_name, BranchType::Local) {
            let upstream_name = format!("origin/{branch_name}");
            if branch.upstream().is_err()
                && repo.find_branch(&upstream_name, BranchType::Remote).is_ok()
            {
                branch.set_upstream(Some(&upstream_name)).map_err(err_str)?;
                repaired = true;
            }
        }
    }

    Ok(if repaired {
        "Repository repaired.".to_string()
    } else {
        "Repository checked.".to_string()
    })
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
pub async fn doctor_repo(
    app: tauri::AppHandle,
    root: String,
    expected_url: String,
) -> Result<String, String> {
    let base = managed_repos_dir(&app)?;
    let doctor_root = PathBuf::from(&root);
    tauri::async_runtime::spawn_blocking(move || doctor_managed(&base, &doctor_root, &expected_url))
        .await
        .map_err(err_str)?
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
        let stale_staging = clone_staging_path(&base, &identity);
        let stale_repo = Repository::init(&stale_staging).unwrap();
        stale_repo
            .remote("origin", origin.to_str().unwrap())
            .unwrap();
        std::fs::write(stale_staging.join("partial.pack"), "interrupted").unwrap();
        assert!(read_managed(&base).is_empty());
        let progress = Arc::new(Mutex::new(Vec::new()));
        let captured = progress.clone();
        let root = clone_managed(&base, &identity, origin.to_str().unwrap(), move |update| {
            captured.lock().unwrap().push(update)
        })
        .unwrap();

        assert!(!clone_staging_path(&base, &identity).exists());

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
        let error = clone_managed(&base, &identity, "/does/not/exist", |_| {}).unwrap_err();
        assert!(error.contains("Could not download owner/missing"));
        assert!(error.contains("partial download was removed"));
        assert!(!target.exists());
        assert!(!clone_staging_path(&base, &identity).exists());
        assert!(!base.join("owner").exists());
    }

    #[test]
    fn doctor_repairs_origin_and_corrupt_index() {
        let temp = tempfile::tempdir().unwrap();
        let origin = init_origin(temp.path());
        let base = temp.path().join("repos");
        let identity = RepoIdentity {
            owner: "owner".into(),
            name: "site".into(),
        };
        let root = clone_managed(&base, &identity, origin.to_str().unwrap(), |_| {}).unwrap();
        let repo = Repository::open(&root).unwrap();
        repo.remote_delete("origin").unwrap();
        let index_path = repo.path().join("index");
        drop(repo);
        std::fs::write(&index_path, "not a git index").unwrap();

        let expected_url = "https://github.com/owner/site.git";
        assert_eq!(
            doctor_managed(&base, &root, expected_url).unwrap(),
            "Repository repaired."
        );
        let repaired = Repository::open(&root).unwrap();
        assert_eq!(
            repaired.find_remote("origin").unwrap().url().unwrap(),
            expected_url
        );
        assert!(repaired.index().is_ok());
    }

    #[test]
    fn broken_managed_directory_can_be_removed_for_redownload() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join("repos");
        let root = base.join("owner/site");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("partial-data"), "broken").unwrap();

        assert_eq!(
            read_managed(&base),
            vec![ManagedRepo {
                owner: "owner".into(),
                name: "site".into(),
                root: root.to_string_lossy().to_string(),
                url: "https://github.com/owner/site.git".into(),
            }]
        );

        remove_managed(&base, &root).unwrap();
        assert!(!root.exists());
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

pub mod creds;

use git2::build::CheckoutBuilder;
use git2::{
    Branch, FetchOptions, IndexAddOption, MergeOptions, PushOptions, Repository, Signature,
    StashApplyOptions, StashFlags, Status, StatusOptions,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Emitter;

use creds::{platform_creds, platform_signature, remote_callbacks};

#[derive(Serialize)]
pub struct ChangedFile {
    /// Porcelain XY status collapsed to one code: "M", "A", "D", "R", "??", ...
    pub status: String,
    pub path: String,
}

/// `owner/name` parsed from a repository's GitHub remote.
#[derive(Debug, PartialEq, Serialize)]
pub struct GitHubSlug {
    pub owner: String,
    pub name: String,
}

fn err_str(e: git2::Error) -> String {
    e.message().to_string()
}

/// Extracts `owner/name` from a GitHub remote URL, handling both HTTPS
/// (`https://github.com/owner/name.git`) and SSH (`git@github.com:owner/name`)
/// forms. Returns `None` for non-GitHub remotes.
fn parse_github_slug(url: &str) -> Option<GitHubSlug> {
    let rest = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("git@github.com:"))
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let (owner, name) = rest.split_once('/')?;
    if owner.is_empty() || name.is_empty() || name.contains('/') {
        return None;
    }
    Some(GitHubSlug {
        owner: owner.to_string(),
        name: name.to_string(),
    })
}

/// All git operations behind one libgit2-backed client. Works against any
/// local repository path; network authentication comes from the platform's
/// `CredentialProvider`.
pub struct Client {
    repo: Repository,
    /// Repo-relative subtree selected as the editor's work directory.
    scope: PathBuf,
}

impl Client {
    pub fn open(root: &str) -> Result<Client, String> {
        // The chosen directory is not necessarily the repository root.
        let repo = Repository::discover(root).map_err(err_str)?;
        let workdir = repo
            .workdir()
            .ok_or_else(|| "Repository has no working directory".to_string())?
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let selected = Path::new(root)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let scope = selected
            .strip_prefix(&workdir)
            .map_err(|_| "Selected directory is outside the repository".to_string())?
            .to_path_buf();
        Ok(Client { repo, scope })
    }

    fn signature(&self) -> Result<Signature<'static>, String> {
        platform_signature(&self.repo)
    }

    fn workdir(&self) -> Result<&Path, String> {
        self.repo
            .workdir()
            .ok_or_else(|| "Repository has no working directory".to_string())
    }

    /// The porcelain-style code the frontend expects ("M", "A", "D", "??", …).
    fn porcelain_code(status: Status) -> Option<String> {
        if status.is_conflicted() {
            return Some("UU".to_string());
        }
        if status.is_wt_new()
            && !status.intersects(
                Status::INDEX_NEW
                    | Status::INDEX_MODIFIED
                    | Status::INDEX_DELETED
                    | Status::INDEX_RENAMED
                    | Status::INDEX_TYPECHANGE,
            )
        {
            return Some("??".to_string());
        }
        let x = if status.is_index_new() {
            'A'
        } else if status.is_index_modified() {
            'M'
        } else if status.is_index_deleted() {
            'D'
        } else if status.is_index_renamed() {
            'R'
        } else if status.is_index_typechange() {
            'T'
        } else {
            ' '
        };
        let y = if status.is_wt_modified() {
            'M'
        } else if status.is_wt_deleted() {
            'D'
        } else if status.is_wt_renamed() {
            'R'
        } else if status.is_wt_typechange() {
            'T'
        } else {
            ' '
        };
        let code = format!("{x}{y}").trim().to_string();
        (!code.is_empty()).then_some(code)
    }

    fn repo_status_options() -> StatusOptions {
        let mut opts = StatusOptions::new();
        opts.include_untracked(true)
            .recurse_untracked_dirs(true)
            // Mobile repositories can contain large vendored submodules and
            // media trees. Publishing only needs the changed paths; expensive
            // rename detection and submodule traversal add no useful detail.
            .renames_head_to_index(false)
            .exclude_submodules(true)
            .update_index(false);
        opts
    }

    fn scoped_status_options(&self) -> StatusOptions {
        let mut opts = Self::repo_status_options();
        if !self.scope.as_os_str().is_empty() {
            opts.pathspec(&self.scope);
        }
        opts
    }

    pub fn changed_files(&self) -> Result<Vec<ChangedFile>, String> {
        let statuses = self
            .repo
            .statuses(Some(&mut self.scoped_status_options()))
            .map_err(err_str)?;
        let mut out = Vec::new();
        for entry in statuses.iter() {
            let Some(code) = Self::porcelain_code(entry.status()) else {
                continue;
            };
            // Renames list as "old -> new", matching porcelain output.
            let path = if entry.status().is_index_renamed() {
                let delta = entry.head_to_index();
                let old = delta
                    .as_ref()
                    .and_then(|d| d.old_file().path())
                    .map(|p| p.to_string_lossy().to_string());
                let new = delta
                    .as_ref()
                    .and_then(|d| d.new_file().path())
                    .map(|p| p.to_string_lossy().to_string());
                match (old, new) {
                    (Some(old), Some(new)) => format!("{old} -> {new}"),
                    _ => entry.path().unwrap_or_default().to_string(),
                }
            } else {
                entry.path().unwrap_or_default().to_string()
            };
            out.push(ChangedFile { status: code, path });
        }
        Ok(out)
    }

    /// The `owner/name` of the `origin` remote when it points at GitHub.
    /// `None` when there is no origin or it isn't a GitHub remote.
    pub fn github_remote(&self) -> Option<GitHubSlug> {
        let remote = self.repo.find_remote("origin").ok()?;
        parse_github_slug(remote.url().ok()?)
    }

    fn is_dirty(&self) -> Result<bool, String> {
        Ok(!self
            .repo
            .statuses(Some(&mut self.scoped_status_options()))
            .map_err(err_str)?
            .is_empty())
    }

    fn has_out_of_scope_changes(&self) -> Result<bool, String> {
        if self.scope.as_os_str().is_empty() {
            return Ok(false);
        }
        let statuses = self
            .repo
            .statuses(Some(&mut Self::repo_status_options()))
            .map_err(err_str)?;
        Ok(statuses.iter().any(|entry| {
            entry
                .path()
                .map(|path| !Path::new(path).starts_with(&self.scope))
                .unwrap_or(false)
        }))
    }

    /// Reverts one file to its committed state; `path` is repo-relative.
    /// Untracked files have no committed state, so revert deletes them.
    pub fn revert_file(&self, path: &str) -> Result<(), String> {
        self.revert_file_with_status(path, None)
    }

    pub fn revert_file_with_status(
        &self,
        path: &str,
        status_hint: Option<&str>,
    ) -> Result<(), String> {
        if !self.scope.as_os_str().is_empty() && !Path::new(path).starts_with(&self.scope) {
            return Err(format!("{path} is outside the selected project"));
        }
        let untracked = match status_hint {
            Some(status) => status == "??",
            None => {
                let status = self.repo.status_file(Path::new(path)).map_err(err_str)?;
                status.is_wt_new() && !status.is_index_new()
            }
        };
        if untracked {
            let absolute = self.workdir()?.join(path);
            return std::fs::remove_file(&absolute)
                .map_err(|e| format!("Failed to delete {}: {e}", absolute.display()));
        }
        let head = self.repo.head().map_err(err_str)?;
        let commit = head.peel_to_commit().map_err(err_str)?;
        let tree = commit.tree().map_err(err_str)?;
        if tree.get_path(Path::new(path)).is_err() {
            return Err(format!("{path} has no committed state to revert to"));
        }
        // Restores both index and working tree from HEAD (checkout HEAD -- path).
        let mut checkout = CheckoutBuilder::new();
        checkout.force().path(path);
        self.repo
            .checkout_tree(tree.as_object(), Some(&mut checkout))
            .map_err(err_str)
    }

    /// The upstream branch of HEAD, or an error when there is none — callers
    /// treat that as "nothing to fetch".
    fn upstream(&self) -> Result<Branch<'_>, String> {
        let head = self.repo.head().map_err(err_str)?;
        if !head.is_branch() {
            return Err("Not on a branch".to_string());
        }
        Branch::wrap(head)
            .upstream()
            .map_err(|_| "No upstream branch configured".to_string())
    }

    fn fetch(&self) -> Result<(), String> {
        let head = self.repo.head().map_err(err_str)?;
        let refname = head.name().map_err(err_str)?;
        let remote_name = self
            .repo
            .branch_upstream_remote(refname)
            .map_err(|_| "No upstream branch configured".to_string())?;
        let remote_name = remote_name.as_str().map_err(err_str)?;
        let mut remote = self.repo.find_remote(remote_name).map_err(err_str)?;
        let config = self.repo.config().map_err(err_str)?;
        let mut opts = FetchOptions::new();
        opts.remote_callbacks(remote_callbacks(config, platform_creds()));
        // Empty refspec list = the remote's configured fetch refspecs, which
        // is what plain `git fetch` did.
        remote
            .fetch(&[] as &[&str], Some(&mut opts), None)
            .map_err(err_str)
    }

    /// Fetches and reports whether the upstream has commits HEAD lacks.
    pub fn fetch_and_check_behind(&self) -> Result<bool, String> {
        self.fetch()?;
        self.behind_upstream()
    }

    fn behind_upstream(&self) -> Result<bool, String> {
        let local = self
            .repo
            .head()
            .map_err(err_str)?
            .target()
            .ok_or("Unborn HEAD")?;
        let upstream = self
            .upstream()?
            .get()
            .target()
            .ok_or("Upstream branch has no commits")?;
        let (_, behind) = self
            .repo
            .graph_ahead_behind(local, upstream)
            .map_err(err_str)?;
        Ok(behind > 0)
    }

    /// One merge attempt of the already-fetched upstream into HEAD, server
    /// wins on content conflicts (`-X theirs`). The merge is computed
    /// in-memory first, so a failure — real conflicts libgit2 can't favor
    /// away, or local edits the checkout would overwrite — leaves the
    /// repository untouched (no MERGE_HEAD, no abort needed).
    fn merge_upstream(&self) -> Result<(), String> {
        let upstream = self.upstream()?;
        let upstream_oid = upstream
            .get()
            .target()
            .ok_or("Upstream branch has no commits")?;
        let annotated = self
            .repo
            .find_annotated_commit(upstream_oid)
            .map_err(err_str)?;
        let (analysis, _) = self.repo.merge_analysis(&[&annotated]).map_err(err_str)?;
        if analysis.is_up_to_date() {
            return Ok(());
        }
        let upstream_commit = self.repo.find_commit(upstream_oid).map_err(err_str)?;
        let head = self.repo.head().map_err(err_str)?;
        let refname = head.name().map_err(err_str)?.to_string();
        if analysis.is_fast_forward() {
            // Safe checkout: refuses (and changes nothing) when local edits
            // overlap the incoming changes — the caller stashes and retries.
            let tree = upstream_commit.tree().map_err(err_str)?;
            self.repo
                .checkout_tree(tree.as_object(), Some(CheckoutBuilder::new().safe()))
                .map_err(err_str)?;
            self.repo
                .find_reference(&refname)
                .map_err(err_str)?
                .set_target(upstream_oid, "pull: fast-forward")
                .map_err(err_str)?;
            let mut index = self.repo.index().map_err(err_str)?;
            index.read_tree(&tree).map_err(err_str)?;
            index.write().map_err(err_str)?;
            return Ok(());
        }
        let local_commit = head.peel_to_commit().map_err(err_str)?;
        let mut merge_opts = MergeOptions::new();
        merge_opts.file_favor(git2::FileFavor::Theirs);
        let mut merged = self
            .repo
            .merge_commits(&local_commit, &upstream_commit, Some(&merge_opts))
            .map_err(err_str)?;
        if merged.has_conflicts() {
            // -X theirs settles content conflicts; what remains (e.g.
            // modify/delete) is a real failure, same as CLI merge.
            return Err("The server's changes could not be merged automatically".to_string());
        }
        let tree_oid = merged.write_tree_to(&self.repo).map_err(err_str)?;
        let tree = self.repo.find_tree(tree_oid).map_err(err_str)?;
        self.repo
            .checkout_tree(tree.as_object(), Some(CheckoutBuilder::new().safe()))
            .map_err(err_str)?;
        let mut index = self.repo.index().map_err(err_str)?;
        index.read_tree(&tree).map_err(err_str)?;
        index.write().map_err(err_str)?;
        let sig = self.signature()?;
        let upstream_name = upstream
            .name()
            .ok()
            .flatten()
            .unwrap_or("upstream")
            .to_string();
        self.repo
            .commit(
                Some("HEAD"),
                &sig,
                &sig,
                &format!("Merge remote-tracking branch '{upstream_name}'"),
                &tree,
                &[&local_commit, &upstream_commit],
            )
            .map_err(err_str)?;
        Ok(())
    }

    /// Pulls the upstream with "server wins" semantics; see the command doc.
    pub fn pull(&mut self) -> Result<String, String> {
        self.fetch()?;
        let first = match self.merge_upstream() {
            Ok(()) => return Ok("Updated from server.".to_string()),
            Err(e) => e,
        };
        if self.has_out_of_scope_changes()? {
            return Err(
                "Pull blocked because unpublished changes outside the selected project conflict with incoming updates. Resolve the repository changes manually, then try again."
                    .to_string(),
            );
        }
        if !self.is_dirty()? {
            // A clean tree that still can't merge is a real failure (unrelated
            // histories, conflicts -X theirs can't settle, …).
            return Err(first);
        }
        // Uncommitted local edits block the merge: stash them around it —
        // reapplied afterwards, except where they collide with what the
        // server changed (the merged version is kept there).
        let sig = self.signature()?;
        self.repo
            .stash_save(&sig, "posto-fetch", Some(StashFlags::INCLUDE_UNTRACKED))
            .map_err(err_str)?;
        if let Err(e) = self.merge_upstream() {
            // Put the stashed edits back; on failure the stash stays intact.
            let mut opts = StashApplyOptions::new();
            if self.repo.stash_apply(0, Some(&mut opts)).is_ok() {
                let _ = self.repo.stash_drop(0);
            }
            return Err(e);
        }
        self.pop_stash_server_wins()?;
        Ok("Updated from server.".to_string())
    }

    /// `git stash pop`, where conflicts resolve to the merged (server)
    /// version and the stash is dropped regardless — local edits that
    /// collide with the server's changes are deliberately discarded.
    fn pop_stash_server_wins(&mut self) -> Result<(), String> {
        let mut opts = StashApplyOptions::new();
        let mut checkout = CheckoutBuilder::new();
        checkout.allow_conflicts(true);
        opts.checkout_options(checkout);
        let _ = self.repo.stash_apply(0, Some(&mut opts));
        let mut conflicted: Vec<String> = Vec::new();
        {
            let index = self.repo.index().map_err(err_str)?;
            let conflict_iter = index.conflicts();
            if let Ok(conflicts) = conflict_iter {
                for conflict in conflicts.filter_map(|c| c.ok()) {
                    if let Some(entry) = conflict
                        .our
                        .as_ref()
                        .or(conflict.their.as_ref())
                        .or(conflict.ancestor.as_ref())
                    {
                        conflicted.push(String::from_utf8_lossy(&entry.path).to_string());
                    }
                }
            }
        }
        if !conflicted.is_empty() {
            // Keep the merged version of each conflicted file (HEAD holds it
            // — the merge commit already landed), then unstage everything.
            let head_tree = self
                .repo
                .head()
                .and_then(|h| h.peel_to_tree())
                .map_err(err_str)?;
            let mut checkout = CheckoutBuilder::new();
            checkout.force();
            for path in &conflicted {
                checkout.path(path);
            }
            self.repo
                .checkout_tree(head_tree.as_object(), Some(&mut checkout))
                .map_err(err_str)?;
            let head_obj = self.repo.revparse_single("HEAD").map_err(err_str)?;
            self.repo
                .reset(&head_obj, git2::ResetType::Mixed, None)
                .map_err(err_str)?;
        }
        self.repo.stash_drop(0).map_err(err_str)?;
        Ok(())
    }

    /// Stages everything, commits, and pushes HEAD to origin.
    pub fn publish(&self, message: &str) -> Result<String, String> {
        let mut index = self.repo.index().map_err(err_str)?;
        // add_all picks up new/modified files, update_all staged deletions —
        // together they are `git add -A`.
        let scope = if self.scope.as_os_str().is_empty() {
            "*".to_string()
        } else {
            self.scope.to_string_lossy().to_string()
        };
        index
            .add_all([scope.as_str()].iter(), IndexAddOption::DEFAULT, None)
            .map_err(err_str)?;
        index
            .update_all([scope.as_str()].iter(), None)
            .map_err(err_str)?;
        index.write().map_err(err_str)?;
        let head_commit = self.repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let tree_oid = if self.scope.as_os_str().is_empty() {
            index.write_tree().map_err(err_str)?
        } else {
            // The repository index may already contain staged sibling work.
            // Build the publish tree from HEAD plus only this selected subtree,
            // while leaving the real index (and those staged changes) intact.
            let mut publish_index = git2::Index::new().map_err(err_str)?;
            if let Some(head) = &head_commit {
                publish_index
                    .read_tree(&head.tree().map_err(err_str)?)
                    .map_err(err_str)?;
            }
            if let Err(error) = publish_index.remove_dir(&self.scope, 0) {
                if error.code() != git2::ErrorCode::NotFound {
                    return Err(err_str(error));
                }
            }
            let scope = self.scope.to_string_lossy().replace('\\', "/");
            let prefix = format!("{scope}/");
            for entry in index.iter() {
                let path = String::from_utf8_lossy(&entry.path);
                if path == scope || path.starts_with(&prefix) {
                    publish_index.add(&entry).map_err(err_str)?;
                }
            }
            publish_index.write_tree_to(&self.repo).map_err(err_str)?
        };
        if let Some(head_commit) = &head_commit {
            if head_commit.tree_id() == tree_oid {
                return Ok("Nothing to publish — no local changes.".to_string());
            }
        }
        let tree = self.repo.find_tree(tree_oid).map_err(err_str)?;
        let sig = self.signature()?;
        let parents: Vec<&git2::Commit> = head_commit.iter().collect();
        self.repo
            .commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
            .map_err(err_str)?;

        let head = self.repo.head().map_err(err_str)?;
        let refname = head.name().map_err(err_str)?;
        let mut remote = self.repo.find_remote("origin").map_err(err_str)?;
        let config = self.repo.config().map_err(err_str)?;
        // Per-ref push failures (non-fast-forward, rejected hooks) surface
        // through this callback, not as an Err from push().
        let rejection = std::rc::Rc::new(std::cell::RefCell::new(None::<String>));
        let rejection_cb = rejection.clone();
        let mut callbacks = remote_callbacks(config, platform_creds());
        callbacks.push_update_reference(move |_refname, status| {
            if let Some(status) = status {
                *rejection_cb.borrow_mut() = Some(status.to_string());
            }
            Ok(())
        });
        let mut opts = PushOptions::new();
        opts.remote_callbacks(callbacks);
        remote
            .push(&[format!("{refname}:{refname}")], Some(&mut opts))
            .map_err(err_str)?;
        if let Some(rejection) = rejection.borrow().as_ref() {
            return Err(format!("Push rejected: {rejection}"));
        }
        Ok("Published.".to_string())
    }
}

#[tauri::command]
pub async fn changed_files(root: String) -> Result<Vec<ChangedFile>, String> {
    tauri::async_runtime::spawn_blocking(move || Client::open(&root)?.changed_files())
        .await
        .map_err(|e| e.to_string())?
}

/// The GitHub `owner/name` of the repository containing `root`, or `None` when
/// the directory isn't a git repo or its origin isn't a GitHub remote. Never
/// errors — a missing remote is a normal "no deployment info" case.
#[tauri::command]
pub async fn github_remote(root: String) -> Result<Option<GitHubSlug>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(Client::open(&root)
            .ok()
            .and_then(|client| client.github_remote()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reverts one changed file to its committed state. `path` is repo-relative
/// (as reported by `changed_files`). Untracked files have no committed state,
/// so revert means deleting them.
#[tauri::command]
pub async fn revert_file(root: String, path: String, status: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        Client::open(&root)?.revert_file_with_status(&path, status.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Fetches the remote and reports whether the upstream branch has commits the
/// local branch lacks. Errors out when there is no remote/upstream — callers
/// treat that as "nothing to fetch".
#[tauri::command]
pub async fn fetch_upstream(root: String) -> Result<bool, String> {
    Client::open(&root)?.fetch_and_check_behind()
}

/// Merges the already-fetched upstream branch into the working tree. The
/// server always wins: committed conflicts resolve in the server's favor, and
/// when a merge is blocked by uncommitted local edits those are stashed
/// around the merge — reapplied afterwards, except where they collide with
/// what the server changed (the merged version is kept there).
#[tauri::command]
pub async fn pull_upstream(app: tauri::AppHandle, root: String) -> Result<String, String> {
    let result = Client::open(&root)?.pull()?;
    let _ = app.emit("fs-changed", vec![root]);
    Ok(result)
}

#[tauri::command]
pub async fn publish(root: String, message: Option<String>) -> Result<String, String> {
    let message = message
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| "Site updates".to_string());
    Client::open(&root)?.publish(&message)
}

#[cfg(test)]
mod tests {
    use super::{parse_github_slug, GitHubSlug};

    fn slug(owner: &str, name: &str) -> Option<GitHubSlug> {
        Some(GitHubSlug {
            owner: owner.to_string(),
            name: name.to_string(),
        })
    }

    #[test]
    fn parses_https_and_ssh_github_remotes() {
        assert_eq!(
            parse_github_slug("https://github.com/megaflorasoftware/posto.git"),
            slug("megaflorasoftware", "posto"),
        );
        assert_eq!(
            parse_github_slug("https://github.com/megaflorasoftware/posto"),
            slug("megaflorasoftware", "posto"),
        );
        assert_eq!(
            parse_github_slug("git@github.com:megaflorasoftware/posto.git"),
            slug("megaflorasoftware", "posto"),
        );
        assert_eq!(
            parse_github_slug("ssh://git@github.com/megaflorasoftware/posto.git"),
            slug("megaflorasoftware", "posto"),
        );
    }

    #[test]
    fn rejects_non_github_and_malformed_remotes() {
        assert_eq!(parse_github_slug("https://gitlab.com/owner/name.git"), None);
        assert_eq!(parse_github_slug("https://github.com/owner"), None);
        assert_eq!(parse_github_slug("https://github.com/owner/"), None);
        assert_eq!(parse_github_slug("https://github.com/owner/a/b"), None);
    }
}

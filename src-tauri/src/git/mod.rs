pub mod creds;

use fs2::FileExt;
use git2::build::CheckoutBuilder;
use git2::{
    Branch, FetchOptions, IndexAddOption, MergeOptions, PushOptions, Repository, Signature,
    StashApplyOptions, StashFlags, Status, StatusOptions,
};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::Emitter;

use crate::media::journal;
use creds::{platform_creds, platform_signature, remote_callbacks};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
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

/// One entry in the branch chooser. `local` is false for branches that only
/// exist on a remote (as of the last fetch).
#[derive(Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub current: bool,
    pub local: bool,
}

/// Result of a branch checkout attempt. When a safe checkout refuses because
/// local changes would be lost, `switched` is false and `conflicts` lists the
/// affected repo-relative paths so the UI can ask before forcing.
#[derive(Serialize)]
pub struct CheckoutOutcome {
    pub switched: bool,
    pub conflicts: Vec<String>,
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
        let _lock = self.lock()?;
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
        // A branch with no upstream still fetches origin, so remote branch
        // listings stay fresh; behind-checks still report "no upstream".
        let remote_name = match self.repo.branch_upstream_remote(refname) {
            Ok(name) => name.as_str().map_err(err_str)?.to_string(),
            Err(_) => "origin".to_string(),
        };
        let mut remote = self.repo.find_remote(&remote_name).map_err(err_str)?;
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
        let _lock = self.lock()?;
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

    /// Short name of the branch HEAD points at; `None` when detached or the
    /// repository has no commits yet — the branch chooser hides then.
    pub fn current_branch(&self) -> Result<Option<String>, String> {
        let head = match self.repo.head() {
            Ok(head) => head,
            Err(e) if e.code() == git2::ErrorCode::UnbornBranch => return Ok(None),
            Err(e) => return Err(err_str(e)),
        };
        if !head.is_branch() {
            return Ok(None);
        }
        Ok(head.shorthand().ok().map(|name| name.to_string()))
    }

    /// Local branches plus remote-only branches (from the last fetch), deduped
    /// by short name: current first, then locals A→Z, then remote-only A→Z.
    pub fn list_branches(&self) -> Result<Vec<BranchInfo>, String> {
        let current = self.current_branch()?;
        let mut out: Vec<BranchInfo> = Vec::new();
        for entry in self
            .repo
            .branches(Some(git2::BranchType::Local))
            .map_err(err_str)?
        {
            let (branch, _) = entry.map_err(err_str)?;
            let Some(name) = branch.name().ok().flatten() else {
                continue;
            };
            out.push(BranchInfo {
                name: name.to_string(),
                current: current.as_deref() == Some(name),
                local: true,
            });
        }
        for entry in self
            .repo
            .branches(Some(git2::BranchType::Remote))
            .map_err(err_str)?
        {
            let (branch, _) = entry.map_err(err_str)?;
            // Remote branch names are "<remote>/<branch>"; "origin/HEAD" is
            // the symbolic default-branch pointer, not a real branch.
            let Some(full) = branch.name().ok().flatten() else {
                continue;
            };
            let Some((_, short)) = full.split_once('/') else {
                continue;
            };
            if short == "HEAD" || out.iter().any(|known| known.name == short) {
                continue;
            }
            out.push(BranchInfo {
                name: short.to_string(),
                current: false,
                local: false,
            });
        }
        out.sort_by(|a, b| {
            b.current
                .cmp(&a.current)
                .then(b.local.cmp(&a.local))
                .then(a.name.cmp(&b.name))
        });
        Ok(out)
    }

    /// The remote-tracking branch named `name` on any remote, origin first
    /// (matching where publish pushes), with its full "remote/name" ref.
    fn find_remote_branch(&self, name: &str) -> Result<(Branch<'_>, String), String> {
        let remotes = self.repo.remotes().map_err(err_str)?;
        let mut candidates: Vec<&str> = remotes
            .iter()
            .filter_map(|remote| remote.ok().flatten())
            .collect();
        candidates.sort_by_key(|remote| *remote != "origin");
        for remote in candidates {
            let full = format!("{remote}/{name}");
            if let Ok(branch) = self.repo.find_branch(&full, git2::BranchType::Remote) {
                return Ok((branch, full));
            }
        }
        Err(format!("Branch {name} was not found"))
    }

    /// Checks out `name`. `create` branches off HEAD (`git checkout -b`); a
    /// name that only exists on a remote is materialized as a local tracking
    /// branch first. Without `force`, a checkout that would lose local edits
    /// changes nothing and returns the at-risk paths instead.
    pub fn checkout_branch(
        &self,
        name: &str,
        create: bool,
        force: bool,
    ) -> Result<CheckoutOutcome, String> {
        let _lock = self.lock()?;
        let refname = format!("refs/heads/{name}");
        if create {
            let head = self
                .repo
                .head()
                .and_then(|head| head.peel_to_commit())
                .map_err(err_str)?;
            self.repo.branch(name, &head, false).map_err(err_str)?;
            // Same commit, same tree — only HEAD moves.
            self.repo.set_head(&refname).map_err(err_str)?;
            return Ok(CheckoutOutcome {
                switched: true,
                conflicts: Vec::new(),
            });
        }
        if self
            .repo
            .find_branch(name, git2::BranchType::Local)
            .is_err()
        {
            let (remote_branch, remote_name) = self.find_remote_branch(name)?;
            let commit = remote_branch.get().peel_to_commit().map_err(err_str)?;
            let mut local = self.repo.branch(name, &commit, false).map_err(err_str)?;
            local.set_upstream(Some(&remote_name)).map_err(err_str)?;
        }
        let target = self.repo.revparse_single(&refname).map_err(err_str)?;
        let conflicts = std::rc::Rc::new(std::cell::RefCell::new(Vec::<String>::new()));
        let mut checkout = CheckoutBuilder::new();
        if force {
            checkout.force();
        } else {
            let conflicts_cb = conflicts.clone();
            checkout.safe();
            checkout.notify_on(git2::CheckoutNotificationType::CONFLICT);
            checkout.notify(move |_, path, _, _, _| {
                if let Some(path) = path {
                    conflicts_cb
                        .borrow_mut()
                        .push(path.to_string_lossy().to_string());
                }
                true
            });
        }
        match self.repo.checkout_tree(&target, Some(&mut checkout)) {
            Ok(()) => {}
            Err(e) if !force && e.code() == git2::ErrorCode::Conflict => {
                return Ok(CheckoutOutcome {
                    switched: false,
                    conflicts: conflicts.borrow().clone(),
                });
            }
            Err(e) => return Err(err_str(e)),
        }
        self.repo.set_head(&refname).map_err(err_str)?;
        Ok(CheckoutOutcome {
            switched: true,
            conflicts: Vec::new(),
        })
    }

    /// Takes the repository-wide lock that serializes operations which rewrite
    /// HEAD, the index, or the working tree. It is released on drop. Refused
    /// while an interrupted media publish still has to be recovered.
    pub fn lock(&self) -> Result<RepositoryLock, String> {
        let lock = self.lock_for_recovery()?;
        if journal::exists(self.repo.path()) {
            return Err(
                "A previous publish didn't finish. Reopen this project to recover it, then try again."
                    .to_string(),
            );
        }
        Ok(lock)
    }

    /// The repository lock without the interrupted-publish check.
    pub(crate) fn lock_for_recovery(&self) -> Result<RepositoryLock, String> {
        let directory = self.repo.commondir().join("posto");
        std::fs::create_dir_all(&directory)
            .map_err(|error| format!("Could not prepare the repository lock: {error}"))?;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(directory.join("publish.lock"))
            .map_err(|error| format!("Could not open the repository lock: {error}"))?;
        file.try_lock_exclusive().map_err(|_| {
            "Another publish or sync is still running for this repository. Try again when it finishes."
                .to_string()
        })?;
        Ok(RepositoryLock { _file: file })
    }

    /// The canonical working directory of the repository.
    pub(crate) fn workdir_path(&self) -> Result<PathBuf, String> {
        self.workdir()?
            .canonicalize()
            .map_err(|error| error.to_string())
    }

    /// Whether the commit at HEAD contains a repository-relative path.
    pub(crate) fn head_contains(&self, path: &Path) -> bool {
        self.repo
            .head()
            .and_then(|head| head.peel_to_tree())
            .is_ok_and(|tree| tree.get_path(path).is_ok())
    }

    /// The repository's git directory, which is private to this worktree.
    pub(crate) fn git_dir(&self) -> &Path {
        self.repo.path()
    }

    pub(crate) fn head_oid(&self) -> Option<git2::Oid> {
        self.repo.head().ok().and_then(|head| head.target())
    }

    pub(crate) fn parent_oid(&self, commit: git2::Oid) -> Option<git2::Oid> {
        self.repo.find_commit(commit).ok()?.parent_id(0).ok()
    }

    /// Whether git ignores a file. Ignored files are never part of a publish.
    pub(crate) fn is_ignored(&self, path: &Path) -> Result<bool, String> {
        let workdir = self
            .workdir()?
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let relative = path
            .strip_prefix(&workdir)
            .map_err(|_| format!("{} is outside the repository", path.display()))?;
        self.repo.is_path_ignored(relative).map_err(err_str)
    }

    /// What `changed_files` will report once `writes` replace those files'
    /// contents and `removals` are deleted, without touching either. Git
    /// compares the planned contents with the last commit, so a file that
    /// ends up matching it, or a new file that's removed, isn't listed.
    pub fn changed_files_after(
        &self,
        writes: Vec<(String, String)>,
        removals: Vec<String>,
    ) -> Result<Vec<ChangedFile>, String> {
        let workdir = self
            .workdir()?
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let relative = |path: &str| -> Option<String> {
            let resolved = Path::new(path).canonicalize().ok()?;
            let relative = resolved.strip_prefix(&workdir).ok()?;
            Some(relative.to_string_lossy().replace('\\', "/"))
        };
        let mut planned: BTreeMap<String, Option<Vec<u8>>> = BTreeMap::new();
        for (path, content) in writes {
            if let Some(path) = relative(&path) {
                planned.insert(path, Some(content.into_bytes()));
            }
        }
        for path in removals {
            if let Some(path) = relative(&path) {
                planned.insert(path, None);
            }
        }
        let current = self.changed_files()?;
        let head = self
            .repo
            .head()
            .ok()
            .and_then(|head| head.peel_to_tree().ok());
        let mut files: Vec<ChangedFile> = current
            .iter()
            .filter(|file| !planned.contains_key(&file.path))
            .cloned()
            .collect();
        for (path, content) in planned {
            let committed = head
                .as_ref()
                .and_then(|tree| tree.get_path(Path::new(&path)).ok())
                .and_then(|entry| self.repo.find_blob(entry.id()).ok());
            let status = match (committed, content) {
                (None, None) => continue,
                (None, Some(_)) => current
                    .iter()
                    .find(|file| file.path == path)
                    .map_or("??".to_string(), |file| file.status.clone()),
                (Some(_), None) => "D".to_string(),
                (Some(blob), Some(content)) if blob.content() == content.as_slice() => continue,
                (Some(_), Some(_)) => "M".to_string(),
            };
            files.push(ChangedFile { status, path });
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(files)
    }

    /// The given files that git ignores. They never reach the published site,
    /// so nothing in them can still need an image. Paths outside the
    /// repository count as not ignored.
    pub fn ignored_paths(&self, paths: Vec<String>) -> Result<Vec<String>, String> {
        let workdir = self
            .workdir()?
            .canonicalize()
            .map_err(|error| error.to_string())?;
        Ok(paths
            .into_iter()
            .filter(|path| {
                let path = Path::new(path);
                let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
                resolved
                    .strip_prefix(&workdir)
                    .ok()
                    .and_then(|relative| self.repo.is_path_ignored(relative).ok())
                    .unwrap_or(false)
            })
            .collect())
    }

    pub(crate) fn capture_index(&self) -> Result<IndexSnapshot, String> {
        IndexSnapshot::capture(&self.repo)
    }

    pub(crate) fn restore_index(&self, snapshot: &IndexSnapshot) -> Result<(), String> {
        snapshot.restore(&self.repo)
    }

    /// Stages the selected scope and commits it, leaving the push to the
    /// caller. The working tree is never touched.
    pub(crate) fn commit_scoped(&self, message: &str) -> Result<ScopedCommit, String> {
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
                return Ok(ScopedCommit::Unchanged);
            }
        }
        let tree = self.repo.find_tree(tree_oid).map_err(err_str)?;
        let sig = self.signature()?;
        let parents: Vec<&git2::Commit> = head_commit.iter().collect();
        let commit = self
            .repo
            .commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
            .map_err(err_str)?;
        Ok(ScopedCommit::Created {
            commit,
            parent: head_commit.as_ref().map(git2::Commit::id),
        })
    }

    /// Whether HEAD holds commits its upstream lacks, such as a commit left by
    /// an earlier push that never landed. No upstream means nothing to compare.
    pub(crate) fn ahead_of_upstream(&self) -> bool {
        let Some(local) = self.repo.head().ok().and_then(|head| head.target()) else {
            return false;
        };
        let Some(upstream) = self
            .upstream()
            .ok()
            .and_then(|branch| branch.get().target())
        else {
            return false;
        };
        self.repo
            .graph_ahead_behind(local, upstream)
            .is_ok_and(|(ahead, _)| ahead > 0)
    }

    /// Pushes HEAD to origin and records origin as the upstream of a branch
    /// on its first push.
    pub(crate) fn push_head(&self) -> Result<(), PushFailure> {
        let transport = |error: git2::Error| PushFailure::Transport(err_str(error));
        let head = self.repo.head().map_err(transport)?;
        let refname = head.name().map_err(transport)?.to_string();
        let mut remote = self.repo.find_remote("origin").map_err(transport)?;
        let config = self.repo.config().map_err(transport)?;
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
            .map_err(transport)?;
        if let Some(rejection) = rejection.borrow().as_ref() {
            return Err(PushFailure::Rejected(format!("Push rejected: {rejection}")));
        }
        self.record_upstream();
        Ok(())
    }

    /// First push of a locally-created branch: record origin as its upstream
    /// so the fetch/behind indicators work on it from now on.
    pub(crate) fn record_upstream(&self) {
        let Ok(head) = self.repo.head() else {
            return;
        };
        if !head.is_branch() {
            return;
        }
        let mut branch = Branch::wrap(head);
        if branch.upstream().is_err() {
            let short = branch.name().ok().flatten().map(|name| name.to_string());
            if let Some(short) = short {
                let upstream = format!("origin/{short}");
                let _ = branch.set_upstream(Some(&upstream));
            }
        }
    }

    /// Whether origin's copy of HEAD's branch already points at `commit`. A
    /// connection that drops after the server accepted a push reports failure
    /// even though the commit landed.
    pub(crate) fn remote_commit_status(&self, commit: git2::Oid) -> RemoteCommit {
        let Some(refname) = self
            .repo
            .head()
            .ok()
            .and_then(|head| head.name().ok().map(str::to_string))
        else {
            return RemoteCommit::Unreachable;
        };
        let Ok(mut remote) = self.repo.find_remote("origin") else {
            return RemoteCommit::Unreachable;
        };
        let Ok(config) = self.repo.config() else {
            return RemoteCommit::Unreachable;
        };
        let callbacks = remote_callbacks(config, platform_creds());
        let Ok(connection) = remote.connect_auth(git2::Direction::Push, Some(callbacks), None)
        else {
            return RemoteCommit::Unreachable;
        };
        match connection.list() {
            Ok(heads)
                if heads
                    .iter()
                    .any(|head| head.name() == refname && head.oid() == commit) =>
            {
                RemoteCommit::Landed
            }
            Ok(_) => RemoteCommit::Absent,
            Err(_) => RemoteCommit::Unreachable,
        }
    }

    /// Removes a commit whose push failed, provided HEAD still points at it.
    /// The working tree is untouched, so the changes are ready to publish again.
    pub(crate) fn rollback_commit(
        &self,
        commit: git2::Oid,
        parent: Option<git2::Oid>,
    ) -> Result<(), String> {
        let head = self.repo.head().map_err(err_str)?;
        if head.target() != Some(commit) {
            return Err("HEAD moved while publishing".to_string());
        }
        const MESSAGE: &str = "posto: roll back unpublished commit";
        if head.is_branch() {
            let refname = head.name().map_err(err_str)?.to_string();
            match parent {
                Some(parent) => {
                    self.repo
                        .reference_matching(&refname, parent, true, commit, MESSAGE)
                        .map_err(err_str)?;
                }
                // The repository's first commit: return the branch to unborn.
                None => self
                    .repo
                    .find_reference(&refname)
                    .and_then(|mut reference| reference.delete())
                    .map_err(err_str)?,
            }
            return Ok(());
        }
        let parent = parent.ok_or("A detached first commit cannot be rolled back")?;
        self.repo.set_head_detached(parent).map_err(err_str)
    }

    /// Commits the selected scope and pushes it as one unit. If the push does
    /// not land, the commit and staging are undone so the changes stay visible
    /// and publishable; the working tree is never modified.
    pub fn publish(&self, message: &str) -> Result<String, String> {
        let _lock = self.lock()?;
        let snapshot = IndexSnapshot::capture(&self.repo)?;
        let committed = match self.commit_scoped(message) {
            Ok(committed) => committed,
            Err(error) => {
                return Err(match snapshot.restore(&self.repo) {
                    Ok(()) => error,
                    Err(restore) => format!("{error} (staging could not be restored: {restore})"),
                });
            }
        };
        let ScopedCommit::Created { commit, parent } = committed else {
            snapshot.restore(&self.repo)?;
            if !self.ahead_of_upstream() {
                return Ok("Nothing to publish — no local changes.".to_string());
            }
            // An earlier commit never reached origin, so pushing is the work.
            return self
                .push_head()
                .map(|()| "Published.".to_string())
                .map_err(PushFailure::into_message);
        };
        let failure = match self.push_head() {
            Ok(()) => return Ok("Published.".to_string()),
            Err(failure) => failure,
        };
        if matches!(failure, PushFailure::Transport(_))
            && self.remote_commit_status(commit) == RemoteCommit::Landed
        {
            self.record_upstream();
            return Ok("Published.".to_string());
        }
        let message = failure.into_message();
        let restored = self
            .rollback_commit(commit, parent)
            .and_then(|()| snapshot.restore(&self.repo));
        Err(match restored {
            Ok(()) => message,
            Err(error) => format!("{message} (the local commit could not be undone: {error})"),
        })
    }
}

/// Exclusive hold on a repository's publish lock; dropping it releases the lock.
pub struct RepositoryLock {
    _file: std::fs::File,
}

/// Whether a commit reached origin, as far as the remote can be asked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RemoteCommit {
    Landed,
    Absent,
    Unreachable,
}

/// What staging the selected scope produced.
pub(crate) enum ScopedCommit {
    /// The scope already matches HEAD, so no commit was made.
    Unchanged,
    Created {
        commit: git2::Oid,
        /// `None` when this is the repository's first commit.
        parent: Option<git2::Oid>,
    },
}

pub(crate) enum PushFailure {
    /// The remote answered and refused the update, so the commit did not land.
    Rejected(String),
    /// The connection failed, so the outcome must be checked against the remote.
    Transport(String),
}

impl PushFailure {
    pub(crate) fn into_message(self) -> String {
        match self {
            PushFailure::Rejected(message) | PushFailure::Transport(message) => message,
        }
    }
}

/// The on-disk index as it was before publishing staged anything. Restoring it
/// returns new files to untracked and preserves staged work outside the scope.
pub(crate) struct IndexSnapshot {
    pub(crate) path: PathBuf,
    /// `None` when the repository had no index file yet.
    pub(crate) bytes: Option<Vec<u8>>,
}

impl IndexSnapshot {
    fn capture(repo: &Repository) -> Result<Self, String> {
        let index = repo.index().map_err(err_str)?;
        let path = index
            .path()
            .map_or_else(|| repo.path().join("index"), Path::to_path_buf);
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("Could not read the git index: {error}")),
        };
        Ok(IndexSnapshot { path, bytes })
    }

    fn restore(&self, repo: &Repository) -> Result<(), String> {
        match &self.bytes {
            Some(bytes) => {
                let staged = self.path.with_extension("posto-restore");
                std::fs::write(&staged, bytes)
                    .and_then(|()| std::fs::rename(&staged, &self.path))
                    .map_err(|error| format!("Could not restore the git index: {error}"))?;
            }
            None => match std::fs::remove_file(&self.path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(format!("Could not restore the git index: {error}")),
            },
        }
        // The repository caches its index, so force a reload from disk.
        repo.index()
            .and_then(|mut index| index.read(true))
            .map_err(err_str)
    }
}

/// The changed files a publish will commit after applying planned rewrites
/// and removals.
#[tauri::command]
pub async fn changed_files_preview(
    root: String,
    writes: Vec<PreviewWrite>,
    removals: Vec<String>,
) -> Result<Vec<ChangedFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let writes = writes
            .into_iter()
            .map(|write| (write.path, write.content))
            .collect();
        Client::open(&root)?.changed_files_after(writes, removals)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Deserialize)]
pub struct PreviewWrite {
    pub path: String,
    pub content: String,
}

/// Which of `paths` git ignores.
#[tauri::command]
pub async fn ignored_paths(root: String, paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || Client::open(&root)?.ignored_paths(paths))
        .await
        .map_err(|e| e.to_string())?
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

/// Short name of the branch HEAD points at, or `None` when the directory
/// isn't a git repo, HEAD is detached, or the repo has no commits — the
/// branch chooser hides in all of those cases.
#[tauri::command]
pub async fn current_branch(root: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(Client::open(&root)
            .ok()
            .and_then(|client| client.current_branch().ok())
            .flatten())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Local and remote-tracking branches, deduped by short name. Purely local —
/// callers refresh the remote side with `fetch_upstream` when they want it.
#[tauri::command]
pub async fn list_branches(root: String) -> Result<Vec<BranchInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || Client::open(&root)?.list_branches())
        .await
        .map_err(|e| e.to_string())?
}

/// Checks out a branch (creating it from HEAD when `create`). A safe checkout
/// blocked by local edits returns `switched: false` plus the at-risk paths;
/// callers confirm with the user and retry with `force` to discard them.
#[tauri::command]
pub async fn checkout_branch(
    app: tauri::AppHandle,
    root: String,
    name: String,
    create: bool,
    force: bool,
) -> Result<CheckoutOutcome, String> {
    let dir = root.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        Client::open(&dir)?.checkout_branch(&name, create, force)
    })
    .await
    .map_err(|e| e.to_string())??;
    if outcome.switched {
        let _ = app.emit("fs-changed", vec![root]);
    }
    Ok(outcome)
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

#[cfg(test)]
mod branch_tests {
    use super::Client;
    use git2::{Repository, Signature};
    use std::path::Path;

    fn commit_file(repo: &Repository, name: &str, content: &str, message: &str) {
        std::fs::write(repo.workdir().unwrap().join(name), content).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(name)).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = Signature::now("Test", "test@example.com").unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<_> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
            .unwrap();
    }

    #[test]
    fn create_switch_and_conflict_flow() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        commit_file(&repo, "a.txt", "one\n", "init");
        let client = Client::open(dir.path().to_str().unwrap()).unwrap();
        let initial = client.current_branch().unwrap().unwrap();

        // Create-and-switch from HEAD.
        assert!(
            client
                .checkout_branch("other", true, false)
                .unwrap()
                .switched
        );
        assert_eq!(client.current_branch().unwrap().as_deref(), Some("other"));
        commit_file(&repo, "a.txt", "two\n", "change on other");

        // Plain switch back.
        assert!(
            client
                .checkout_branch(&initial, false, false)
                .unwrap()
                .switched
        );
        assert_eq!(
            std::fs::read_to_string(repo.workdir().unwrap().join("a.txt")).unwrap(),
            "one\n"
        );

        // A dirty edit that overlaps the target branch refuses the safe
        // checkout, reports the file, and leaves everything untouched.
        std::fs::write(repo.workdir().unwrap().join("a.txt"), "dirty\n").unwrap();
        let refused = client.checkout_branch("other", false, false).unwrap();
        assert!(!refused.switched);
        assert_eq!(refused.conflicts, vec!["a.txt".to_string()]);
        assert_eq!(client.current_branch().unwrap(), Some(initial.clone()));
        assert_eq!(
            std::fs::read_to_string(repo.workdir().unwrap().join("a.txt")).unwrap(),
            "dirty\n"
        );

        // Force discards the dirty edit and switches.
        assert!(
            client
                .checkout_branch("other", false, true)
                .unwrap()
                .switched
        );
        assert_eq!(client.current_branch().unwrap().as_deref(), Some("other"));
        assert_eq!(
            std::fs::read_to_string(repo.workdir().unwrap().join("a.txt")).unwrap(),
            "two\n"
        );

        // List: current branch first, everything here is local.
        let branches = client.list_branches().unwrap();
        assert_eq!(branches.len(), 2);
        assert_eq!(branches[0].name, "other");
        assert!(branches[0].current && branches[0].local);
        assert_eq!(branches[1].name, initial);
    }
}

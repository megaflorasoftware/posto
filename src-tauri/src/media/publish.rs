//! Publishes CDN-bound media as one transaction: uploads finish first, then
//! local content changes, commits, and pushes. A failure at any point before the
//! push lands returns the project to exactly how it was.

use futures_util::{stream, TryStreamExt};
use git2::Oid;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use super::blocking;
use super::deletes;
use super::journal::{self, BackedUpFile, Journal, Phase};
use super::probe::file_digest;
use super::provider::{validate_object_key, MediaSource, Provider, Upload};
use crate::git::{Client, IndexSnapshot, PushFailure, RemoteCommit, ScopedCommit};

const UPLOAD_CONCURRENCY: usize = 4;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishSource {
    pub name: String,
    pub prefix: Option<String>,
    #[serde(flatten)]
    pub connection: MediaSource,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedUpload {
    pub source_name: String,
    pub path: String,
    pub key: String,
    pub sha256: String,
    pub size: u64,
    pub content_type: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedWrite {
    pub path: String,
    pub previous: String,
    pub content: String,
}

/// A CDN object to delete once the publish has landed. It must match a
/// recorded delete, so the webview can't delete arbitrary objects.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedDelete {
    pub source_name: String,
    pub key: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishRequest {
    pub root: String,
    pub message: String,
    pub sources: Vec<PublishSource>,
    pub uploads: Vec<PlannedUpload>,
    pub writes: Vec<PlannedWrite>,
    pub removals: Vec<String>,
    #[serde(default)]
    pub deletes: Vec<PlannedDelete>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "stage")]
pub enum PublishProgress {
    Uploading { completed: usize, total: usize },
    Applying,
    Committing,
    Pushing,
    Finishing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishSummary {
    pub message: String,
    /// Local images left in place because git ignores them.
    pub kept: Vec<String>,
    /// CDN objects that couldn't be deleted. They're retried next publish.
    pub failed_deletes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum RecoveryOutcome {
    /// No publish was interrupted.
    Clean,
    /// The interrupted publish was undone and its changes are local again.
    RolledBack,
    /// The interrupted publish had reached origin and is now complete.
    Finalized,
    /// Origin can't be reached, so the outcome is still unknown.
    Blocked { message: String },
}

/// Test points for proving recovery from failures and crashes at each step.
#[doc(hidden)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Hooks {
    pub fail_at: Option<&'static str>,
    pub crash_at: Option<&'static str>,
}

enum Abort {
    Failed(String),
    /// Stops without cleanup, as a crash or force quit would.
    Crashed,
}

impl From<String> for Abort {
    fn from(error: String) -> Self {
        Self::Failed(error)
    }
}

impl Hooks {
    fn checkpoint(self, name: &str) -> Result<(), Abort> {
        if self.crash_at == Some(name) {
            return Err(Abort::Crashed);
        }
        if self.fail_at == Some(name) {
            return Err(Abort::Failed("simulated publish failure".to_string()));
        }
        Ok(())
    }
}

/// Resolves a path and proves it stays inside the project and out of git's data.
fn contained(root: &Path, path: &str) -> Result<PathBuf, String> {
    let resolved = Path::new(path)
        .canonicalize()
        .map_err(|error| format!("Could not read {path}: {error}"))?;
    let relative = resolved
        .strip_prefix(root)
        .map_err(|_| format!("{path} is outside this project"))?;
    if relative
        .components()
        .any(|part| part == Component::Normal(".git".as_ref()))
    {
        return Err(format!("{path} is inside git's own data"));
    }
    Ok(resolved)
}

fn validate(request: &PublishRequest) -> Result<(), String> {
    let root = Path::new(&request.root)
        .canonicalize()
        .map_err(|error| format!("Could not read this project: {error}"))?;
    let sources: HashMap<&str, &PublishSource> = request
        .sources
        .iter()
        .map(|source| (source.name.as_str(), source))
        .collect();
    let check_key = |source_name: &str, key: &str| -> Result<(), String> {
        let source = sources
            .get(source_name)
            .ok_or_else(|| format!("Unknown CDN source: {source_name}"))?;
        validate_object_key(key)?;
        match &source.prefix {
            Some(prefix) if !key.starts_with(&format!("{prefix}/")) => {
                Err(format!("{key} is outside its CDN folder"))
            }
            _ => Ok(()),
        }
    };
    let mut uploaded = HashSet::new();
    for upload in &request.uploads {
        check_key(&upload.source_name, &upload.key)?;
        uploaded.insert(contained(&root, &upload.path)?);
    }
    for delete in &request.deletes {
        check_key(&delete.source_name, &delete.key)?;
    }
    for write in &request.writes {
        contained(&root, &write.path)?;
    }
    for removal in &request.removals {
        if !uploaded.contains(&contained(&root, removal)?) {
            return Err(format!("{removal} can't be removed before it is uploaded"));
        }
    }
    Ok(())
}

async fn upload_all(
    request: &PublishRequest,
    providers: &HashMap<String, Provider>,
    progress: &(dyn Fn(PublishProgress) + Send + Sync),
) -> Result<(), String> {
    let total = request.uploads.len();
    let completed = AtomicUsize::new(0);
    stream::iter(request.uploads.iter().map(Ok::<_, String>))
        .try_for_each_concurrent(UPLOAD_CONCURRENCY, |upload| {
            let completed = &completed;
            async move {
                let provider = providers
                    .get(&upload.source_name)
                    .ok_or_else(|| format!("Unknown CDN source: {}", upload.source_name))?;
                let stored = provider.stat(&upload.key).await?;
                if !stored.is_some_and(|info| info.matches(upload.size, &upload.sha256)) {
                    provider
                        .put(&Upload {
                            key: &upload.key,
                            path: Path::new(&upload.path),
                            size: upload.size,
                            sha256: &upload.sha256,
                            content_type: &upload.content_type,
                        })
                        .await?;
                }
                progress(PublishProgress::Uploading {
                    completed: completed.fetch_add(1, Ordering::SeqCst) + 1,
                    total,
                });
                Ok(())
            }
        })
        .await
}

/// What the transaction will change, verified against the files on disk.
struct VerifiedChanges {
    writes: Vec<(PathBuf, String)>,
    removals: Vec<PathBuf>,
    kept: Vec<String>,
}

/// Confirms nothing changed since planning, so no edit is silently overwritten.
fn verify(client: &Client, request: &PublishRequest) -> Result<VerifiedChanges, String> {
    let root = Path::new(&request.root)
        .canonicalize()
        .map_err(|error| format!("Could not read this project: {error}"))?;
    let changed = |path: &str| format!("{path} changed while publishing. Publish again.");
    let mut writes = Vec::new();
    for write in &request.writes {
        let path = contained(&root, &write.path)?;
        let current = std::fs::read(&path).map_err(|_| changed(&write.path))?;
        if current != write.previous.as_bytes() {
            return Err(changed(&write.path));
        }
        writes.push((path, write.content.clone()));
    }
    let hashes: HashMap<PathBuf, &str> = request
        .uploads
        .iter()
        .map(|upload| Ok((contained(&root, &upload.path)?, upload.sha256.as_str())))
        .collect::<Result<_, String>>()?;
    let mut removals = Vec::new();
    let mut kept = Vec::new();
    for removal in &request.removals {
        let path = contained(&root, removal)?;
        if file_digest(&path)?.0 != hashes.get(&path).copied().unwrap_or_default() {
            return Err(changed(removal));
        }
        if client.is_ignored(&path)? {
            kept.push(removal.clone());
        } else {
            removals.push(path);
        }
    }
    Ok(VerifiedChanges {
        writes,
        removals,
        kept,
    })
}

/// Records how to undo the transaction before anything changes.
fn begin(client: &Client, changes: &VerifiedChanges) -> Result<Journal, String> {
    let git_dir = client.git_dir();
    let directory = journal::prepare_directory(git_dir)?;
    let index = client.capture_index()?;
    if let Some(bytes) = &index.bytes {
        journal::write_backup(&directory, "index", bytes)?;
    }
    let targets = changes
        .writes
        .iter()
        .map(|(path, _)| path)
        .chain(&changes.removals);
    let mut files = Vec::new();
    for (position, path) in targets.enumerate() {
        let backup = format!("file-{position}");
        journal::back_up(&directory, path, &backup)?;
        files.push(BackedUpFile {
            path: path.clone(),
            backup,
        });
    }
    let journal = Journal {
        phase: Phase::Applying,
        head_before: client.head_oid().map(|oid| oid.to_string()),
        commit: None,
        parent: None,
        index_path: index.path,
        index_backup: index.bytes.map(|_| "index".to_string()),
        files,
    };
    journal.save(git_dir)?;
    Ok(journal)
}

fn apply(changes: &VerifiedChanges, hooks: Hooks) -> Result<(), Abort> {
    hooks.checkpoint("before-apply")?;
    for (path, content) in &changes.writes {
        journal::replace_file(path, content.as_bytes())
            .map_err(|error| format!("Could not update {}: {error}", path.display()))?;
        hooks.checkpoint("mid-apply")?;
    }
    for path in &changes.removals {
        std::fs::remove_file(path)
            .map_err(|error| format!("Could not remove {}: {error}", path.display()))?;
    }
    hooks.checkpoint("after-apply")
}

/// Commits and pushes. Returns once the content is on origin.
fn commit_and_push(
    client: &Client,
    message: &str,
    journal: &mut Journal,
    progress: &(dyn Fn(PublishProgress) + Send + Sync),
    hooks: Hooks,
) -> Result<(), Abort> {
    progress(PublishProgress::Committing);
    let committed = client.commit_scoped(message)?;
    hooks.checkpoint("after-commit")?;
    let commit = match committed {
        ScopedCommit::Created { commit, parent } => {
            journal.phase = Phase::Committed;
            journal.commit = Some(commit.to_string());
            journal.parent = parent.map(|oid| oid.to_string());
            journal.save(client.git_dir())?;
            Some(commit)
        }
        ScopedCommit::Unchanged if client.ahead_of_upstream() => None,
        ScopedCommit::Unchanged => return Ok(()),
    };
    hooks.checkpoint("before-push")?;
    progress(PublishProgress::Pushing);
    match client.push_head() {
        Ok(()) => Ok(()),
        Err(PushFailure::Transport(_))
            if commit.is_some_and(|commit| {
                client.remote_commit_status(commit) == RemoteCommit::Landed
            }) =>
        {
            client.record_upstream();
            Ok(())
        }
        Err(failure) => Err(Abort::Failed(failure.into_message())),
    }
}

fn parse_oid(value: Option<&String>) -> Result<Option<Oid>, String> {
    value
        .map(|oid| Oid::from_str(oid).map_err(|error| error.message().to_string()))
        .transpose()
}

/// Undoes the commit, staging, and file changes, then forgets the transaction.
fn roll_back(
    client: &Client,
    journal: &Journal,
    commit: Option<(Oid, Option<Oid>)>,
) -> Result<(), String> {
    if let Some((commit, parent)) = commit {
        if client.head_oid() == Some(commit) {
            client.rollback_commit(commit, parent)?;
        }
    }
    let directory = journal::directory(client.git_dir());
    let bytes = journal
        .index_backup
        .as_ref()
        .map(|name| std::fs::read(directory.join(name)))
        .transpose()
        .map_err(|error| format!("Could not read the git index backup: {error}"))?;
    client.restore_index(&IndexSnapshot {
        path: journal.index_path.clone(),
        bytes,
    })?;
    journal.restore_files(client.git_dir())?;
    journal::clear(client.git_dir())
}

/// The commit an interrupted transaction made, including one created just before
/// the crash, when the journal hadn't recorded it yet.
fn interrupted_commit(
    client: &Client,
    journal: &Journal,
) -> Result<Option<(Oid, Option<Oid>)>, String> {
    if let Some(commit) = parse_oid(journal.commit.as_ref())? {
        return Ok(Some((commit, parse_oid(journal.parent.as_ref())?)));
    }
    let before = parse_oid(journal.head_before.as_ref())?;
    Ok(client
        .head_oid()
        .filter(|head| Some(*head) != before && client.parent_oid(*head) == before)
        .map(|head| (head, before)))
}

fn transact(
    request: &PublishRequest,
    progress: &(dyn Fn(PublishProgress) + Send + Sync),
    hooks: Hooks,
) -> Result<PublishSummary, String> {
    let client = Client::open(&request.root)?;
    let changes = verify(&client, request)?;
    progress(PublishProgress::Applying);
    let mut journal = begin(&client, &changes)?;
    let result = apply(&changes, hooks)
        .and_then(|()| commit_and_push(&client, &request.message, &mut journal, progress, hooks));
    match result {
        Ok(()) => {}
        Err(Abort::Crashed) => return Err("simulated publish crash".to_string()),
        Err(Abort::Failed(error)) => {
            let commit = interrupted_commit(&client, &journal)?;
            return Err(match roll_back(&client, &journal, commit) {
                Ok(()) => error,
                Err(restore) => format!("{error} (the project could not be restored: {restore})"),
            });
        }
    }
    // The content is live from here on, so later problems can't undo the publish.
    if hooks.crash_at == Some("after-push") {
        return Err("simulated publish crash".to_string());
    }
    journal.phase = Phase::Pushed;
    let _ = journal.save(client.git_dir());
    if hooks.crash_at == Some("before-finalize") {
        return Err("simulated publish crash".to_string());
    }
    progress(PublishProgress::Finishing);
    let _ = journal::clear(client.git_dir());
    Ok(PublishSummary {
        message: "Published.".to_string(),
        kept: changes.kept,
        failed_deletes: Vec::new(),
    })
}

/// Deletes recorded CDN objects whose library entries the publish removed.
/// Returns the keys that failed; they stay recorded for the next publish.
async fn delete_published(
    root: &str,
    planned: &[PlannedDelete],
    providers: &HashMap<String, Provider>,
) -> Result<Vec<String>, String> {
    if planned.is_empty() {
        return Ok(Vec::new());
    }
    let lookup = root.to_string();
    let wanted: Vec<_> = planned
        .iter()
        .map(|delete| (delete.source_name.clone(), delete.key.clone()))
        .collect();
    let ready = blocking(move || {
        let client = Client::open(&lookup)?;
        let mut ready = Vec::new();
        for intent in deletes::load(client.git_dir())? {
            let requested = wanted
                .iter()
                .any(|(source, key)| *source == intent.source_name && *key == intent.key);
            if requested && deletes::confirmed(&client, &intent)? {
                ready.push(intent);
            }
        }
        Ok(ready)
    })
    .await?;
    let mut done = Vec::new();
    let mut failed = Vec::new();
    for intent in ready {
        let deleted = match providers.get(&intent.source_name) {
            Some(provider) => provider.delete(&intent.key).await.is_ok(),
            None => false,
        };
        if deleted {
            done.push(intent);
        } else {
            failed.push(intent.key);
        }
    }
    let lookup = root.to_string();
    blocking(move || {
        let client = Client::open(&lookup)?;
        let mut remaining = deletes::load(client.git_dir())?;
        remaining.retain(|intent| !done.contains(intent));
        deletes::save(client.git_dir(), &remaining)
    })
    .await?;
    Ok(failed)
}

/// Runs a publish from upload through push while holding the repository lock.
pub async fn execute(
    request: PublishRequest,
    providers: HashMap<String, Provider>,
    progress: Arc<dyn Fn(PublishProgress) + Send + Sync>,
    hooks: Hooks,
) -> Result<PublishSummary, String> {
    validate(&request)?;
    let root = request.root.clone();
    let lock = blocking(move || {
        let client = Client::open(&root)?;
        let lock = client.lock()?;
        // An offline check is inconclusive; the push reports any real problem.
        if client.fetch_and_check_behind().unwrap_or(false) {
            return Err(
                "The server has newer changes. Fetch them, then publish again.".to_string(),
            );
        }
        Ok(lock)
    })
    .await?;
    upload_all(&request, &providers, progress.as_ref()).await?;
    let root = request.root.clone();
    let planned = request.deletes.clone();
    let mut summary = blocking(move || transact(&request, progress.as_ref(), hooks)).await?;
    // The publish has landed, so a failed delete is reported, never fatal.
    summary.failed_deletes = match delete_published(&root, &planned, &providers).await {
        Ok(failed) => failed,
        Err(_) => planned.into_iter().map(|delete| delete.key).collect(),
    };
    drop(lock);
    Ok(summary)
}

/// Resolves a transaction that stopped partway. A commit known to be on origin
/// is finished; anything else returns the project to its state before publishing.
pub fn recover(root: &str) -> Result<RecoveryOutcome, String> {
    let client = Client::open(root)?;
    let _lock = client.lock_for_recovery()?;
    let git_dir = client.git_dir();
    let Some(journal) = Journal::load(git_dir)? else {
        return Ok(RecoveryOutcome::Clean);
    };
    if journal.phase == Phase::Pushed {
        journal::clear(git_dir)?;
        return Ok(RecoveryOutcome::Finalized);
    }
    let Some((commit, parent)) = interrupted_commit(&client, &journal)? else {
        roll_back(&client, &journal, None)?;
        return Ok(RecoveryOutcome::RolledBack);
    };
    match client.remote_commit_status(commit) {
        RemoteCommit::Landed => {
            client.record_upstream();
            journal::clear(git_dir)?;
            Ok(RecoveryOutcome::Finalized)
        }
        RemoteCommit::Absent => {
            roll_back(&client, &journal, Some((commit, parent)))?;
            Ok(RecoveryOutcome::RolledBack)
        }
        RemoteCommit::Unreachable => Ok(RecoveryOutcome::Blocked {
            message: "Posto can't reach the server to finish your last publish. Check your connection, then reopen this project.".to_string(),
        }),
    }
}

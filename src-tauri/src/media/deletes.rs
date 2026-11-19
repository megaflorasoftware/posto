//! CDN objects the user deleted from a media library. Deleting is irreversible,
//! so each one waits here until a publish confirms the deletion has landed.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::journal::replace_file;
use crate::git::Client;

const FILE: &str = "posto/pending-deletes.json";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteIntent {
    pub source_name: String,
    pub key: String,
    pub url: String,
    /// The library entry whose removal requested this delete. Restoring that
    /// entry, such as by reverting it, cancels the delete. Stored relative to
    /// the repository and reported to the webview as an absolute path.
    #[serde(default)]
    pub metadata_path: Option<String>,
}

fn file(git_dir: &Path) -> PathBuf {
    git_dir.join(FILE)
}

pub fn load(git_dir: &Path) -> Result<Vec<DeleteIntent>, String> {
    match std::fs::read(file(git_dir)) {
        Ok(source) => serde_json::from_slice(&source)
            .map_err(|error| format!("The pending CDN deletes are unreadable: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(format!("Could not read pending CDN deletes: {error}")),
    }
}

pub fn save(git_dir: &Path, intents: &[DeleteIntent]) -> Result<(), String> {
    let path = file(git_dir);
    if intents.is_empty() {
        return match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Could not update pending CDN deletes: {error}")),
        };
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not update pending CDN deletes: {error}"))?;
    }
    let source = serde_json::to_vec_pretty(intents).map_err(|error| error.to_string())?;
    replace_file(&path, &source)
        .map_err(|error| format!("Could not update pending CDN deletes: {error}"))
}

fn relative(client: &Client, absolute: &str) -> Result<String, String> {
    let workdir = client.workdir_path()?;
    let path = Path::new(absolute);
    let resolved = path
        .parent()
        .and_then(|parent| parent.canonicalize().ok())
        .and_then(|parent| path.file_name().map(|name| parent.join(name)))
        .unwrap_or_else(|| path.to_path_buf());
    resolved
        .strip_prefix(&workdir)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .map_err(|_| format!("{absolute} is outside the repository"))
}

/// Remembers a delete. Recording the same object twice keeps one entry.
pub fn record(client: &Client, mut intent: DeleteIntent) -> Result<(), String> {
    intent.metadata_path = intent
        .metadata_path
        .map(|path| relative(client, &path))
        .transpose()?;
    let mut intents = load(client.git_dir())?;
    intents.retain(|existing| {
        existing.source_name != intent.source_name || existing.key != intent.key
    });
    intents.push(intent);
    save(client.git_dir(), &intents)
}

/// Deletes still wanted, with absolute metadata paths. Entries whose library
/// metadata is back in the working tree were cancelled and are dropped.
pub fn pending(client: &Client) -> Result<Vec<DeleteIntent>, String> {
    let workdir = client.workdir_path()?;
    let intents = load(client.git_dir())?;
    let (kept, cancelled): (Vec<_>, Vec<_>) = intents.into_iter().partition(|intent| {
        intent
            .metadata_path
            .as_ref()
            .is_none_or(|path| !workdir.join(path).exists())
    });
    if !cancelled.is_empty() {
        save(client.git_dir(), &kept)?;
    }
    Ok(kept
        .into_iter()
        .map(|mut intent| {
            intent.metadata_path = intent
                .metadata_path
                .map(|path| workdir.join(path).to_string_lossy().to_string());
            intent
        })
        .collect())
}

/// Whether a delete may run now: its library entry is gone from both the
/// working tree and the published commit.
pub fn confirmed(client: &Client, intent: &DeleteIntent) -> Result<bool, String> {
    let Some(path) = &intent.metadata_path else {
        return Ok(true);
    };
    let workdir = client.workdir_path()?;
    Ok(!workdir.join(path).exists() && !client.head_contains(Path::new(path)))
}

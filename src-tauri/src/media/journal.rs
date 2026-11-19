//! The on-disk record that lets an interrupted media publish be undone or
//! finished. It lives in the git directory, so it is never part of the site.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

const DIRECTORY: &str = "posto/media-publish";
const JOURNAL_FILE: &str = "journal.json";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// Local files are being changed and nothing has been committed for certain.
    Applying,
    /// A commit exists, but whether it reached origin is unknown.
    Committed,
    /// The commit reached origin, so the publish can only move forward.
    Pushed,
}

/// A local file and the backup that restores it.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackedUpFile {
    pub path: PathBuf,
    pub backup: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub phase: Phase,
    pub head_before: Option<String>,
    pub commit: Option<String>,
    pub parent: Option<String>,
    pub index_path: PathBuf,
    pub index_backup: Option<String>,
    pub files: Vec<BackedUpFile>,
}

pub fn directory(git_dir: &Path) -> PathBuf {
    git_dir.join(DIRECTORY)
}

pub fn exists(git_dir: &Path) -> bool {
    directory(git_dir).join(JOURNAL_FILE).exists()
}

fn write_durably(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = std::fs::File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn staged_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    path.with_file_name(format!(".{name}.posto-publish"))
}

/// Replaces a file in one step, so a crash leaves the old or new content intact.
pub fn replace_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let staged = staged_path(path);
    let permissions = std::fs::metadata(path).ok().map(|file| file.permissions());
    let result = write_durably(&staged, bytes)
        .and_then(|()| match permissions {
            Some(permissions) => std::fs::set_permissions(&staged, permissions),
            None => Ok(()),
        })
        .and_then(|()| std::fs::rename(&staged, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&staged);
    }
    result
}

impl Journal {
    pub fn load(git_dir: &Path) -> Result<Option<Self>, String> {
        let path = directory(git_dir).join(JOURNAL_FILE);
        let source = match std::fs::read(&path) {
            Ok(source) => source,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("Could not read the publish journal: {error}")),
        };
        serde_json::from_slice(&source)
            .map(Some)
            .map_err(|error| format!("The publish journal is unreadable: {error}"))
    }

    pub fn save(&self, git_dir: &Path) -> Result<(), String> {
        let source = serde_json::to_vec_pretty(self).map_err(|error| error.to_string())?;
        replace_file(&directory(git_dir).join(JOURNAL_FILE), &source)
            .map_err(|error| format!("Could not save the publish journal: {error}"))
    }

    /// Puts every changed file back. A backup that is already gone was restored
    /// by an earlier attempt, so recovery can safely run more than once.
    pub fn restore_files(&self, git_dir: &Path) -> Result<(), String> {
        let backups = directory(git_dir);
        for file in &self.files {
            // A crash mid-write can strand the staged copy beside the file.
            let _ = std::fs::remove_file(staged_path(&file.path));
            let backup = backups.join(&file.backup);
            if !backup.exists() {
                continue;
            }
            if let Some(parent) = file.path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| format!("Could not restore a file: {error}"))?;
            }
            std::fs::rename(&backup, &file.path)
                .or_else(|_| std::fs::copy(&backup, &file.path).map(|_| ()))
                .map_err(|error| format!("Could not restore {}: {error}", file.path.display()))?;
        }
        Ok(())
    }
}

pub fn prepare_directory(git_dir: &Path) -> Result<PathBuf, String> {
    let path = directory(git_dir);
    if path.exists() {
        std::fs::remove_dir_all(&path)
            .map_err(|error| format!("Could not clear old publish backups: {error}"))?;
    }
    std::fs::create_dir_all(&path)
        .map_err(|error| format!("Could not prepare publish backups: {error}"))?;
    Ok(path)
}

/// Saves a recoverable copy of a file before it changes.
pub fn back_up(directory: &Path, source: &Path, name: &str) -> Result<(), String> {
    let target = directory.join(name);
    // Copying keeps the file's permissions along with its content.
    std::fs::copy(source, &target)
        .and_then(|_| std::fs::File::open(&target)?.sync_all())
        .map_err(|error| format!("Could not back up {}: {error}", source.display()))
}

pub fn write_backup(directory: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    write_durably(&directory.join(name), bytes)
        .map_err(|error| format!("Could not save publish backups: {error}"))
}

/// Removes the journal last, so an interrupted cleanup is simply retried.
pub fn clear(git_dir: &Path) -> Result<(), String> {
    let path = directory(git_dir);
    match std::fs::remove_file(path.join(JOURNAL_FILE)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Could not clear the publish journal: {error}")),
    }
    match std::fs::remove_dir_all(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not clear publish backups: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn replacing_a_file_keeps_its_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("photo.yaml");
        std::fs::write(&file, "original").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o640)).unwrap();

        replace_file(&file, b"rewritten").unwrap();

        let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o640);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "rewritten");
    }

    #[test]
    fn restoring_is_repeatable_and_clears_stranded_copies() {
        let dir = tempfile::tempdir().unwrap();
        let git_dir = dir.path().join("git");
        let backups = prepare_directory(&git_dir).unwrap();
        let file = dir.path().join("photo.yaml");
        std::fs::write(&file, "original").unwrap();
        back_up(&backups, &file, "file-0").unwrap();
        std::fs::write(&file, "rewritten").unwrap();
        std::fs::write(staged_path(&file), "half written").unwrap();
        let journal = Journal {
            phase: Phase::Applying,
            head_before: None,
            commit: None,
            parent: None,
            index_path: git_dir.join("index"),
            index_backup: None,
            files: vec![BackedUpFile {
                path: file.clone(),
                backup: "file-0".to_string(),
            }],
        };

        journal.restore_files(&git_dir).unwrap();
        journal.restore_files(&git_dir).unwrap();

        assert_eq!(std::fs::read_to_string(&file).unwrap(), "original");
        assert!(!staged_path(&file).exists());
    }
}

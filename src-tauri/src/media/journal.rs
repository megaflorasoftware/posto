//! The on-disk record that lets an interrupted media publish be undone or
//! finished. It lives in the git directory, so it is never part of the site.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

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
    /// Relative to the working directory; absolute in older journals.
    pub path: PathBuf,
    pub backup: String,
}

/// Paths in a journal are relative to the repository, so the journal still
/// applies after the repository moves: iOS moves the app's data container,
/// with the repositories in it, on every app update. Journals written before
/// that hold absolute paths; see [`Journal::file_location`].
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub phase: Phase,
    pub head_before: Option<String>,
    pub commit: Option<String>,
    pub parent: Option<String>,
    /// The git index, relative to the git directory; absolute in older
    /// journals.
    pub index_path: PathBuf,
    pub index_backup: Option<String>,
    pub files: Vec<BackedUpFile>,
}

/// Where a repository is now: its canonical working directory and its git
/// directory.
#[derive(Clone, Debug)]
pub struct Roots {
    pub workdir: PathBuf,
    pub git_dir: PathBuf,
}

impl Roots {
    /// How a journal records a file inside the working directory.
    pub fn relative_file(&self, path: &Path) -> PathBuf {
        path.strip_prefix(&self.workdir)
            .map_or_else(|_| path.to_path_buf(), Path::to_path_buf)
    }

    /// How a journal records a path inside the git directory.
    pub fn relative_git_path(&self, path: &Path) -> PathBuf {
        path.strip_prefix(&self.git_dir)
            .map_or_else(|_| path.to_path_buf(), Path::to_path_buf)
    }
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

    /// The git index as it is now.
    pub fn index_location(&self, roots: &Roots) -> PathBuf {
        if self.index_path.is_relative() {
            return roots.git_dir.join(&self.index_path);
        }
        // An older journal: the index sits directly in the git directory.
        match self.index_path.file_name() {
            Some(name) => roots.git_dir.join(name),
            None => self.index_path.clone(),
        }
    }

    /// Where a backed-up file is now. An older journal's absolute path is
    /// rebased from the working directory it was written under onto the
    /// current one, since the journal belongs to this repository wherever it
    /// was then (an app update moved it, say, and the old one is gone).
    pub fn file_location(&self, file: &BackedUpFile, roots: &Roots) -> Result<PathBuf, String> {
        if file.path.is_relative() {
            if !file
                .path
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
            {
                return Err(format!(
                    "The publish journal names a file outside the project: {}",
                    file.path.display()
                ));
            }
            return Ok(roots.workdir.join(&file.path));
        }
        if file.path.starts_with(&roots.workdir) {
            return Ok(file.path.clone());
        }
        Ok(self
            .written_workdir(roots)
            .and_then(|written| file.path.strip_prefix(written).ok().map(Path::to_path_buf))
            .map_or_else(
                || file.path.clone(),
                |relative| roots.workdir.join(relative),
            ))
    }

    /// The working directory an older journal's absolute paths were written
    /// under. Its index path gives the git directory then, and the git
    /// directory sits where it does now relative to the working directory
    /// (`.git`, in a clone).
    fn written_workdir(&self, roots: &Roots) -> Option<PathBuf> {
        if self.index_path.is_relative() {
            return None;
        }
        let git_dir = roots.git_dir.canonicalize().ok()?;
        let inner = git_dir.strip_prefix(&roots.workdir).ok()?;
        let mut written = self.index_path.parent()?.to_path_buf();
        if inner.as_os_str().is_empty() || !written.ends_with(inner) {
            return None;
        }
        for _ in inner.components() {
            written.pop();
        }
        Some(written)
    }

    /// Puts every changed file back. A backup that is already gone was restored
    /// by an earlier attempt, so recovery can safely run more than once.
    pub fn restore_files(&self, roots: &Roots) -> Result<(), String> {
        let backups = directory(&roots.git_dir);
        let files = self
            .files
            .iter()
            .map(|file| Ok((self.file_location(file, roots)?, &file.backup)))
            .collect::<Result<Vec<_>, String>>()?;
        for (path, backup) in files {
            // A crash mid-write can strand the staged copy beside the file.
            let _ = std::fs::remove_file(staged_path(&path));
            let backup = backups.join(backup);
            if !backup.exists() {
                continue;
            }
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| format!("Could not restore a file: {error}"))?;
            }
            std::fs::rename(&backup, &path)
                .or_else(|_| std::fs::copy(&backup, &path).map(|_| ()))
                .map_err(|error| format!("Could not restore {}: {error}", path.display()))?;
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

    fn journal(index_path: PathBuf, files: Vec<BackedUpFile>) -> Journal {
        Journal {
            phase: Phase::Applying,
            head_before: None,
            commit: None,
            parent: None,
            index_path,
            index_backup: None,
            files,
        }
    }

    /// A repository at `<dir>/<name>`, with its git directory inside it.
    fn roots(dir: &Path, name: &str) -> Roots {
        let workdir = dir.join(name);
        std::fs::create_dir_all(workdir.join(".git")).unwrap();
        let workdir = workdir.canonicalize().unwrap();
        Roots {
            git_dir: workdir.join(".git"),
            workdir,
        }
    }

    #[test]
    fn restoring_is_repeatable_and_clears_stranded_copies() {
        let dir = tempfile::tempdir().unwrap();
        let roots = roots(dir.path(), "site");
        let backups = prepare_directory(&roots.git_dir).unwrap();
        let file = roots.workdir.join("photo.yaml");
        std::fs::write(&file, "original").unwrap();
        back_up(&backups, &file, "file-0").unwrap();
        std::fs::write(&file, "rewritten").unwrap();
        std::fs::write(staged_path(&file), "half written").unwrap();
        let journal = journal(
            PathBuf::from("index"),
            vec![BackedUpFile {
                path: roots.relative_file(&file),
                backup: "file-0".to_string(),
            }],
        );

        journal.restore_files(&roots).unwrap();
        journal.restore_files(&roots).unwrap();

        assert_eq!(std::fs::read_to_string(&file).unwrap(), "original");
        assert!(!staged_path(&file).exists());
    }

    #[test]
    fn paths_are_kept_relative_to_the_repository() {
        let dir = tempfile::tempdir().unwrap();
        let roots = roots(dir.path(), "site");
        let file = roots.workdir.join("src/data/photo.yaml");
        assert_eq!(
            roots.relative_file(&file),
            PathBuf::from("src/data/photo.yaml")
        );
        assert_eq!(
            roots.relative_git_path(&roots.git_dir.join("index")),
            PathBuf::from("index")
        );

        // The same journal, read after the repository moved.
        let moved = Roots {
            workdir: PathBuf::from("/moved/site"),
            git_dir: PathBuf::from("/moved/site/.git"),
        };
        let journal = journal(
            PathBuf::from("index"),
            vec![BackedUpFile {
                path: roots.relative_file(&file),
                backup: "file-0".to_string(),
            }],
        );
        assert_eq!(
            journal.file_location(&journal.files[0], &moved).unwrap(),
            PathBuf::from("/moved/site/src/data/photo.yaml")
        );
        assert_eq!(
            journal.index_location(&moved),
            PathBuf::from("/moved/site/.git/index")
        );
    }

    #[test]
    fn old_absolute_journals_are_rebased_onto_the_moved_repository() {
        let dir = tempfile::tempdir().unwrap();
        let roots = roots(dir.path(), "new-container/site");
        // Written in a container that an app update has since replaced.
        let old = dir
            .path()
            .canonicalize()
            .unwrap()
            .join("old-container/site");
        let backups = prepare_directory(&roots.git_dir).unwrap();
        let file = roots.workdir.join("src/photo.yaml");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "original").unwrap();
        back_up(&backups, &file, "file-0").unwrap();
        std::fs::write(&file, "rewritten").unwrap();
        let journal = journal(
            old.join(".git/index"),
            vec![BackedUpFile {
                path: old.join("src/photo.yaml"),
                backup: "file-0".to_string(),
            }],
        );

        assert_eq!(journal.index_location(&roots), roots.git_dir.join("index"));
        assert_eq!(
            journal.file_location(&journal.files[0], &roots).unwrap(),
            file
        );
        journal.restore_files(&roots).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "original");
        assert!(!old.exists());
    }

    #[test]
    fn old_absolute_journals_that_still_fit_are_read_as_written() {
        let dir = tempfile::tempdir().unwrap();
        let roots = roots(dir.path(), "site");
        let file = roots.workdir.join("photo.yaml");
        let journal = journal(
            roots.git_dir.join("index"),
            vec![BackedUpFile {
                path: file.clone(),
                backup: "file-0".to_string(),
            }],
        );
        assert_eq!(
            journal.file_location(&journal.files[0], &roots).unwrap(),
            file
        );
        assert_eq!(journal.index_location(&roots), roots.git_dir.join("index"));
    }

    #[test]
    fn journal_paths_cannot_leave_the_repository() {
        let dir = tempfile::tempdir().unwrap();
        let roots = roots(dir.path(), "site");
        let journal = journal(
            PathBuf::from("index"),
            vec![BackedUpFile {
                path: PathBuf::from("../elsewhere.yaml"),
                backup: "file-0".to_string(),
            }],
        );
        assert!(journal.file_location(&journal.files[0], &roots).is_err());
        assert!(journal.restore_files(&roots).is_err());
    }
}

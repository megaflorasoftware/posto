use serde::{Deserialize, Serialize};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::Manager;

// Content formats only — code files (.ts, .js, .css, config files, …) are
// deliberately excluded from the file chooser.
const TEXT_EXTENSIONS: &[&str] = &[
    "md", "mdx", "markdown", "txt", "html", "htm", "njk", "liquid", "hbs", "mustache", "ejs",
    "pug", "rst", "csv",
];
#[cfg(mobile)]
const MAX_THUMBNAIL_CACHE_BYTES: u64 = 48 * 1024 * 1024;
#[cfg(not(mobile))]
const MAX_THUMBNAIL_CACHE_BYTES: u64 = 96 * 1024 * 1024;

pub(crate) const SKIP_DIRS: &[&str] = &["node_modules", "_site", "dist", "build", "out", "target"];

#[derive(Serialize)]
pub struct FileEntry {
    name: String,
    path: String,
    /// Display label from frontmatter (`title:`, else `name:`), when present.
    title: Option<String>,
    /// Top-level scalar frontmatter pairs, for `.posto` collection settings
    /// (entry-name templates, sorting). None for non-markdown files.
    frontmatter: Option<std::collections::BTreeMap<String, String>>,
}

const FRONTMATTER_TITLE_EXTENSIONS: &[&str] = &["md", "mdx", "markdown"];

fn frontmatter_scalar(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || matches!(trimmed, "~" | "null" | "Null" | "NULL" | "|" | ">")
        || trimmed.starts_with('{')
        || trimmed.starts_with('[')
    {
        return None;
    }

    if (trimmed.starts_with('"') && trimmed.ends_with('"'))
        || (trimmed.starts_with('\'') && trimmed.ends_with('\''))
    {
        let unquoted = trimmed[1..trimmed.len() - 1].trim().to_string();
        return (!unquoted.is_empty()).then_some(unquoted);
    }

    // YAML comments begin at a # preceded by whitespace. Quoted values were
    // handled above, so a lightweight scan is sufficient for this scalar set.
    let plain = trimmed
        .find(" #")
        .map(|index| &trimmed[..index])
        .unwrap_or(trimmed)
        .trim();
    if plain.is_empty() {
        return None;
    }
    if plain.eq_ignore_ascii_case("true") {
        return Some("true".to_string());
    }
    if plain.eq_ignore_ascii_case("false") {
        return Some("false".to_string());
    }
    if let Some(hexadecimal) = plain.strip_prefix("0x") {
        if let Ok(number) = i64::from_str_radix(hexadecimal, 16) {
            return Some(number.to_string());
        }
    }
    if let Some(octal) = plain.strip_prefix("0o") {
        if let Ok(number) = i64::from_str_radix(octal, 8) {
            return Some(number.to_string());
        }
    }

    let unsigned = plain.trim_start_matches(['+', '-']);
    let leading_zero_integer = unsigned.len() > 1
        && unsigned.starts_with('0')
        && unsigned.chars().all(|character| character.is_ascii_digit());
    if !leading_zero_integer {
        if let Ok(integer) = plain.parse::<i64>() {
            return Some(integer.to_string());
        }
        if let Ok(decimal) = plain.parse::<f64>() {
            if decimal.is_finite() {
                return Some(decimal.to_string());
            }
        }
    }

    Some(plain.to_string())
}

/// Extracts top-level `key: value` scalar pairs from a markdown file's
/// leading frontmatter block. Line-based on purpose: sidebar labels and
/// sort keys don't warrant a YAML parser — nested/multiline values are
/// simply skipped and their consumers fall back (label → filename).
fn frontmatter_scalars(
    path: &Path,
    ext: &str,
) -> Option<std::collections::BTreeMap<String, String>> {
    if !FRONTMATTER_TITLE_EXTENSIONS.contains(&ext) {
        return None;
    }
    let content = std::fs::read_to_string(path).ok()?;
    let mut lines = content.lines();
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    let mut pairs = std::collections::BTreeMap::new();
    for line in lines {
        let end = line.trim_end();
        if end == "---" || end == "..." {
            break;
        }
        // Indented lines belong to nested values; `- ` lines to sequences.
        if line.starts_with(' ') || line.starts_with('\t') {
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim();
            if key.is_empty() || key.contains(' ') {
                continue;
            }
            if let Some(scalar) = frontmatter_scalar(value) {
                pairs.insert(key.to_string(), scalar);
            }
        }
    }
    (!pairs.is_empty()).then_some(pairs)
}

/// Display label from frontmatter: `title:`, else `name:`.
fn frontmatter_title(
    frontmatter: Option<&std::collections::BTreeMap<String, String>>,
) -> Option<String> {
    let pairs = frontmatter?;
    pairs.get("title").or_else(|| pairs.get("name")).cloned()
}

/// One flat sidebar section: a directory that directly contains text files.
/// `label` is the directory's path relative to the chosen root ("" for the
/// root itself).
#[derive(Serialize)]
pub struct FileGroup {
    label: String,
    path: String,
    /// Marks synthetic groups the frontend treats specially ("styles" for the
    /// tree-wide CSS section); None for plain directory groups.
    kind: Option<&'static str>,
    files: Vec<FileEntry>,
}

fn collect_groups(root: &Path, dir: &Path, groups: &mut Vec<FileGroup>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<FileEntry> = Vec::new();
    let mut subdirs: Vec<std::path::PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        // The Pages CMS schema at the root is editable content; every other
        // dotfile stays hidden.
        let is_schema = dir == root && name == ".pages.yml";
        if name.starts_with('.') && !is_schema {
            continue;
        }
        if path.is_dir() {
            if !SKIP_DIRS.contains(&name.as_str()) {
                subdirs.push(path);
            }
        } else {
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if is_schema || TEXT_EXTENSIONS.contains(&ext.as_str()) {
                let frontmatter = frontmatter_scalars(&path, &ext);
                files.push(FileEntry {
                    title: frontmatter_title(frontmatter.as_ref()),
                    frontmatter,
                    name,
                    path: path.to_string_lossy().to_string(),
                });
            }
        }
    }
    if !files.is_empty() {
        // Sort by what the sidebar displays: frontmatter title, else filename.
        files.sort_by_key(|f| f.title.as_ref().unwrap_or(&f.name).to_lowercase());
        groups.push(FileGroup {
            label: dir
                .strip_prefix(root)
                .unwrap_or(dir)
                .to_string_lossy()
                .to_string(),
            path: dir.to_string_lossy().to_string(),
            kind: None,
            files,
        });
    }
    for sub in subdirs {
        collect_groups(root, &sub, groups);
    }
}

#[tauri::command]
pub fn list_files(root: String) -> Result<Vec<FileGroup>, String> {
    let path = Path::new(&root);
    if !path.is_dir() {
        return Err(format!("Not a directory: {root}"));
    }
    let mut groups = Vec::new();
    collect_groups(path, path, &mut groups);
    // Root files first, then directories alphabetically by their path label.
    groups.sort_by(|a, b| a.label.cmp(&b.label));
    // All stylesheets in the tree form one flat "Styles" section, appended
    // last so it lands at the bottom of the sidebar.
    let mut styles = Vec::new();
    collect_dir_files(path, &["css".to_string()], &mut styles);
    if !styles.is_empty() {
        styles.sort_by_key(|f| f.name.to_lowercase());
        groups.push(FileGroup {
            label: "Styles".to_string(),
            path: root.clone(),
            kind: Some("styles"),
            files: styles,
        });
    }
    Ok(groups)
}

fn collect_dir_files(dir: &Path, extensions: &[String], out: &mut Vec<FileEntry>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            if !SKIP_DIRS.contains(&name.as_str()) {
                collect_dir_files(&path, extensions, out);
            }
        } else {
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if extensions.is_empty() || extensions.iter().any(|e| e == &ext) {
                out.push(FileEntry {
                    name,
                    path: path.to_string_lossy().to_string(),
                    title: None,
                    frontmatter: None,
                });
            }
        }
    }
}

/// Lists files under `dir` recursively, filtered by extension (any file when
/// `extensions` is empty). Used by media browsers, whose files (images) are
/// outside `list_files`'s text-only view.
#[tauri::command]
pub fn list_dir_files(dir: String, extensions: Vec<String>) -> Result<Vec<FileEntry>, String> {
    let path = Path::new(&dir);
    if !path.is_dir() {
        return Err(format!("Not a directory: {dir}"));
    }
    let mut files = Vec::new();
    collect_dir_files(path, &extensions, &mut files);
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// Lists files when a directory exists. Absence is an expected `None`, while
/// permission and other I/O failures remain errors the frontend can surface.
#[tauri::command]
pub fn list_dir_files_optional(
    dir: String,
    extensions: Vec<String>,
) -> Result<Option<Vec<FileEntry>>, String> {
    let path = Path::new(&dir);
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => list_dir_files(dir, extensions).map(Some),
        Ok(_) => Err(format!("Not a directory: {dir}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to inspect {dir}: {error}")),
    }
}

/// Checks path metadata without reading directory contents. Missing paths are
/// expected; permissions and other metadata failures remain actionable errors.
#[tauri::command]
pub fn path_exists(path: String, kind: Option<String>) -> Result<bool, String> {
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("Failed to inspect {path}: {error}")),
    };
    match kind.as_deref() {
        Some("file") => Ok(metadata.is_file()),
        Some("directory") => Ok(metadata.is_dir()),
        Some(other) => Err(format!("Unknown path kind: {other}")),
        None => Ok(true),
    }
}

fn cached_image_thumbnail(
    cache_root: &Path,
    source: &Path,
    max_width: u32,
    max_height: u32,
) -> Result<PathBuf, String> {
    let max_width = max_width.clamp(1, 2048);
    let max_height = max_height.clamp(1, 2048);
    let metadata = source
        .metadata()
        .map_err(|error| format!("Could not inspect {}: {error}", source.display()))?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let mut hasher = DefaultHasher::new();
    source.hash(&mut hasher);
    max_width.hash(&mut hasher);
    max_height.hash(&mut hasher);
    let source_key = format!("{:016x}", hasher.finish());
    let mut revision_hasher = DefaultHasher::new();
    metadata.len().hash(&mut revision_hasher);
    modified.hash(&mut revision_hasher);
    let revision = revision_hasher.finish();
    let cache_directory = cache_root.join("image-thumbnails");
    let destination = cache_directory.join(format!("{source_key}-{revision:016x}.png"));
    if destination.is_file() {
        return Ok(destination);
    }

    std::fs::create_dir_all(&cache_directory)
        .map_err(|error| format!("Could not create thumbnail cache: {error}"))?;
    let (image, _) = decode_oriented_image(source)?;
    image
        .thumbnail(max_width, max_height)
        .save_with_format(&destination, image::ImageFormat::Png)
        .map_err(|error| {
            format!(
                "Could not cache thumbnail for {}: {error}",
                source.display()
            )
        })?;
    if let Ok(entries) = std::fs::read_dir(&cache_directory) {
        for entry in entries.flatten() {
            let path = entry.path();
            let is_previous_revision = path != destination
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(&source_key));
            if is_previous_revision {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    prune_thumbnail_cache(&cache_directory);
    Ok(destination)
}

fn decode_oriented_image(
    source: &Path,
) -> Result<(image::DynamicImage, image::ImageFormat), String> {
    use image::ImageDecoder;

    let reader = image::ImageReader::open(source)
        .map_err(|error| format!("Could not open {}: {error}", source.display()))?
        .with_guessed_format()
        .map_err(|error| format!("Could not identify {}: {error}", source.display()))?;
    let format = reader
        .format()
        .ok_or_else(|| format!("Could not identify image format for {}", source.display()))?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|error| format!("Could not decode {}: {error}", source.display()))?;
    let orientation = decoder.orientation().map_err(|error| {
        format!(
            "Could not read orientation for {}: {error}",
            source.display()
        )
    })?;
    let mut image = image::DynamicImage::from_decoder(decoder)
        .map_err(|error| format!("Could not decode {}: {error}", source.display()))?;
    image.apply_orientation(orientation);
    Ok((image, format))
}

fn prune_thumbnail_cache(directory: &Path) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    let mut files = entries
        .flatten()
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            metadata.is_file().then(|| {
                (
                    entry.path(),
                    metadata.len(),
                    metadata.modified().unwrap_or(UNIX_EPOCH),
                )
            })
        })
        .collect::<Vec<_>>();
    let mut total = files.iter().map(|(_, length, _)| length).sum::<u64>();
    if total <= MAX_THUMBNAIL_CACHE_BYTES {
        return;
    }
    files.sort_by_key(|(_, _, modified)| *modified);
    for (path, length, _) in files {
        if total <= MAX_THUMBNAIL_CACHE_BYTES {
            break;
        }
        if std::fs::remove_file(path).is_ok() {
            total = total.saturating_sub(length);
        }
    }
}

/// Generates a bounded image preview once and returns its cache path. The
/// source size and modification timestamp form part of the key, so edits
/// naturally produce a fresh URL without loading stale webview cache data.
#[tauri::command]
pub async fn image_thumbnail(
    app: tauri::AppHandle,
    path: String,
    max_width: u32,
    max_height: u32,
) -> Result<String, String> {
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not locate app cache: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        cached_image_thumbnail(&cache_root, Path::new(&path), max_width, max_height)
            .map(|path| path.to_string_lossy().to_string())
    })
    .await
    .map_err(|error| format!("Thumbnail task failed: {error}"))?
}

fn collect_directories(dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() && !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str()) {
            out.push(path.to_string_lossy().to_string());
            collect_directories(&path, out);
        }
    }
}

/// Lists visible directories under `dir` recursively, including empty ones.
#[tauri::command]
pub fn list_directories(dir: String) -> Result<Vec<String>, String> {
    let path = Path::new(&dir);
    if !path.is_dir() {
        return Err(format!("Not a directory: {dir}"));
    }
    let mut directories = Vec::new();
    collect_directories(path, &mut directories);
    directories.sort();
    Ok(directories)
}

/// Lists only visible immediate child directories. Used by bounded folder
/// browsers that navigate one level at a time without walking the repository.
#[tauri::command]
pub fn list_child_directories(dir: String) -> Result<Vec<String>, String> {
    let path = Path::new(&dir);
    if !path.is_dir() {
        return Err(format!("Not a directory: {dir}"));
    }
    let mut directories = std::fs::read_dir(path)
        .map_err(|error| format!("Failed to read {dir}: {error}"))?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            (entry.path().is_dir() && !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str()))
                .then(|| entry.path().to_string_lossy().to_string())
        })
        .collect::<Vec<_>>();
    directories.sort();
    Ok(directories)
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {path}: {e}"))
}

/// Reads a UTF-8 text file when present. Absence is expected; all other I/O
/// failures reject so callers never confuse an unreadable config with none.
#[tauri::command]
pub fn read_text_file_optional(path: String) -> Result<Option<String>, String> {
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to read {path}: {error}")),
    }
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    // Write to a sibling temp file and rename it over the target so file
    // watchers (e.g. the site's dev server) see one atomic change instead of
    // a truncate followed by a write — a truncate-then-write can trigger two
    // hot reloads in a row.
    let target = Path::new(&path);
    // Settings writes target files in directories that may not exist yet
    // (`.posto/collections/…`); create them rather than failing.
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Failed to write {path}: {e}"))?;
    }
    let file_name = target
        .file_name()
        .ok_or_else(|| format!("Invalid path: {path}"))?
        .to_string_lossy();
    let tmp = target.with_file_name(format!(".{file_name}.posto-tmp"));
    std::fs::write(&tmp, content).map_err(|e| format!("Failed to write {path}: {e}"))?;
    std::fs::rename(&tmp, target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to write {path}: {e}")
    })
}

/// The sidebar hides dotfiles, so creating one (e.g. a filename template
/// expanding to a bare ".mdx") would leave an invisible orphan.
fn reject_hidden(path: &str) -> Result<(), String> {
    let name = Path::new(path).file_name().map(|n| n.to_string_lossy());
    match name {
        Some(name) if !name.starts_with('.') => Ok(()),
        _ => Err(format!("Refusing to create a hidden file: {path}")),
    }
}

/// Creates a new file, failing if one already exists at `path` — the "new
/// file" flow must never silently overwrite existing content.
#[tauri::command]
pub fn create_text_file(path: String, content: String) -> Result<(), String> {
    use std::io::Write;
    reject_hidden(&path)?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                format!("File already exists: {path}")
            } else {
                format!("Failed to create {path}: {e}")
            }
        })?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("Failed to create {path}: {e}"))
}

/// Moves a file, failing when the target already exists — the auto-rename
/// flow (filenames derived from frontmatter) must never clobber another
/// entry.
#[tauri::command]
pub fn rename_file(from: String, to: String) -> Result<(), String> {
    reject_hidden(&to)?;
    let target = Path::new(&to);
    if target.exists() {
        return Err(format!("File already exists: {to}"));
    }
    std::fs::rename(&from, target).map_err(|e| format!("Failed to rename {from}: {e}"))
}

#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|e| format!("Failed to delete {path}: {e}"))
}

/// Creates one visible directory inside a media library. Both the library root
/// and the requested parent must already exist, which keeps this command
/// narrowly scoped to the folder currently shown by the media browser.
#[tauri::command]
pub fn create_image_library_directory(
    library_root: String,
    directory_path: String,
) -> Result<(), String> {
    canonical_root(&library_root)?;
    reject_hidden(&directory_path)?;
    let target = managed_target(Path::new(&library_root), &directory_path, false)?;
    std::fs::create_dir(&target).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            format!("Folder already exists: {}", target.display())
        } else {
            format!("Failed to create folder {}: {error}", target.display())
        }
    })
}

fn file_media_root(repository_root: &str, media_root: &str) -> Result<PathBuf, String> {
    let repository = canonical_root(repository_root)?;
    let requested = Path::new(media_root);
    if !requested.is_absolute() {
        return Err("A file media root must be absolute".to_string());
    }
    let relative = requested
        .strip_prefix(Path::new(repository_root))
        .or_else(|_| requested.strip_prefix(&repository))
        .map_err(|_| "The file media root is outside the repository".to_string())?;
    if relative.as_os_str().is_empty()
        || relative.components().any(|part| match part {
            Component::Normal(name) => name.to_string_lossy().starts_with('.'),
            _ => true,
        })
    {
        return Err("Invalid file media root".to_string());
    }
    let requested = repository.join(relative);
    let target = managed_target(&repository, &requested.to_string_lossy(), true)?;
    std::fs::create_dir_all(&target)
        .map_err(|error| format!("Failed to create file media root: {error}"))?;
    canonical_root(&target.to_string_lossy())
}

#[tauri::command]
pub fn create_file_media_directory(
    repository_root: String,
    media_root: String,
    directory: String,
) -> Result<(), String> {
    let media_root = file_media_root(&repository_root, &media_root)?;
    if directory.is_empty()
        || Path::new(&directory).is_absolute()
        || Path::new(&directory).components().any(|part| match part {
            Component::Normal(name) => name.to_string_lossy().starts_with('.'),
            _ => true,
        })
    {
        return Err("Invalid file media directory".to_string());
    }
    let target = media_root.join(directory);
    let target = managed_target(&media_root, &target.to_string_lossy(), false)?;
    std::fs::create_dir(&target).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            format!("Folder already exists: {}", target.display())
        } else {
            format!("Failed to create folder {}: {error}", target.display())
        }
    })
}

/// Compatibility command for the conventional public media root.
#[tauri::command]
pub fn create_public_media_directory(
    repository_root: String,
    directory: String,
) -> Result<(), String> {
    let media_root = Path::new(&repository_root).join("public");
    create_file_media_directory(
        repository_root,
        media_root.to_string_lossy().to_string(),
        directory,
    )
}

/// Deletes an image-library entry and its image together after verifying that
/// both paths are files contained by the declared library root.
#[tauri::command]
pub fn delete_image_library_asset(
    library_root: String,
    image_path: String,
    metadata_path: String,
) -> Result<(), String> {
    canonical_root(&library_root)?;
    let root = Path::new(&library_root);
    let image = managed_target(root, &image_path, false)?;
    let metadata = managed_target(root, &metadata_path, false)?;
    if !image.is_file() || !metadata.is_file() {
        return Err("The image-library entry is incomplete or no longer exists".to_string());
    }

    // Move both files aside first so a failure cannot leave a half-deleted
    // entry. Once both renames succeed, removing the temporary files commits.
    let image_tmp = transaction_temp(&image, "delete")?;
    let metadata_tmp = transaction_temp(&metadata, "delete")?;
    if image_tmp.exists() || metadata_tmp.exists() {
        return Err("A previous image deletion is still pending".to_string());
    }
    std::fs::rename(&image, &image_tmp)
        .map_err(|error| format!("Failed to stage image deletion: {error}"))?;
    if let Err(error) = std::fs::rename(&metadata, &metadata_tmp) {
        let _ = std::fs::rename(&image_tmp, &image);
        return Err(format!("Failed to stage metadata deletion: {error}"));
    }
    if let Err(error) = std::fs::remove_file(&image_tmp) {
        let _ = std::fs::rename(&image_tmp, &image);
        let _ = std::fs::rename(&metadata_tmp, &metadata);
        return Err(format!("Failed to delete image: {error}"));
    }
    std::fs::remove_file(&metadata_tmp)
        .map_err(|error| format!("Failed to delete metadata: {error}"))
}

/// Moves an image-library entry and its image into an existing directory in
/// the same library. The pair is rolled back if the second rename fails.
#[tauri::command]
pub fn move_image_library_asset(
    library_root: String,
    image_path: String,
    metadata_path: String,
    destination_directory: String,
) -> Result<(), String> {
    canonical_root(&library_root)?;
    let root = Path::new(&library_root);
    let image = managed_target(root, &image_path, false)?;
    let metadata = managed_target(root, &metadata_path, false)?;
    let destination_probe = Path::new(&destination_directory).join(".posto-destination");
    let destination_probe = managed_target(root, &destination_probe.to_string_lossy(), false)?;
    let destination = destination_probe
        .parent()
        .ok_or_else(|| "Invalid destination folder".to_string())?;
    if !destination.is_dir() {
        return Err(format!(
            "Not a destination folder: {}",
            destination.display()
        ));
    }
    if !image.is_file() || !metadata.is_file() {
        return Err("The image-library entry is incomplete or no longer exists".to_string());
    }
    let target_image = destination.join(
        image
            .file_name()
            .ok_or_else(|| "Invalid image filename".to_string())?,
    );
    let target_metadata = destination.join(
        metadata
            .file_name()
            .ok_or_else(|| "Invalid metadata filename".to_string())?,
    );
    if target_image == image && target_metadata == metadata {
        return Err("The image is already in that folder".to_string());
    }
    if target_image.exists() || target_metadata.exists() {
        return Err(format!(
            "A file with that name already exists in {}",
            destination.display()
        ));
    }
    std::fs::rename(&image, &target_image)
        .map_err(|error| format!("Failed to move image: {error}"))?;
    if let Err(error) = std::fs::rename(&metadata, &target_metadata) {
        let _ = std::fs::rename(&target_image, &image);
        return Err(format!("Failed to move metadata: {error}"));
    }
    Ok(())
}

/// Renames an image and its metadata sidecar together while replacing the
/// metadata contents (whose relative image field must follow the new name).
#[tauri::command]
pub fn rename_image_library_asset(
    library_root: String,
    image_path: String,
    metadata_path: String,
    target_image_path: String,
    target_metadata_path: String,
    serialized_metadata: String,
) -> Result<(), String> {
    canonical_root(&library_root)?;
    let root = Path::new(&library_root);
    let image = managed_target(root, &image_path, false)?;
    let metadata = managed_target(root, &metadata_path, false)?;
    let target_image = managed_target(root, &target_image_path, false)?;
    let target_metadata = managed_target(root, &target_metadata_path, false)?;
    if !image.is_file() || !metadata.is_file() {
        return Err("The image-library entry is incomplete or no longer exists".to_string());
    }
    if image == target_image || metadata == target_metadata {
        return Err("Choose a different filename".to_string());
    }
    if target_image.exists() || target_metadata.exists() {
        return Err("An image-library destination already exists".to_string());
    }

    let staged_metadata = transaction_temp(&target_metadata, "rename")?;
    let metadata_backup = transaction_temp(&metadata, "rename-backup")?;
    if staged_metadata.exists() || metadata_backup.exists() {
        return Err("A previous image rename is still pending".to_string());
    }
    write_new(&staged_metadata, serialized_metadata.as_bytes())?;
    if let Err(error) = std::fs::rename(&metadata, &metadata_backup) {
        let _ = std::fs::remove_file(&staged_metadata);
        return Err(format!("Failed to stage metadata rename: {error}"));
    }
    if let Err(error) = std::fs::rename(&image, &target_image) {
        let _ = std::fs::rename(&metadata_backup, &metadata);
        let _ = std::fs::remove_file(&staged_metadata);
        return Err(format!("Failed to rename image: {error}"));
    }
    if let Err(error) = std::fs::rename(&staged_metadata, &target_metadata) {
        let _ = std::fs::rename(&target_image, &image);
        let _ = std::fs::rename(&metadata_backup, &metadata);
        let _ = std::fs::remove_file(&staged_metadata);
        return Err(format!("Failed to rename metadata: {error}"));
    }
    let _ = std::fs::remove_file(&metadata_backup);
    Ok(())
}

/// Deletes one file below an arbitrary file-based media root.
#[tauri::command]
pub fn delete_media_file(media_root: String, file_path: String) -> Result<(), String> {
    let canonical_root = canonical_root(&media_root)?;
    let file = managed_target(Path::new(&media_root), &file_path, false)?;
    let canonical_file =
        std::fs::canonicalize(&file).map_err(|error| format!("Invalid media file: {error}"))?;
    if !canonical_file.starts_with(&canonical_root) || !canonical_file.is_file() {
        return Err("Invalid media file".to_string());
    }
    std::fs::remove_file(&canonical_file)
        .map_err(|error| format!("Failed to delete media file {}: {error}", file.display()))
}

/// Renames one file below an arbitrary file-based media root without allowing
/// it to cross that root or overwrite another item.
#[tauri::command]
pub fn rename_media_file(
    media_root: String,
    file_path: String,
    target_file_path: String,
) -> Result<(), String> {
    let canonical_root = canonical_root(&media_root)?;
    let file = managed_target(Path::new(&media_root), &file_path, false)?;
    let canonical_file =
        std::fs::canonicalize(&file).map_err(|error| format!("Invalid media file: {error}"))?;
    let target = managed_target(Path::new(&media_root), &target_file_path, false)?;
    reject_hidden(&target.to_string_lossy())?;
    if !canonical_file.starts_with(&canonical_root) || !canonical_file.is_file() {
        return Err("Invalid media file".to_string());
    }
    if target.exists() {
        return Err(format!("File already exists: {}", target.display()));
    }
    std::fs::rename(&canonical_file, &target)
        .map_err(|error| format!("Failed to rename media file: {error}"))
}

/// Moves one file into an existing directory below the same file-based media root.
#[tauri::command]
pub fn move_media_file(
    media_root: String,
    file_path: String,
    destination_directory: String,
) -> Result<(), String> {
    let canonical_root = canonical_root(&media_root)?;
    let file = managed_target(Path::new(&media_root), &file_path, false)?;
    let canonical_file =
        std::fs::canonicalize(&file).map_err(|error| format!("Invalid media file: {error}"))?;
    let destination_probe = Path::new(&destination_directory).join(".posto-destination");
    let destination_probe = managed_target(
        Path::new(&media_root),
        &destination_probe.to_string_lossy(),
        false,
    )?;
    let destination = destination_probe
        .parent()
        .ok_or_else(|| "Invalid destination folder".to_string())?;
    let canonical_destination = std::fs::canonicalize(destination)
        .map_err(|error| format!("Invalid destination folder: {error}"))?;
    if !canonical_file.starts_with(&canonical_root)
        || !canonical_file.is_file()
        || !canonical_destination.starts_with(&canonical_root)
    {
        return Err("Invalid media move".to_string());
    }
    let name = canonical_file
        .file_name()
        .ok_or_else(|| "Invalid media file name".to_string())?;
    let target = canonical_destination.join(name);
    if target.exists() {
        return Err(format!("File already exists: {}", target.display()));
    }
    std::fs::rename(&canonical_file, &target)
        .map_err(|error| format!("Failed to move media file: {error}"))
}

/// Deletes a directory and everything below it, constrained to an arbitrary
/// file-based media root.
#[tauri::command]
pub fn delete_media_directory(media_root: String, directory_path: String) -> Result<(), String> {
    canonical_root(&media_root)?;
    let root = Path::new(&media_root);
    let probe = Path::new(&directory_path).join(".posto-directory");
    let probe = managed_target(root, &probe.to_string_lossy(), false)?;
    let directory = probe
        .parent()
        .ok_or_else(|| "Invalid media directory".to_string())?;
    let canonical_root = canonical_root(&media_root)?;
    let canonical_directory = std::fs::canonicalize(directory)
        .map_err(|error| format!("Invalid media directory: {error}"))?;
    if canonical_directory == canonical_root || !canonical_directory.starts_with(&canonical_root) {
        return Err("The media root cannot be deleted".to_string());
    }
    std::fs::remove_dir_all(&canonical_directory)
        .map_err(|error| format!("Failed to delete folder {}: {error}", directory.display()))
}

/// Moves a whole directory into an existing directory below the same
/// file-based media root.
#[tauri::command]
pub fn move_media_directory(
    media_root: String,
    directory_path: String,
    destination_directory: String,
) -> Result<(), String> {
    canonical_root(&media_root)?;
    let root = Path::new(&media_root);
    let source_probe = Path::new(&directory_path).join(".posto-source");
    let source_probe = managed_target(root, &source_probe.to_string_lossy(), false)?;
    let source = source_probe
        .parent()
        .ok_or_else(|| "Invalid source folder".to_string())?;
    let destination_probe = Path::new(&destination_directory).join(".posto-destination");
    let destination_probe = managed_target(root, &destination_probe.to_string_lossy(), false)?;
    let destination = destination_probe
        .parent()
        .ok_or_else(|| "Invalid destination folder".to_string())?;
    let canonical_root = canonical_root(&media_root)?;
    let canonical_source =
        std::fs::canonicalize(source).map_err(|error| format!("Invalid source folder: {error}"))?;
    let canonical_destination = std::fs::canonicalize(destination)
        .map_err(|error| format!("Invalid destination folder: {error}"))?;
    if canonical_source == canonical_root {
        return Err("The media library root cannot be moved".to_string());
    }
    if canonical_destination == canonical_source
        || canonical_destination.starts_with(&canonical_source)
    {
        return Err("A folder cannot be moved into itself".to_string());
    }
    let name = canonical_source
        .file_name()
        .ok_or_else(|| "Invalid source folder name".to_string())?;
    let target = canonical_destination.join(name);
    if target.exists() {
        return Err(format!("Folder already exists: {}", target.display()));
    }
    std::fs::rename(&canonical_source, &target)
        .map_err(|error| format!("Failed to move folder: {error}"))
}

/// Compatibility commands for metadata-backed image libraries. New
/// file-based media roots use the generic media operations above.
#[tauri::command]
pub fn delete_image_library_directory(
    library_root: String,
    directory_path: String,
) -> Result<(), String> {
    delete_media_directory(library_root, directory_path)
}

#[tauri::command]
pub fn move_image_library_directory(
    library_root: String,
    directory_path: String,
    destination_directory: String,
) -> Result<(), String> {
    move_media_directory(library_root, directory_path, destination_directory)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageLibraryImportPlan {
    library_root: String,
    source_image_path: String,
    destination_image_path: String,
    destination_metadata_path: String,
    serialized_metadata: String,
    entry_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageLibraryImportResult {
    entry_id: String,
    image_path: String,
    metadata_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicMediaImportRequest {
    repository_root: String,
    source_file_path: String,
    directory: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMediaImportRequest {
    repository_root: String,
    media_root: String,
    source_file_path: String,
    directory: String,
}

fn canonical_root(path: &str) -> Result<PathBuf, String> {
    let root =
        std::fs::canonicalize(path).map_err(|e| format!("Invalid managed root {path}: {e}"))?;
    if !root.is_dir() {
        return Err(format!("Managed root is not a directory: {path}"));
    }
    Ok(root)
}

/// Resolve a managed target without allowing `..` or an existing symlink to
/// escape its root. Missing parent directories may be created one component
/// at a time after each existing ancestor is canonicalized.
fn managed_target(root: &Path, requested: &str, create_parents: bool) -> Result<PathBuf, String> {
    let requested = Path::new(requested);
    if !requested.is_absolute()
        || requested
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(format!(
            "Managed path must be absolute and cannot contain traversal: {}",
            requested.display()
        ));
    }
    let canonical_root =
        std::fs::canonicalize(root).map_err(|e| format!("Invalid managed root: {e}"))?;
    let relative = requested
        .strip_prefix(root)
        .or_else(|_| requested.strip_prefix(&canonical_root))
        .map_err(|_| format!("Path is outside managed root: {}", requested.display()))?;
    let parent = relative
        .parent()
        .ok_or_else(|| format!("Invalid managed path: {}", requested.display()))?;
    let mut current = canonical_root.clone();
    for component in parent.components() {
        let Component::Normal(name) = component else {
            return Err(format!("Invalid managed path: {}", requested.display()));
        };
        current.push(name);
        if current.exists() {
            current = std::fs::canonicalize(&current)
                .map_err(|e| format!("Invalid managed path: {e}"))?;
            if !current.starts_with(&canonical_root) || !current.is_dir() {
                return Err(format!(
                    "Managed path escapes its root: {}",
                    requested.display()
                ));
            }
        } else if create_parents {
            std::fs::create_dir(&current)
                .map_err(|e| format!("Failed to create {}: {e}", current.display()))?;
        } else {
            return Err(format!(
                "Managed parent does not exist: {}",
                current.display()
            ));
        }
    }
    let name = relative
        .file_name()
        .ok_or_else(|| format!("Invalid managed path: {}", requested.display()))?;
    Ok(current.join(name))
}

fn transaction_temp(target: &Path, label: &str) -> Result<PathBuf, String> {
    let name = target
        .file_name()
        .ok_or_else(|| format!("Invalid path: {}", target.display()))?
        .to_string_lossy();
    Ok(target.with_file_name(format!(".{name}.posto-{label}-{}", std::process::id())))
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| format!("Failed to stage {}: {e}", path.display()))?;
    file.write_all(bytes)
        .map_err(|e| format!("Failed to stage {}: {e}", path.display()))
}

fn execute_image_library_import(
    plan: ImageLibraryImportPlan,
    fail_at: Option<&str>,
) -> Result<ImageLibraryImportResult, String> {
    canonical_root(&plan.library_root)?;
    let root = Path::new(&plan.library_root);
    let image = managed_target(root, &plan.destination_image_path, true)?;
    let metadata = managed_target(root, &plan.destination_metadata_path, true)?;
    if image.exists() || metadata.exists() {
        return Err("An image-library destination already exists".to_string());
    }
    let source = std::fs::canonicalize(&plan.source_image_path)
        .map_err(|e| format!("Invalid source image {}: {e}", plan.source_image_path))?;
    if !source.is_file() {
        return Err("Source image is not a file".to_string());
    }
    let image_tmp = transaction_temp(&image, "import")?;
    let metadata_tmp = transaction_temp(&metadata, "import")?;
    let _ = std::fs::remove_file(&image_tmp);
    let _ = std::fs::remove_file(&metadata_tmp);
    let cleanup = || {
        let _ = std::fs::remove_file(&image_tmp);
        let _ = std::fs::remove_file(&metadata_tmp);
    };
    if let Err(error) =
        std::fs::copy(&source, &image_tmp).map_err(|e| format!("Failed to stage image: {e}"))
    {
        cleanup();
        return Err(error);
    }
    if fail_at == Some("after-image-stage") {
        cleanup();
        return Err("simulated import failure".into());
    }
    if let Err(error) = write_new(&metadata_tmp, plan.serialized_metadata.as_bytes()) {
        cleanup();
        return Err(error);
    }
    if fail_at == Some("after-metadata-stage") {
        cleanup();
        return Err("simulated import failure".into());
    }
    if image.exists() || metadata.exists() {
        cleanup();
        return Err("An image-library destination appeared during import".into());
    }
    if let Err(error) =
        std::fs::rename(&image_tmp, &image).map_err(|e| format!("Failed to finalize image: {e}"))
    {
        cleanup();
        return Err(error);
    }
    if fail_at == Some("after-image-finalize") {
        let _ = std::fs::remove_file(&image);
        cleanup();
        return Err("simulated import failure".into());
    }
    if let Err(error) = std::fs::rename(&metadata_tmp, &metadata)
        .map_err(|e| format!("Failed to finalize metadata: {e}"))
    {
        let _ = std::fs::remove_file(&image);
        cleanup();
        return Err(error);
    }
    Ok(ImageLibraryImportResult {
        entry_id: plan.entry_id,
        image_path: image.to_string_lossy().to_string(),
        metadata_path: metadata.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn import_image_library_asset(
    plan: ImageLibraryImportPlan,
) -> Result<ImageLibraryImportResult, String> {
    execute_image_library_import(plan, None)
}

#[tauri::command]
pub fn import_file_media_item(request: FileMediaImportRequest) -> Result<String, String> {
    let media_root = file_media_root(&request.repository_root, &request.media_root)?;
    if !request.directory.is_empty()
        && (Path::new(&request.directory).is_absolute()
            || Path::new(&request.directory)
                .components()
                .any(|part| match part {
                    Component::Normal(name) => name.to_string_lossy().starts_with('.'),
                    _ => true,
                }))
    {
        return Err("Invalid file media directory".to_string());
    }
    let source = std::fs::canonicalize(&request.source_file_path)
        .map_err(|error| format!("Invalid source file {}: {error}", request.source_file_path))?;
    if !source.is_file() {
        return Err("The selected media source is not a file".to_string());
    }
    let name = source
        .file_name()
        .ok_or_else(|| "Invalid source filename".to_string())?;
    let target = media_root.join(&request.directory).join(name);
    reject_hidden(&target.to_string_lossy())?;
    let target = managed_target(&media_root, &target.to_string_lossy(), true)?;
    if target.exists() {
        return Err(format!("File already exists: {}", target.display()));
    }
    let staged = transaction_temp(&target, "file-media-import")?;
    let _ = std::fs::remove_file(&staged);
    if let Err(error) = std::fs::copy(&source, &staged) {
        let _ = std::fs::remove_file(&staged);
        return Err(format!("Failed to stage file media: {error}"));
    }
    if target.exists() {
        let _ = std::fs::remove_file(&staged);
        return Err(format!("File already exists: {}", target.display()));
    }
    std::fs::rename(&staged, &target).map_err(|error| {
        let _ = std::fs::remove_file(&staged);
        format!("Failed to import file media: {error}")
    })?;
    Ok(target.to_string_lossy().to_string())
}

/// Compatibility command for the conventional public media root.
#[tauri::command]
pub fn import_public_media_file(request: PublicMediaImportRequest) -> Result<String, String> {
    let media_root = Path::new(&request.repository_root).join("public");
    import_file_media_item(FileMediaImportRequest {
        repository_root: request.repository_root,
        media_root: media_root.to_string_lossy().to_string(),
        source_file_path: request.source_file_path,
        directory: request.directory,
    })
}

/// Reads a picked image's raw bytes so the webview can decode it same-origin
/// (e.g. to transcode a HEIC the site can't render). Mirrors the filesystem
/// read the importer already performs when copying a chosen source.
#[tauri::command]
pub fn read_image_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|error| format!("Could not read image: {error}"))
}

/// ISO-BMFF `ftyp` brands that identify a HEIF/HEIC image.
const HEIF_BRANDS: [&[u8]; 11] = [
    b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"hevm", b"hevs", b"mif1", b"msf1",
    b"heif",
];

/// Sniffs a picked file's leading ISO-BMFF box to decide whether it needs
/// HEIC→JPEG transcoding. Reading only the header avoids trusting the (on iOS,
/// frequently wrong) filename extension and avoids shuttling the whole file
/// when no conversion is required.
#[tauri::command]
pub fn probe_image_is_heif(path: String) -> Result<bool, String> {
    use std::io::Read;
    let mut file =
        std::fs::File::open(&path).map_err(|error| format!("Could not open {path}: {error}"))?;
    let mut header = [0u8; 12];
    let read = file
        .read(&mut header)
        .map_err(|error| format!("Could not read {path}: {error}"))?;
    if read < 12 || &header[4..8] != b"ftyp" {
        return Ok(false);
    }
    let brand = header[8..12].to_ascii_lowercase();
    Ok(HEIF_BRANDS.contains(&brand.as_slice()))
}

/// Persists bytes produced in the webview (e.g. a HEIC transcoded to JPEG) to a
/// uniquely named file, giving the importer a real source path to copy from and
/// the webview an asset-protocol path to preview. Writes into the app cache
/// dir (like thumbnails) rather than `std::env::temp_dir()`, which resolves to
/// an inaccessible `/tmp` inside the iOS sandbox. The name is content- and
/// time-derived so concurrent picks never clash.
#[tauri::command]
pub fn write_temp_image(
    app: tauri::AppHandle,
    bytes: Vec<u8>,
    extension: String,
) -> Result<String, String> {
    let ext: String = extension
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect();
    if ext.is_empty() {
        return Err("A file extension is required".to_string());
    }
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not locate app cache: {error}"))?
        .join("image-imports");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create import cache: {error}"))?;
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default()
        .hash(&mut hasher);
    let path = directory.join(format!("{:x}.{ext}", hasher.finish()));
    std::fs::write(&path, &bytes)
        .map_err(|error| format!("Could not write temp image: {error}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_reads_only_suppress_not_found() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("config.yml");
        std::fs::write(&file, "title: hello").unwrap();

        assert_eq!(
            read_text_file_optional(file.to_string_lossy().to_string()).unwrap(),
            Some("title: hello".to_string())
        );
        assert_eq!(
            read_text_file_optional(
                temp.path()
                    .join("missing.yml")
                    .to_string_lossy()
                    .to_string()
            )
            .unwrap(),
            None
        );
        assert!(read_text_file_optional(temp.path().to_string_lossy().to_string()).is_err());
    }

    #[test]
    fn frontmatter_scalar_scan_matches_typescript_fixture() {
        let temp = tempfile::tempdir().unwrap();
        let fixture = temp.path().join("frontmatter-scalars.md");
        std::fs::write(
            &fixture,
            include_str!("../../packages/core/test/fixtures/frontmatter-scalars.md"),
        )
        .unwrap();

        let actual = frontmatter_scalars(&fixture, "md").unwrap();
        let expected = std::collections::BTreeMap::from([
            ("decimal".to_string(), "1.5".to_string()),
            ("disabled".to_string(), "false".to_string()),
            ("enabled".to_string(), "true".to_string()),
            ("hexadecimal".to_string(), "31".to_string()),
            ("hexadecimal_uppercase".to_string(), "0X1F".to_string()),
            ("integer".to_string(), "12".to_string()),
            ("leading_zero".to_string(), "01".to_string()),
            ("legacy_boolean".to_string(), "yes".to_string()),
            ("octal".to_string(), "15".to_string()),
            ("octal_uppercase".to_string(), "0O17".to_string()),
            ("plain_with_comment".to_string(), "visible".to_string()),
            ("slug".to_string(), "hello:world".to_string()),
            ("title".to_string(), "A: colon".to_string()),
        ]);
        assert_eq!(actual, expected);
    }

    #[test]
    fn image_thumbnails_are_bounded_cached_and_revisioned() {
        let source_dir = tempfile::tempdir().unwrap();
        let cache_dir = tempfile::tempdir().unwrap();
        let source = source_dir.path().join("large.png");
        image::RgbaImage::from_pixel(800, 600, image::Rgba([25, 100, 200, 255]))
            .save(&source)
            .unwrap();

        let first = cached_image_thumbnail(cache_dir.path(), &source, 320, 240).unwrap();
        let cached = cached_image_thumbnail(cache_dir.path(), &source, 320, 240).unwrap();
        assert_eq!(first, cached);
        assert_eq!(image::image_dimensions(&first).unwrap(), (320, 240));

        image::RgbaImage::from_pixel(400, 800, image::Rgba([200, 50, 25, 255]))
            .save(&source)
            .unwrap();
        let revised = cached_image_thumbnail(cache_dir.path(), &source, 320, 240).unwrap();
        assert_ne!(first, revised);
        assert_eq!(image::image_dimensions(&revised).unwrap(), (120, 240));
        assert!(!first.exists(), "superseded revisions should be removed");
    }

    #[test]
    fn image_thumbnails_apply_exif_orientation_for_import_previews() {
        let source_dir = tempfile::tempdir().unwrap();
        let cache_dir = tempfile::tempdir().unwrap();
        let source = source_dir.path().join("portrait.jpg");
        image::RgbImage::from_pixel(2, 3, image::Rgb([25, 100, 200]))
            .save(&source)
            .unwrap();

        // EXIF orientation 6 means the stored pixels should display 90° clockwise.
        let exif_orientation_6: [u8; 36] = [
            0xff, 0xe1, 0x00, 0x22, b'E', b'x', b'i', b'f', 0x00, 0x00, b'I', b'I', 0x2a, 0x00,
            0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00,
            0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ];
        let encoded = std::fs::read(&source).unwrap();
        let mut oriented = Vec::with_capacity(encoded.len() + exif_orientation_6.len());
        oriented.extend_from_slice(&encoded[..2]);
        oriented.extend_from_slice(&exif_orientation_6);
        oriented.extend_from_slice(&encoded[2..]);
        std::fs::write(&source, oriented).unwrap();

        let preview = cached_image_thumbnail(cache_dir.path(), &source, 3, 3).unwrap();
        assert_eq!(image::image_dimensions(preview).unwrap(), (3, 2));
    }

    #[test]
    fn directories_flatten_to_top_level_groups() {
        let dir = std::env::temp_dir().join(format!("posto-test-{}", std::process::id()));
        let blogs = dir.join("src/content/blogs");
        std::fs::create_dir_all(&blogs).unwrap();
        std::fs::write(blogs.join("post.md"), "# hi").unwrap();
        std::fs::write(dir.join("index.md"), "# home").unwrap();
        // The schema surfaces at the root; dotfiles elsewhere stay hidden.
        std::fs::write(dir.join(".pages.yml"), "media: images").unwrap();
        std::fs::write(dir.join(".env"), "SECRET=1").unwrap();
        std::fs::write(blogs.join(".pages.yml"), "media: images").unwrap();
        let docs = dir.join("docs/guides");
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::write(dir.join("docs/readme.md"), "x").unwrap();
        std::fs::write(docs.join("a.md"), "x").unwrap();
        // Non-text files should be ignored, and dirs with none (src, src/content) skipped.
        std::fs::write(dir.join("src/code.ts"), "x").unwrap();

        let mut groups = Vec::new();
        collect_groups(&dir, &dir, &mut groups);
        groups.sort_by(|a, b| a.label.cmp(&b.label));
        let labels: Vec<&str> = groups.iter().map(|g| g.label.as_str()).collect();
        assert_eq!(labels, vec!["", "docs", "docs/guides", "src/content/blogs"]);
        let root_names: Vec<&str> = groups[0].files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(root_names, vec![".pages.yml", "index.md"]);
        let blog_names: Vec<&str> = groups[3].files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(blog_names, vec!["post.md"]);
        assert!(groups[3].path.ends_with("src/content/blogs"));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn child_directories_are_bounded_to_one_visible_level() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("apps/site/content")).unwrap();
        std::fs::create_dir_all(dir.path().join("packages/docs")).unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(dir.path().join(".hidden/project")).unwrap();

        let listed = list_child_directories(dir.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(
            listed,
            vec![
                dir.path().join("apps").to_string_lossy().to_string(),
                dir.path().join("packages").to_string_lossy().to_string(),
            ]
        );
    }

    fn import_plan(dir: &Path) -> ImageLibraryImportPlan {
        let library = dir.join("src/data/images");
        std::fs::create_dir_all(&library).unwrap();
        let source = dir.join("source.jpg");
        std::fs::write(&source, b"image").unwrap();
        ImageLibraryImportPlan {
            library_root: library.to_string_lossy().to_string(),
            source_image_path: source.to_string_lossy().to_string(),
            destination_image_path: library
                .join("nested/photo.jpg")
                .to_string_lossy()
                .to_string(),
            destination_metadata_path: library
                .join("nested/photo.yml")
                .to_string_lossy()
                .to_string(),
            serialized_metadata: "image: ./photo.jpg\nalt: Photo\n".into(),
            entry_id: "nested/photo".into(),
        }
    }

    #[test]
    fn paired_import_is_atomic_and_collision_safe() {
        let temp = tempfile::tempdir().unwrap();
        let plan = import_plan(temp.path());
        let image = plan.destination_image_path.clone();
        let metadata = plan.destination_metadata_path.clone();
        let result = execute_image_library_import(plan, None).unwrap();
        assert_eq!(result.entry_id, "nested/photo");
        assert!(Path::new(&image).exists() && Path::new(&metadata).exists());

        let collision = import_plan(temp.path());
        assert!(execute_image_library_import(collision, None).is_err());
        assert_eq!(std::fs::read(&image).unwrap(), b"image");
    }

    #[test]
    fn public_media_import_copies_only_the_file_inside_public() {
        let temp = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let source_file = source.path().join("guide.pdf");
        std::fs::write(&source_file, b"pdf").unwrap();
        let request = || PublicMediaImportRequest {
            repository_root: temp.path().to_string_lossy().to_string(),
            source_file_path: source_file.to_string_lossy().to_string(),
            directory: "downloads/guides".into(),
        };

        create_public_media_directory(
            temp.path().to_string_lossy().to_string(),
            "downloads".into(),
        )
        .unwrap();
        assert!(temp.path().join("public/downloads").is_dir());
        assert!(create_public_media_directory(
            temp.path().to_string_lossy().to_string(),
            "../outside".into(),
        )
        .is_err());

        let imported = import_public_media_file(request()).unwrap();
        assert_eq!(
            Path::new(&imported),
            std::fs::canonicalize(temp.path())
                .unwrap()
                .join("public/downloads/guides/guide.pdf")
        );
        assert_eq!(std::fs::read(&imported).unwrap(), b"pdf");
        assert_eq!(
            std::fs::read_dir(temp.path().join("public/downloads/guides"))
                .unwrap()
                .count(),
            1
        );
        assert!(import_public_media_file(request()).is_err());

        let traversal = PublicMediaImportRequest {
            directory: "../outside".into(),
            ..request()
        };
        assert!(import_public_media_file(traversal).is_err());
    }

    #[test]
    fn media_management_creates_folders_and_deletes_pairs_inside_the_library() {
        let temp = tempfile::tempdir().unwrap();
        let library = temp.path().join("src/data/images");
        std::fs::create_dir_all(&library).unwrap();
        let folder = library.join("portraits");
        create_image_library_directory(
            library.to_string_lossy().to_string(),
            folder.to_string_lossy().to_string(),
        )
        .unwrap();
        assert!(folder.is_dir());
        assert!(create_image_library_directory(
            library.to_string_lossy().to_string(),
            temp.path().join("outside").to_string_lossy().to_string(),
        )
        .is_err());

        let image = folder.join("photo.jpg");
        let metadata = folder.join("photo.yml");
        std::fs::write(&image, b"image").unwrap();
        std::fs::write(&metadata, "image: ./photo.jpg\n").unwrap();
        delete_image_library_asset(
            library.to_string_lossy().to_string(),
            image.to_string_lossy().to_string(),
            metadata.to_string_lossy().to_string(),
        )
        .unwrap();
        assert!(!image.exists() && !metadata.exists());

        let source = library.join("source");
        let destination = library.join("destination");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        let image = source.join("moved.jpg");
        let metadata = source.join("moved.yml");
        std::fs::write(&image, b"image").unwrap();
        std::fs::write(&metadata, "image: ./moved.jpg\n").unwrap();
        move_image_library_asset(
            library.to_string_lossy().to_string(),
            image.to_string_lossy().to_string(),
            metadata.to_string_lossy().to_string(),
            destination.to_string_lossy().to_string(),
        )
        .unwrap();
        assert!(!image.exists() && !metadata.exists());
        assert!(destination.join("moved.jpg").is_file());
        assert!(destination.join("moved.yml").is_file());
        rename_image_library_asset(
            library.to_string_lossy().to_string(),
            destination.join("moved.jpg").to_string_lossy().to_string(),
            destination.join("moved.yml").to_string_lossy().to_string(),
            destination
                .join("renamed.jpg")
                .to_string_lossy()
                .to_string(),
            destination
                .join("renamed.yml")
                .to_string_lossy()
                .to_string(),
            "image: ./renamed.jpg\n".to_string(),
        )
        .unwrap();
        assert!(!destination.join("moved.jpg").exists());
        assert!(!destination.join("moved.yml").exists());
        assert_eq!(
            std::fs::read_to_string(destination.join("renamed.yml")).unwrap(),
            "image: ./renamed.jpg\n"
        );
        assert!(move_image_library_asset(
            library.to_string_lossy().to_string(),
            destination
                .join("renamed.jpg")
                .to_string_lossy()
                .to_string(),
            destination
                .join("renamed.yml")
                .to_string_lossy()
                .to_string(),
            temp.path().to_string_lossy().to_string(),
        )
        .is_err());

        let album = library.join("album");
        let archive = library.join("archive");
        std::fs::create_dir_all(album.join("nested")).unwrap();
        std::fs::create_dir_all(&archive).unwrap();
        std::fs::write(album.join("nested/photo.jpg"), b"image").unwrap();
        move_image_library_directory(
            library.to_string_lossy().to_string(),
            album.to_string_lossy().to_string(),
            archive.to_string_lossy().to_string(),
        )
        .unwrap();
        let moved_album = archive.join("album");
        assert!(moved_album.join("nested/photo.jpg").is_file());
        assert!(move_image_library_directory(
            library.to_string_lossy().to_string(),
            moved_album.to_string_lossy().to_string(),
            moved_album.join("nested").to_string_lossy().to_string(),
        )
        .is_err());
        delete_image_library_directory(
            library.to_string_lossy().to_string(),
            moved_album.to_string_lossy().to_string(),
        )
        .unwrap();
        assert!(!moved_album.exists());
        assert!(delete_image_library_directory(
            library.to_string_lossy().to_string(),
            library.to_string_lossy().to_string(),
        )
        .is_err());
    }

    #[test]
    fn file_media_management_is_root_scoped_and_metadata_agnostic() {
        let temp = tempfile::tempdir().unwrap();
        let media_root = temp.path().join("media");
        let destination = media_root.join("destination");
        for directory in ["source", "destination"] {
            create_file_media_directory(
                temp.path().to_string_lossy().to_string(),
                media_root.to_string_lossy().to_string(),
                directory.to_string(),
            )
            .unwrap();
        }
        let picked = temp.path().join("clip.mp4");
        std::fs::write(&picked, b"video").unwrap();
        let imported = import_file_media_item(FileMediaImportRequest {
            repository_root: temp.path().to_string_lossy().to_string(),
            media_root: media_root.to_string_lossy().to_string(),
            source_file_path: picked.to_string_lossy().to_string(),
            directory: "source".to_string(),
        })
        .unwrap();
        let file = PathBuf::from(imported);

        move_media_file(
            media_root.to_string_lossy().to_string(),
            file.to_string_lossy().to_string(),
            destination.to_string_lossy().to_string(),
        )
        .unwrap();
        let moved = destination.join("clip.mp4");
        assert!(moved.is_file());
        assert!(move_media_file(
            media_root.to_string_lossy().to_string(),
            moved.to_string_lossy().to_string(),
            temp.path().to_string_lossy().to_string(),
        )
        .is_err());
        let renamed = destination.join("renamed.mp4");
        rename_media_file(
            media_root.to_string_lossy().to_string(),
            moved.to_string_lossy().to_string(),
            renamed.to_string_lossy().to_string(),
        )
        .unwrap();
        assert!(renamed.is_file());
        delete_media_file(
            media_root.to_string_lossy().to_string(),
            renamed.to_string_lossy().to_string(),
        )
        .unwrap();
        assert!(!renamed.exists());

        let album = media_root.join("album");
        std::fs::create_dir_all(album.join("nested")).unwrap();
        std::fs::write(album.join("nested/cover.webp"), b"image").unwrap();
        move_media_directory(
            media_root.to_string_lossy().to_string(),
            album.to_string_lossy().to_string(),
            destination.to_string_lossy().to_string(),
        )
        .unwrap();
        let moved_album = destination.join("album");
        assert!(moved_album.join("nested/cover.webp").is_file());
        delete_media_directory(
            media_root.to_string_lossy().to_string(),
            moved_album.to_string_lossy().to_string(),
        )
        .unwrap();
        assert!(!moved_album.exists());
    }

    #[test]
    fn paired_import_rolls_back_each_finalize_stage() {
        for stage in [
            "after-image-stage",
            "after-metadata-stage",
            "after-image-finalize",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let plan = import_plan(temp.path());
            let image = plan.destination_image_path.clone();
            let metadata = plan.destination_metadata_path.clone();
            assert!(execute_image_library_import(plan, Some(stage)).is_err());
            assert!(
                !Path::new(&image).exists() && !Path::new(&metadata).exists(),
                "left files after {stage}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn managed_paths_reject_symlink_escape() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let library = temp.path().join("library");
        std::fs::create_dir(&library).unwrap();
        symlink(outside.path(), library.join("escape")).unwrap();
        let target = library.join("escape/photo.jpg");
        assert!(managed_target(&library, target.to_str().unwrap(), true).is_err());
    }
}

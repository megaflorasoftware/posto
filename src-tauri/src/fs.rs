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
    let image = image::ImageReader::open(source)
        .map_err(|error| format!("Could not open {}: {error}", source.display()))?
        .with_guessed_format()
        .map_err(|error| format!("Could not identify {}: {error}", source.display()))?
        .decode()
        .map_err(|error| format!("Could not decode {}: {error}", source.display()))?;
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

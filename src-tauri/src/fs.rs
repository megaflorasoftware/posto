use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

// Content formats only — code files (.ts, .js, .css, config files, …) are
// deliberately excluded from the file chooser.
const TEXT_EXTENSIONS: &[&str] = &[
    "md", "mdx", "markdown", "txt", "html", "htm", "njk", "liquid", "hbs", "mustache", "ejs",
    "pug", "rst", "csv",
];

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
    let trimmed = value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string();
    (!trimmed.is_empty()).then_some(trimmed)
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

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {path}: {e}"))
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
        .map_err(|e| format!("Invalid source image: {e}"))?;
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

#[cfg(test)]
mod tests {
    use super::*;

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

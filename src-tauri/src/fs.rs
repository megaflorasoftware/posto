use serde::Serialize;
use std::path::Path;

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

/// Extracts `title:` (falling back to `name:`) from a markdown file's leading
/// frontmatter block. Line-based on purpose: sidebar labels don't warrant a
/// YAML parser, and multiline scalars simply fall back to the filename.
fn frontmatter_title(path: &Path, ext: &str) -> Option<String> {
    if !FRONTMATTER_TITLE_EXTENSIONS.contains(&ext) {
        return None;
    }
    let content = std::fs::read_to_string(path).ok()?;
    let mut lines = content.lines();
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    let mut title = None;
    let mut name = None;
    for line in lines {
        let end = line.trim_end();
        if end == "---" || end == "..." {
            break;
        }
        if let Some(v) = line.strip_prefix("title:") {
            title = frontmatter_scalar(v);
        } else if let Some(v) = line.strip_prefix("name:") {
            name = frontmatter_scalar(v);
        }
    }
    title.or(name)
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
                files.push(FileEntry {
                    title: frontmatter_title(&path, &ext),
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

/// Creates a new file, failing if one already exists at `path` — the "new
/// file" flow must never silently overwrite existing content.
#[tauri::command]
pub fn create_text_file(path: String, content: String) -> Result<(), String> {
    use std::io::Write;
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

#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|e| format!("Failed to delete {path}: {e}"))
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
}

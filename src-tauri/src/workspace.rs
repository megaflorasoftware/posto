use serde::Serialize;
use std::path::{Path, PathBuf};

const MAX_DEPTH: usize = 3;
const MARKERS: &[&str] = &[
    "astro.config.mjs",
    "astro.config.ts",
    "astro.config.js",
    "astro.config.mts",
    "astro.config.cjs",
    ".eleventy.js",
    "eleventy.config.js",
    "eleventy.config.cjs",
    "eleventy.config.mjs",
    "hugo.toml",
    "hugo.yaml",
    "hugo.json",
    "config.toml",
    "config.yaml",
    "config.json",
    ".pages.yml",
    "package.json",
    "pnpm-workspace.yaml",
    "lerna.json",
    "turbo.json",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInventory {
    dir: String,
    markers: Vec<String>,
}

fn scan_dir(dir: &Path, depth: usize, output: &mut Vec<ProjectInventory>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut names = Vec::new();
    let mut children: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_file() && MARKERS.contains(&name.as_str()) {
            names.push(name.clone());
            if name == "package.json" {
                let package = std::fs::read_to_string(entry.path())
                    .ok()
                    .and_then(|source| serde_json::from_str::<serde_json::Value>(&source).ok());
                if package
                    .as_ref()
                    .and_then(|value| value.get("workspaces"))
                    .is_some()
                {
                    names.push("package.json#workspaces".to_string());
                }
                for dependency in ["astro", "@11ty/eleventy"] {
                    let found = ["dependencies", "devDependencies", "peerDependencies"]
                        .iter()
                        .any(|group| {
                            package
                                .as_ref()
                                .and_then(|value| value.get(group))
                                .and_then(|value| value.get(dependency))
                                .is_some()
                        });
                    if found {
                        names.push(format!("dependency:{dependency}"));
                    }
                }
            }
        }
        if kind.is_dir() {
            if name == ".posto" && entry.path().join("index.json").is_file() {
                names.push(".posto/index.json".to_string());
                if let Some(project) = std::fs::read_to_string(entry.path().join("index.json"))
                    .ok()
                    .and_then(|source| serde_json::from_str::<serde_json::Value>(&source).ok())
                    .and_then(|value| {
                        value
                            .get("project")
                            .and_then(|value| value.as_str())
                            .map(str::to_string)
                    })
                {
                    names.push(format!("project:{project}"));
                }
            } else if name == ".astro" {
                names.push(".astro".to_string());
            } else if matches!(name.as_str(), "content" | "archetypes") {
                names.push(name.clone());
            }
            if depth < MAX_DEPTH
                && !name.starts_with('.')
                && !matches!(name.as_str(), "node_modules" | "target" | "dist" | "build")
            {
                children.push(entry.path());
            }
        }
    }
    names.sort();
    names.dedup();
    if !names.is_empty() {
        output.push(ProjectInventory {
            dir: dir.to_string_lossy().to_string(),
            markers: names,
        });
    }
    children.sort();
    for child in children {
        scan_dir(&child, depth + 1, output);
    }
}

#[tauri::command]
pub fn scan_projects(root: String) -> Result<Vec<ProjectInventory>, String> {
    let path = Path::new(&root);
    if !path.is_dir() {
        return Err(format!("Not a directory: {root}"));
    }
    let mut output = Vec::new();
    scan_dir(path, 0, &mut output);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_is_bounded_and_skips_hidden_trees() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("apps/site")).unwrap();
        std::fs::write(dir.path().join("pnpm-workspace.yaml"), "packages: [apps/*]").unwrap();
        std::fs::write(dir.path().join("apps/site/astro.config.mjs"), "").unwrap();
        std::fs::create_dir_all(dir.path().join(".hidden/site")).unwrap();
        std::fs::write(dir.path().join(".hidden/site/astro.config.mjs"), "").unwrap();

        let inventory = scan_projects(dir.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(inventory.len(), 2);
        assert!(inventory
            .iter()
            .any(|item| item.markers.contains(&"pnpm-workspace.yaml".into())));
        assert!(inventory
            .iter()
            .any(|item| item.markers.contains(&"astro.config.mjs".into())));
    }
}

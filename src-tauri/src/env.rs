// ---- Managed environment ---------------------------------------------------
//
// When node (or the project's package manager) is missing from the system,
// posto provisions its own copies rather than touching the system: the
// official Node binaries go into the app data dir, and corepack shims for
// pnpm/yarn go next to them. Every process posto spawns gets these
// directories prepended to PATH, so system installs still win when present.

use serde::Serialize;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::Manager;

/// Node version posto provisions when the system has none. Pinned so the
/// download URL and the extracted directory name are deterministic.
const MANAGED_NODE_VERSION: &str = "22.14.0";

/// Platform half of nodejs.org's release file names, e.g. "darwin-arm64".
fn node_dist_slug() -> Result<String, String> {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        "windows" => "win",
        other => return Err(format!("No Node.js binaries published for OS: {other}")),
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => return Err(format!("No Node.js binaries published for CPU: {other}")),
    };
    Ok(format!("{os}-{arch}"))
}

fn managed_node_root(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("node"))
}

/// Directory holding the managed runtime's executables, if the platform is
/// supported (whether or not the runtime is actually installed yet).
fn managed_node_bin(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let slug = node_dist_slug().ok()?;
    let dir = managed_node_root(app)?.join(format!("node-v{MANAGED_NODE_VERSION}-{slug}"));
    // Windows zips put node.exe at the archive root; unix tarballs use bin/.
    Some(if cfg!(windows) { dir } else { dir.join("bin") })
}

fn corepack_shim_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("corepack-shims"))
}

/// PATH for spawned tools: corepack shims and the managed Node runtime first,
/// then the system PATH, so posto's copies fill gaps without shadowing
/// intentional system installs of *other* tools.
pub(crate) fn setup_path(app: &tauri::AppHandle) -> String {
    let sep = if cfg!(windows) { ";" } else { ":" };
    let mut parts = Vec::new();
    if let Some(d) = corepack_shim_dir(app) {
        parts.push(d.display().to_string());
    }
    if let Some(d) = managed_node_bin(app) {
        parts.push(d.display().to_string());
    }
    parts.push(std::env::var("PATH").unwrap_or_default());
    parts.join(sep)
}

/// `<tool> --version` under posto's PATH, or None if it can't run. Corepack
/// networking is disabled so probing a pnpm/yarn shim reports "missing"
/// instead of silently downloading — installs belong to the install step.
fn tool_version(app: &tauri::AppHandle, tool: &str, cwd: Option<&Path>) -> Option<String> {
    let mut cmd = Command::new(tool);
    cmd.arg("--version")
        .env("PATH", setup_path(app))
        .env("COREPACK_ENABLE_NETWORK", "0")
        .env("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0")
        .stdin(Stdio::null());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!v.is_empty()).then_some(v)
}

/// Git's version, or None when git isn't usable. On macOS a git shim exists
/// at /usr/bin/git even without the Xcode Command Line Tools, and *running*
/// it pops Apple's install dialog — so probe `xcode-select -p` first. (CLT
/// presence is an accurate proxy: Homebrew git implies CLT too.)
fn git_version(app: &tauri::AppHandle) -> Option<String> {
    if cfg!(target_os = "macos") {
        let clt = Command::new("xcode-select")
            .arg("-p")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !clt {
            return None;
        }
    }
    tool_version(app, "git", None)
}

#[tauri::command]
pub async fn install_git(app: tauri::AppHandle) -> Result<String, String> {
    if let Some(v) = git_version(&app) {
        return Ok(v);
    }
    #[cfg(target_os = "macos")]
    {
        // Opens Apple's GUI installer for the Command Line Tools. The command
        // returns immediately while the user drives the dialog, so poll until
        // the tools land (or the user gives up).
        Command::new("xcode-select")
            .arg("--install")
            .status()
            .map_err(|e| format!("Failed to run xcode-select: {e}"))?;
        let deadline = std::time::Instant::now() + Duration::from_secs(15 * 60);
        while std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_secs(3));
            if let Some(v) = git_version(&app) {
                return Ok(v);
            }
        }
        return Err(
            "Timed out waiting for the Command Line Tools install — finish the system dialog, then retry"
                .to_string(),
        );
    }
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("winget")
            .args([
                "install",
                "--id",
                "Git.Git",
                "-e",
                "--silent",
                "--accept-package-agreements",
                "--accept-source-agreements",
            ])
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("Failed to run winget: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "winget install of git failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        return git_version(&app)
            .ok_or_else(|| "Git was installed but isn't runnable yet — restart posto".to_string());
    }
    #[allow(unreachable_code)]
    Err(
        "Install git with your distribution's package manager (e.g. `sudo apt install git`), then retry"
            .to_string(),
    )
}

#[derive(Serialize)]
pub struct EnvCheck {
    git_version: Option<String>,
    node_version: Option<String>,
    package_manager: String,
    package_manager_version: Option<String>,
    needs_node_modules: bool,
}

#[tauri::command]
pub async fn check_environment(app: tauri::AppHandle, root: String) -> EnvCheck {
    let path = Path::new(&root);
    let pm = package_manager(path);
    // cwd matters for corepack shims: a `packageManager` pin in package.json
    // decides which pnpm/yarn version the shim resolves.
    EnvCheck {
        git_version: git_version(&app),
        node_version: tool_version(&app, "node", None),
        package_manager: pm.to_string(),
        package_manager_version: tool_version(&app, pm, Some(path)),
        needs_node_modules: path.join("package.json").exists()
            && !path.join("node_modules").exists(),
    }
}

#[tauri::command]
pub async fn install_node(app: tauri::AppHandle) -> Result<String, String> {
    if let Some(v) = tool_version(&app, "node", None) {
        return Ok(v); // present since the check (or a previous managed install)
    }
    let slug = node_dist_slug()?;
    let root = managed_node_root(&app).ok_or("No app data directory available")?;
    std::fs::create_dir_all(&root).map_err(|e| format!("Failed to create runtime dir: {e}"))?;
    let ext = if cfg!(windows) { "zip" } else { "tar.gz" };
    let archive_name = format!("node-v{MANAGED_NODE_VERSION}-{slug}.{ext}");
    let url = format!("https://nodejs.org/dist/v{MANAGED_NODE_VERSION}/{archive_name}");
    let archive = root.join(&archive_name);
    // curl and (bsd)tar ship with macOS, Windows 10+, and virtually all Linux
    // distros; bsdtar extracts both .tar.gz and .zip.
    let status = Command::new("curl")
        .args(["-fsSL", "--retry", "2", "-o"])
        .arg(&archive)
        .arg(&url)
        .status()
        .map_err(|e| format!("Failed to run curl: {e}"))?;
    if !status.success() {
        let _ = std::fs::remove_file(&archive);
        return Err(format!("Failed to download Node.js from {url}"));
    }
    let status = Command::new("tar")
        .arg("-xf")
        .arg(&archive)
        .arg("-C")
        .arg(&root)
        .status()
        .map_err(|e| format!("Failed to run tar: {e}"))?;
    let _ = std::fs::remove_file(&archive);
    if !status.success() {
        return Err("Failed to extract the Node.js runtime".to_string());
    }
    tool_version(&app, "node", None)
        .ok_or_else(|| "Node.js was downloaded but isn't runnable".to_string())
}

#[tauri::command]
pub async fn install_package_manager(app: tauri::AppHandle, root: String) -> Result<String, String> {
    let path = Path::new(&root);
    let pm = package_manager(path);
    if let Some(v) = tool_version(&app, pm, Some(path)) {
        return Ok(v);
    }
    if pm == "npm" {
        // npm ships inside every Node distribution, so a missing npm means a
        // broken Node install — corepack can't help.
        return Err("npm should come with Node.js but wasn't found — reinstall Node.js".into());
    }
    let shim_dir = corepack_shim_dir(&app).ok_or("No app data directory available")?;
    std::fs::create_dir_all(&shim_dir).map_err(|e| format!("Failed to create shim dir: {e}"))?;
    // Corepack ships with Node. Shims go into posto's own directory — never
    // into the Node bin dir, which isn't writable for system installs.
    let output = Command::new("corepack")
        .args(["enable", "--install-directory"])
        .arg(&shim_dir)
        .arg(pm)
        .env("PATH", setup_path(&app))
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Failed to run corepack (is Node.js installed?): {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "corepack enable failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    // First run through the shim downloads the actual package manager
    // (version pinned by package.json's `packageManager` field, if any).
    let output = Command::new(pm)
        .arg("--version")
        .current_dir(path)
        .env("PATH", setup_path(&app))
        .env("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Failed to run {pm}: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(format!(
            "Failed to provision {pm} via corepack: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn package_manager(root: &Path) -> &'static str {
    if root.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if root.join("yarn.lock").exists() {
        "yarn"
    } else {
        "npm"
    }
}

#[tauri::command]
pub fn needs_install(root: String) -> bool {
    let path = Path::new(&root);
    path.join("package.json").exists() && !path.join("node_modules").exists()
}

#[tauri::command]
pub async fn install_dependencies(app: tauri::AppHandle, root: String) -> Result<(), String> {
    let path = Path::new(&root);
    let pm = package_manager(path);
    let output = Command::new(pm)
        .arg("install")
        .current_dir(path)
        .env("PATH", setup_path(&app))
        // CI=true keeps pnpm from aborting on interactive prompts without a TTY.
        .env("CI", "true")
        .env("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Failed to run {pm} install: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: Vec<&str> = stderr.lines().rev().take(5).collect();
        Err(format!(
            "{pm} install failed: {}",
            tail.into_iter().rev().collect::<Vec<_>>().join("\n")
        ))
    }
}

use serde::Serialize;
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

// Content formats only — code files (.ts, .js, .css, config files, …) are
// deliberately excluded from the file chooser.
const TEXT_EXTENSIONS: &[&str] = &[
    "md", "mdx", "markdown", "txt", "html", "htm", "njk", "liquid", "hbs", "mustache", "ejs",
    "pug", "rst", "csv",
];

const SKIP_DIRS: &[&str] = &["node_modules", "_site", "dist", "build", "out", "target"];

#[derive(Serialize)]
struct FileEntry {
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
struct FileGroup {
    label: String,
    path: String,
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
        if name.starts_with('.') {
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
            if TEXT_EXTENSIONS.contains(&ext.as_str()) {
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
            files,
        });
    }
    for sub in subdirs {
        collect_groups(root, &sub, groups);
    }
}

#[tauri::command]
fn list_files(root: String) -> Result<Vec<FileGroup>, String> {
    let path = Path::new(&root);
    if !path.is_dir() {
        return Err(format!("Not a directory: {root}"));
    }
    let mut groups = Vec::new();
    collect_groups(path, path, &mut groups);
    // Root files first, then directories alphabetically by their path label.
    groups.sort_by(|a, b| a.label.cmp(&b.label));
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
fn list_dir_files(dir: String, extensions: Vec<String>) -> Result<Vec<FileEntry>, String> {
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
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {path}: {e}"))
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
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
fn create_text_file(path: String, content: String) -> Result<(), String> {
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

struct DevServer {
    child: Child,
    port: u16,
}

#[derive(Default)]
struct AppState {
    server: Mutex<Option<DevServer>>,
    // The preview iframe loads the site through a local proxy (see
    // `start_proxy`) so the app can observe which page the user navigates to
    // — the iframe itself is cross-origin and unreadable.
    proxy_port: Mutex<Option<u16>>,
    upstream_port: std::sync::Arc<Mutex<u16>>,
    last_route: std::sync::Arc<Mutex<Option<String>>>,
}

fn is_page_route(path: &str) -> bool {
    if !path.starts_with('/') || path.starts_with("/_") || path.starts_with("/@") {
        return false;
    }
    !path.rsplit('/').next().unwrap_or("").contains('.')
}

/// Parse an HTTP request head and return (path, is_user_navigation).
/// Navigations are GETs the browser marks with `Sec-Fetch-Mode: navigate`;
/// prefetch/preload requests carry `(Sec-)Purpose: prefetch` or a
/// non-navigate fetch mode and are excluded.
fn parse_request_head(head: &str) -> Option<(String, bool)> {
    let mut first = head.lines().next()?.split_whitespace();
    let method = first.next()?;
    let path = first.next()?.split('?').next()?.to_string();
    let lower = head.to_lowercase();
    let prefetch = lower.contains("purpose: prefetch");
    let navigate = if lower.contains("sec-fetch-mode:") {
        lower.contains("sec-fetch-mode: navigate")
    } else {
        // Older engines without Sec-Fetch headers: fall back to Accept.
        lower.contains("accept: text/html") || lower.contains("accept:text/html")
    };
    Some((path, method == "GET" && navigate && !prefetch))
}

fn connect_localhost(port: u16) -> std::io::Result<TcpStream> {
    let addrs = ("localhost", port).to_socket_addrs()?;
    let mut last_err = std::io::Error::other("localhost did not resolve");
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, Duration::from_millis(1000)) {
            Ok(stream) => return Ok(stream),
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

fn handle_proxy_conn(
    mut client: TcpStream,
    upstream_port: std::sync::Arc<Mutex<u16>>,
    last_route: std::sync::Arc<Mutex<Option<String>>>,
) -> std::io::Result<()> {
    use std::io::{Read, Write};
    // Read the first request head.
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    let header_end = loop {
        let n = client.read(&mut chunk)?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        if buf.len() > 64 * 1024 {
            return Ok(());
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    if let Some((path, is_navigation)) = parse_request_head(&head) {
        if is_navigation && is_page_route(&path) {
            *last_route.lock().unwrap() = Some(path);
        }
    }
    // Only the first request per connection is parsed, so ask the server to
    // close after responding — unless this is a WebSocket upgrade (HMR),
    // which must be tunneled untouched.
    let is_upgrade = head.to_lowercase().contains("upgrade:");
    let forwarded = if is_upgrade {
        buf
    } else {
        let mut rewritten = head
            .lines()
            .filter(|l| !l.is_empty() && !l.to_lowercase().starts_with("connection:"))
            .collect::<Vec<_>>()
            .join("\r\n");
        rewritten.push_str("\r\nConnection: close\r\n\r\n");
        let mut bytes = rewritten.into_bytes();
        bytes.extend_from_slice(&buf[header_end..]);
        bytes
    };
    let port = *upstream_port.lock().unwrap();
    let mut upstream = connect_localhost(port)?;
    upstream.write_all(&forwarded)?;
    let mut client_reader = client.try_clone()?;
    let mut upstream_writer = upstream.try_clone()?;
    let uploader = std::thread::spawn(move || {
        let _ = std::io::copy(&mut client_reader, &mut upstream_writer);
        let _ = upstream_writer.shutdown(std::net::Shutdown::Write);
    });
    let _ = std::io::copy(&mut upstream, &mut client);
    let _ = client.shutdown(std::net::Shutdown::Write);
    let _ = uploader.join();
    Ok(())
}

/// Start the preview proxy once per app run; the upstream dev-server port is
/// read per-connection, so restarting the dev server just retargets it.
fn ensure_proxy(state: &AppState) -> Result<u16, String> {
    let mut guard = state.proxy_port.lock().unwrap();
    if let Some(port) = *guard {
        return Ok(port);
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to start preview proxy: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to start preview proxy: {e}"))?
        .port();
    let upstream = state.upstream_port.clone();
    let last_route = state.last_route.clone();
    std::thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let upstream = upstream.clone();
            let last_route = last_route.clone();
            std::thread::spawn(move || {
                let _ = handle_proxy_conn(conn, upstream, last_route);
            });
        }
    });
    *guard = Some(port);
    Ok(port)
}

fn kill_server(server: &mut DevServer) {
    #[cfg(unix)]
    {
        // The child is its own process group leader; signal the whole group so
        // package-manager wrappers and their spawned node processes die too.
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{}", server.child.id())])
            .status();
    }
    let _ = server.child.kill();
    let _ = server.child.wait();
}

fn free_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| format!("Failed to find a free port: {e}"))
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
fn needs_install(root: String) -> bool {
    let path = Path::new(&root);
    path.join("package.json").exists() && !path.join("node_modules").exists()
}

#[tauri::command]
async fn install_dependencies(root: String) -> Result<(), String> {
    let path = Path::new(&root);
    let pm = package_manager(path);
    let output = Command::new(pm)
        .arg("install")
        .current_dir(path)
        // CI=true keeps pnpm from aborting on interactive prompts without a TTY.
        .env("CI", "true")
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

fn detect_dev_command(root: &Path, port: u16) -> Result<Command, String> {
    let package_json = root.join("package.json");
    if package_json.exists() {
        let raw = std::fs::read_to_string(&package_json)
            .map_err(|e| format!("Failed to read package.json: {e}"))?;
        let parsed: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| format!("Invalid package.json: {e}"))?;
        let scripts = parsed.get("scripts").cloned().unwrap_or_default();
        let script_cmd = ["dev", "start"]
            .iter()
            .find_map(|s| scripts.get(*s).and_then(|v| v.as_str()))
            .map(str::to_string);
        if let Some(script_cmd) = script_cmd {
            if !root.join("node_modules").exists() {
                return Err(
                    "node_modules not found — run your package manager's install in the site directory first"
                        .to_string(),
                );
            }
            // Run the script directly with node_modules/.bin on PATH instead
            // of going through `npm/pnpm/yarn run`: package-manager wrappers
            // fail in odd ways without a TTY (pnpm deps checks, build-script
            // approval prompts) and disagree about arg passthrough ("--").
            // Most dev servers (vite, astro, eleventy, next) accept --port;
            // PORT covers the env-based ones.
            let mut cmd = Command::new("sh");
            cmd.arg("-c").arg(format!("{script_cmd} --port {port}"));
            let bin = root.join("node_modules/.bin");
            if let Ok(current) = std::env::var("PATH") {
                cmd.env("PATH", format!("{}:{current}", bin.display()));
            }
            cmd.env("PORT", port.to_string());
            return Ok(cmd);
        }
    }
    let is_11ty = [".eleventy.js", "eleventy.config.js", "eleventy.config.mjs", "eleventy.config.cjs"]
        .iter()
        .any(|f| root.join(f).exists());
    if is_11ty || package_json.exists() {
        let mut cmd = Command::new("npx");
        cmd.args(["@11ty/eleventy", "--serve", "--port"])
            .arg(port.to_string());
        return Ok(cmd);
    }
    Err("No dev/start script or Eleventy config found in this directory".to_string())
}

fn pid_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("dev-server.pid"))
}

/// Kill a dev server left behind by a previous app instance (e.g. when the
/// process was killed without running its exit handler).
fn kill_stale_server(app: &tauri::AppHandle) {
    let Some(path) = pid_file(app) else { return };
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(pid) = raw.trim().parse::<u32>() {
            #[cfg(unix)]
            let _ = Command::new("kill")
                .args(["-TERM", &format!("-{pid}")])
                .status();
        }
    }
    let _ = std::fs::remove_file(path);
}

#[tauri::command]
async fn start_dev_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    root: String,
) -> Result<u16, String> {
    let root_path = Path::new(&root);
    let port = free_port()?;
    let mut cmd = detect_dev_command(root_path, port)?;
    cmd.current_dir(root_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start dev server: {e}"))?;

    if let Some(path) = pid_file(&app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, child.id().to_string());
    }

    *state.last_route.lock().unwrap() = None;
    *state.upstream_port.lock().unwrap() = port;
    let proxy_port = ensure_proxy(state.inner())?;

    let mut guard = state.server.lock().unwrap();
    if let Some(mut old) = guard.take() {
        kill_server(&mut old);
    }
    *guard = Some(DevServer { child, port });
    // The frontend talks to the proxy; the dev server itself stays internal.
    Ok(proxy_port)
}

#[tauri::command]
fn get_last_route(state: tauri::State<'_, AppState>) -> Option<String> {
    state.last_route.lock().unwrap().clone()
}

#[tauri::command]
fn stop_dev_server(state: tauri::State<'_, AppState>) {
    if let Some(mut server) = state.server.lock().unwrap().take() {
        kill_server(&mut server);
    }
}

/// Returns true once the dev server is accepting connections. Also reports an
/// error if the process died before ever binding the port.
#[tauri::command]
fn ping_dev_server(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let mut guard = state.server.lock().unwrap();
    let Some(server) = guard.as_mut() else {
        return Err("No dev server running".to_string());
    };
    // Try every address localhost resolves to — dev servers vary in whether
    // they bind IPv4 (127.0.0.1) or IPv6 (::1); Astro/vite bind ::1 only.
    let up = ("localhost", server.port)
        .to_socket_addrs()
        .map(|mut addrs| {
            addrs.any(|a| TcpStream::connect_timeout(&a, Duration::from_millis(300)).is_ok())
        })
        .unwrap_or(false);
    if !up {
        if let Ok(Some(status)) = server.child.try_wait() {
            guard.take();
            return Err(format!("Dev server exited early ({status})"));
        }
    }
    Ok(up)
}

fn dechunk(mut data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let Some(pos) = data.windows(2).position(|w| w == b"\r\n") else {
            break;
        };
        let size_line = String::from_utf8_lossy(&data[..pos]);
        let size = usize::from_str_radix(size_line.trim().split(';').next().unwrap_or(""), 16)
            .unwrap_or(0);
        if size == 0 {
            break;
        }
        let start = pos + 2;
        if data.len() < start + size {
            out.extend_from_slice(&data[start..]);
            break;
        }
        out.extend_from_slice(&data[start..start + size]);
        let next = start + size + 2; // skip trailing \r\n
        if next >= data.len() {
            break;
        }
        data = &data[next..];
    }
    out
}

/// Fetches a page's HTML from the internal dev server, for SEO previews that
/// parse the rendered <head>. Done in Rust so the webview needs no CORS
/// cooperation from the dev server.
#[tauri::command]
async fn fetch_page(state: tauri::State<'_, AppState>, route: String) -> Result<String, String> {
    use std::io::{Read, Write};
    if !route.starts_with('/') || route.contains("\r") || route.contains("\n") {
        return Err(format!("Invalid route: {route}"));
    }
    let port = {
        let guard = state.server.lock().unwrap();
        guard
            .as_ref()
            .map(|s| s.port)
            .ok_or("No dev server running")?
    };
    let mut stream = connect_localhost(port).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| e.to_string())?;
    let request = format!(
        "GET {route} HTTP/1.1\r\nHost: localhost:{port}\r\nAccept: text/html\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|e| format!("Failed to read page: {e}"))?;
    let header_end = response
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("Malformed HTTP response")?
        + 4;
    let head = String::from_utf8_lossy(&response[..header_end]).to_lowercase();
    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .unwrap_or("");
    if !status.starts_with('2') {
        return Err(format!("Dev server returned {status} for {route}"));
    }
    let body = if head.contains("transfer-encoding: chunked") {
        dechunk(&response[header_end..])
    } else {
        response[header_end..].to_vec()
    };
    Ok(String::from_utf8_lossy(&body).into_owned())
}

fn settings_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("settings.json"))
}

#[tauri::command]
fn get_last_root(app: tauri::AppHandle) -> Option<String> {
    let raw = std::fs::read_to_string(settings_path(&app)?).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let root = parsed.get("last_root")?.as_str()?.to_string();
    Path::new(&root).is_dir().then_some(root)
}

#[tauri::command]
fn set_last_root(app: tauri::AppHandle, root: String) {
    if let Some(path) = settings_path(&app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, serde_json::json!({ "last_root": root }).to_string());
    }
}

fn run_git(root: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.success() {
        Ok(stdout)
    } else {
        Err(if stderr.trim().is_empty() { stdout } else { stderr })
    }
}

#[derive(Serialize)]
struct ChangedFile {
    /// Porcelain XY status collapsed to one code: "M", "A", "D", "R", "??", ...
    status: String,
    path: String,
}

#[tauri::command]
fn changed_files(root: String) -> Result<Vec<ChangedFile>, String> {
    let output = run_git(&root, &["status", "--porcelain"])?;
    Ok(output
        .lines()
        .filter(|line| line.len() > 3)
        .map(|line| ChangedFile {
            status: line[..2].trim().to_string(),
            path: line[3..].to_string(),
        })
        .collect())
}

/// Reverts one changed file to its committed state. `path` is repo-relative
/// (as reported by `changed_files`). Untracked files have no committed state,
/// so revert means deleting them.
#[tauri::command]
fn revert_file(root: String, path: String) -> Result<(), String> {
    // `git status --porcelain` paths are relative to the repository root,
    // which is not necessarily the chosen directory.
    let toplevel = run_git(&root, &["rev-parse", "--show-toplevel"])?;
    let toplevel = toplevel.trim();
    let status = run_git(toplevel, &["status", "--porcelain", "--", &path])?;
    if status.starts_with("??") {
        let absolute = Path::new(toplevel).join(&path);
        std::fs::remove_file(&absolute)
            .map_err(|e| format!("Failed to delete {}: {e}", absolute.display()))
    } else {
        // Restores both index and working tree from HEAD.
        run_git(toplevel, &["checkout", "HEAD", "--", &path]).map(|_| ())
    }
}

#[tauri::command]
async fn publish(root: String, message: Option<String>) -> Result<String, String> {
    run_git(&root, &["add", "-A"])?;
    let status = run_git(&root, &["status", "--porcelain"])?;
    if status.trim().is_empty() {
        return Ok("Nothing to publish — no local changes.".to_string());
    }
    let message = message
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| "Site updates".to_string());
    run_git(&root, &["commit", "-m", &message])?;
    run_git(&root, &["push", "origin", "HEAD"])?;
    Ok("Published.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_head_parsing_distinguishes_navigation_from_prefetch() {
        let nav = "GET /blog/my-post HTTP/1.1\r\nHost: x\r\nSec-Fetch-Mode: navigate\r\nSec-Fetch-Dest: iframe\r\n\r\n";
        assert_eq!(
            parse_request_head(nav),
            Some(("/blog/my-post".to_string(), true))
        );
        let prefetch_fetch = "GET /about HTTP/1.1\r\nHost: x\r\nSec-Fetch-Mode: cors\r\n\r\n";
        assert_eq!(parse_request_head(prefetch_fetch), Some(("/about".to_string(), false)));
        let prefetch_link = "GET /about HTTP/1.1\r\nHost: x\r\nSec-Fetch-Mode: navigate\r\nSec-Purpose: prefetch\r\n\r\n";
        assert_eq!(parse_request_head(prefetch_link), Some(("/about".to_string(), false)));
        let legacy_nav = "GET /now HTTP/1.1\r\nHost: x\r\nAccept: text/html,application/xhtml+xml\r\n\r\n";
        assert_eq!(parse_request_head(legacy_nav), Some(("/now".to_string(), true)));
        let query = "GET /about?x=1 HTTP/1.1\r\nSec-Fetch-Mode: navigate\r\n\r\n";
        assert_eq!(parse_request_head(query), Some(("/about".to_string(), true)));

        assert!(is_page_route("/blog/my-post"));
        assert!(is_page_route("/"));
        assert!(!is_page_route("/_astro/x.css"));
        assert!(!is_page_route("/@vite/client"));
        assert!(!is_page_route("/favicon.ico"));
    }

    #[test]
    fn proxy_forwards_traffic_and_records_only_navigations() {
        use std::io::{Read, Write};
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let up_port = upstream.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for mut conn in upstream.incoming().flatten() {
                let mut buf = [0u8; 4096];
                let n = conn.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                // The forwarded request must be well-formed: exactly one
                // header terminator, with Connection: close inside the
                // headers (not after them).
                let ok = req.matches("\r\n\r\n").count() == 1
                    && req.ends_with("\r\n\r\n")
                    && req.contains("Connection: close\r\n");
                let body: &[u8] = if ok { b"ok" } else { b"NO" };
                let _ = conn.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                );
                let _ = conn.write_all(body);
            }
        });

        let state = AppState::default();
        *state.upstream_port.lock().unwrap() = up_port;
        let proxy_port = ensure_proxy(&state).unwrap();

        let send = |req: &[u8]| {
            let mut c = TcpStream::connect(("127.0.0.1", proxy_port)).unwrap();
            c.write_all(req).unwrap();
            let mut resp = String::new();
            c.read_to_string(&mut resp).unwrap();
            resp
        };

        let resp = send(b"GET /about HTTP/1.1\r\nHost: x\r\nSec-Fetch-Mode: navigate\r\n\r\n");
        assert!(resp.ends_with("ok"), "proxy should forward the response");
        assert_eq!(
            state.last_route.lock().unwrap().clone(),
            Some("/about".to_string())
        );

        let resp = send(
            b"GET /now HTTP/1.1\r\nHost: x\r\nSec-Fetch-Mode: navigate\r\nSec-Purpose: prefetch\r\n\r\n",
        );
        assert!(resp.ends_with("ok"));
        assert_eq!(
            state.last_route.lock().unwrap().clone(),
            Some("/about".to_string()),
            "prefetch must not update the route"
        );
    }

    #[test]
    fn directories_flatten_to_top_level_groups() {
        let dir = std::env::temp_dir().join(format!("posto-test-{}", std::process::id()));
        let blogs = dir.join("src/content/blogs");
        std::fs::create_dir_all(&blogs).unwrap();
        std::fs::write(blogs.join("post.md"), "# hi").unwrap();
        std::fs::write(dir.join("index.md"), "# home").unwrap();
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
        assert_eq!(groups[0].files[0].name, "index.md");
        assert_eq!(groups[3].files[0].name, "post.md");
        assert!(groups[3].path.ends_with("src/content/blogs"));

        std::fs::remove_dir_all(&dir).unwrap();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Apps launched from Finder get launchd's minimal PATH, so the preview
    // pane's dev server can't find node/npx. Recover the login shell's PATH.
    if let Err(e) = fix_path_env::fix() {
        eprintln!("failed to fix PATH: {e}");
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|app| {
            // Once per app start: reap a dev server orphaned by a previous
            // instance that exited without its Exit handler running.
            kill_stale_server(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_files,
            list_dir_files,
            read_text_file,
            write_text_file,
            create_text_file,
            start_dev_server,
            stop_dev_server,
            ping_dev_server,
            fetch_page,
            get_last_route,
            needs_install,
            install_dependencies,
            get_last_root,
            set_last_root,
            changed_files,
            revert_file,
            publish
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let server = app.state::<AppState>().server.lock().unwrap().take();
                if let Some(mut server) = server {
                    kill_server(&mut server);
                }
                if let Some(path) = pid_file(app) {
                    let _ = std::fs::remove_file(path);
                }
            }
        });
}

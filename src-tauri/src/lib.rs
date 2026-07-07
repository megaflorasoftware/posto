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
fn list_files(root: String) -> Result<Vec<FileGroup>, String> {
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

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|e| format!("Failed to delete {path}: {e}"))
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
    // Recursive watcher on the selected root; dropped (stopped) when a new
    // root is watched. Keeps the frontend in sync with edits made outside
    // the app (other editors, git operations, `astro sync`, …).
    watcher: Mutex<Option<notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>>>,
}

/// Paths whose changes the frontend doesn't care about: build output and
/// dependency churn, plus everything under `.astro` except the generated
/// collection schemas (the dev server rewrites other `.astro` files
/// constantly, which would otherwise spam refreshes).
fn watch_ignored(root: &str, path: &str) -> bool {
    let rel = match path.strip_prefix(root) {
        Some(rel) => rel.trim_start_matches('/'),
        None => return true,
    };
    if rel.starts_with(".astro/") || rel == ".astro" {
        return !rel.starts_with(".astro/collections");
    }
    rel.split('/').any(|segment| {
        matches!(
            segment,
            "node_modules" | ".git" | ".DS_Store" | ".vercel" | ".netlify" | "cache"
        ) || SKIP_DIRS.contains(&segment)
    })
}

/// Watches `root` recursively, emitting debounced `fs-changed` events with
/// the affected absolute paths. Replaces any previous watch.
#[tauri::command]
fn watch_root(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    root: String,
) -> Result<(), String> {
    use tauri::Emitter;
    let emit_root = root.clone();
    let mut debouncer = notify_debouncer_mini::new_debouncer(
        Duration::from_millis(500),
        move |result: notify_debouncer_mini::DebounceEventResult| {
            if let Ok(events) = result {
                let paths: Vec<String> = events
                    .iter()
                    .map(|event| event.path.to_string_lossy().to_string())
                    .filter(|path| !watch_ignored(&emit_root, path))
                    .collect();
                if !paths.is_empty() {
                    let _ = app.emit("fs-changed", paths);
                }
            }
        },
    )
    .map_err(|e| e.to_string())?;
    debouncer
        .watcher()
        .watch(Path::new(&root), notify::RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    // Assign last: an error above leaves the previous watch running.
    *state.watcher.lock().unwrap() = Some(debouncer);
    Ok(())
}

fn is_page_route(path: &str) -> bool {
    if !path.starts_with('/') || path.starts_with("/_") || path.starts_with("/@") {
        return false;
    }
    !path.rsplit('/').next().unwrap_or("").contains('.')
}

struct RequestInfo {
    path: String,
    is_get: bool,
    /// Browser-marked navigation: `Sec-Fetch-Mode: navigate` (or, on engines
    /// without Sec-Fetch headers, an `Accept: text/html` heuristic).
    navigate: bool,
    /// Prefetch/preload: `(Sec-)Purpose: prefetch`.
    prefetch: bool,
}

fn parse_request_head(head: &str) -> Option<RequestInfo> {
    let mut first = head.lines().next()?.split_whitespace();
    let method = first.next()?;
    let path = first.next()?.split('?').next()?.to_string();
    let lower = head.to_lowercase();
    let prefetch = lower.contains("purpose: prefetch");
    let navigate = if lower.contains("sec-fetch-mode:") {
        lower.contains("sec-fetch-mode: navigate")
    } else {
        lower.contains("accept: text/html") || lower.contains("accept:text/html")
    };
    Some(RequestInfo {
        path,
        is_get: method == "GET",
        navigate,
        prefetch,
    })
}

/// Proxy-local endpoint the reporter script calls; never forwarded upstream.
const REPORT_PATH: &str = "/__posto_route";

/// Spliced into every served HTML page. Reports the document's real location
/// to the proxy on load, on history changes (client-side routers), and on
/// Astro's post-swap event. Prefetched documents are downloaded but never
/// executed, so prefetches can't produce reports.
const REPORTER: &str = concat!(
    "<script>(()=>{",
    "const r=()=>{fetch('/__posto_route?p='+encodeURIComponent(location.pathname))",
    ".catch(()=>{})};",
    "for(const f of['pushState','replaceState']){",
    "const o=history[f].bind(history);",
    "history[f]=(...a)=>{const v=o(...a);setTimeout(r,0);return v};}",
    "addEventListener('popstate',r);",
    "addEventListener('astro:page-load',r);",
    "r()})()</script>"
);

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Insert the reporter right after the opening <head> tag (start of document
/// when there is none, so it still runs before any other script).
fn inject_reporter(body: &[u8]) -> Vec<u8> {
    let lower = body.to_ascii_lowercase();
    let insert_at = lower
        .windows(5)
        .position(|w| w == b"<head")
        .filter(|&p| matches!(lower.get(p + 5), Some(b'>') | Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r')))
        .and_then(|p| lower[p..].iter().position(|&b| b == b'>').map(|q| p + q + 1))
        .unwrap_or(0);
    let mut out = Vec::with_capacity(body.len() + REPORTER.len());
    out.extend_from_slice(&body[..insert_at]);
    out.extend_from_slice(REPORTER.as_bytes());
    out.extend_from_slice(&body[insert_at..]);
    out
}

/// Relay the upstream response; when it is an uncompressed 200 text/html
/// page, buffer the body (the upstream was told Connection: close), splice in
/// the reporter script, and fix Content-Length. Anything else streams through
/// untouched.
fn inject_and_relay(upstream: &mut TcpStream, client: &mut TcpStream) -> std::io::Result<()> {
    use std::io::{Read, Write};
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    let header_end = loop {
        let n = upstream.read(&mut chunk)?;
        if n == 0 {
            client.write_all(&buf)?;
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        if buf.len() > 64 * 1024 {
            client.write_all(&buf)?;
            std::io::copy(upstream, client)?;
            return Ok(());
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let lower = head.to_lowercase();
    let is_html_page = lower.lines().next().is_some_and(|l| l.contains(" 200"))
        && lower.contains("text/html")
        && !lower.contains("content-encoding:");
    if !is_html_page {
        client.write_all(&buf)?;
        std::io::copy(upstream, client)?;
        return Ok(());
    }
    let mut body = buf[header_end..].to_vec();
    let content_length = lower
        .lines()
        .find_map(|l| l.strip_prefix("content-length:"))
        .and_then(|v| v.trim().parse::<usize>().ok());
    if let Some(len) = content_length {
        while body.len() < len {
            let n = upstream.read(&mut chunk)?;
            if n == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..n]);
        }
    } else {
        loop {
            let n = upstream.read(&mut chunk)?;
            if n == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..n]);
        }
    }
    if lower.contains("transfer-encoding: chunked") {
        body = dechunk(&body);
    }
    let body = inject_reporter(&body);
    let mut new_head = head
        .lines()
        .filter(|l| {
            let ll = l.to_lowercase();
            !l.is_empty() && !ll.starts_with("content-length:") && !ll.starts_with("transfer-encoding:")
        })
        .collect::<Vec<_>>()
        .join("\r\n");
    new_head.push_str(&format!("\r\nContent-Length: {}\r\n\r\n", body.len()));
    client.write_all(new_head.as_bytes())?;
    client.write_all(&body)?;
    Ok(())
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
    // The reporter script injected into every page (see REPORTER) phones home
    // with the location the iframe actually shows. Answer locally — the dev
    // server never sees these.
    if let Some(query) = head.strip_prefix(&format!("GET {REPORT_PATH}?")) {
        let query = query.split_whitespace().next().unwrap_or("");
        for pair in query.split('&') {
            if let Some(value) = pair.strip_prefix("p=") {
                let path = percent_decode(value);
                if path.starts_with('/') {
                    *last_route.lock().unwrap() = Some(path);
                }
            }
        }
        client.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")?;
        return Ok(());
    }
    // Page-shaped GETs are candidates for script injection; real navigations
    // (marked by the browser) also record the route directly. Client-router
    // page loads and prefetches look identical on the wire — only the
    // reporter script, which prefetched documents never execute, can tell
    // where the iframe actually went.
    let mut inject = false;
    if let Some(req) = parse_request_head(&head) {
        if req.is_get && is_page_route(&req.path) {
            if req.navigate && !req.prefetch {
                *last_route.lock().unwrap() = Some(req.path);
            }
            inject = true;
        }
    }
    // Only the first request per connection is parsed, so ask the server to
    // close after responding — unless this is a WebSocket upgrade (HMR),
    // which must be tunneled untouched.
    let is_upgrade = head.to_lowercase().contains("upgrade:");
    if is_upgrade {
        inject = false;
    }
    let forwarded = if is_upgrade {
        buf
    } else {
        // Injection candidates also drop Accept-Encoding so the HTML comes
        // back uncompressed and can be spliced.
        let mut rewritten = head
            .lines()
            .filter(|l| {
                let lower = l.to_lowercase();
                !l.is_empty()
                    && !lower.starts_with("connection:")
                    && !(inject && lower.starts_with("accept-encoding:"))
            })
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
    if inject {
        let _ = inject_and_relay(&mut upstream, &mut client);
    } else {
        let _ = std::io::copy(&mut upstream, &mut client);
    }
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

// ---- Managed environment ---------------------------------------------------
//
// When node (or the project's package manager) is missing from the system,
// posto provisions its own copies rather than touching the system: the
// official Node binaries go into the app data dir, and corepack shims for
// pnpm/yarn go next to them. Every process posto spawns gets these
// directories prepended to PATH, so system installs still win when present.

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
fn setup_path(app: &tauri::AppHandle) -> String {
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
async fn install_git(app: tauri::AppHandle) -> Result<String, String> {
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
struct EnvCheck {
    git_version: Option<String>,
    node_version: Option<String>,
    package_manager: String,
    package_manager_version: Option<String>,
    needs_node_modules: bool,
}

#[tauri::command]
async fn check_environment(app: tauri::AppHandle, root: String) -> EnvCheck {
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
async fn install_node(app: tauri::AppHandle) -> Result<String, String> {
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
async fn install_package_manager(app: tauri::AppHandle, root: String) -> Result<String, String> {
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
fn needs_install(root: String) -> bool {
    let path = Path::new(&root);
    path.join("package.json").exists() && !path.join("node_modules").exists()
}

#[tauri::command]
async fn install_dependencies(app: tauri::AppHandle, root: String) -> Result<(), String> {
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

fn detect_dev_command(root: &Path, port: u16, base_path: &str) -> Result<Command, String> {
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
            cmd.env("PATH", format!("{}:{base_path}", bin.display()));
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
        cmd.env("PATH", base_path);
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
    let mut cmd = detect_dev_command(root_path, port, &setup_path(&app))?;
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

/// Fetches the remote and reports whether the upstream branch has commits the
/// local branch lacks. Errors out when there is no remote/upstream — callers
/// treat that as "nothing to fetch".
#[tauri::command]
async fn fetch_upstream(root: String) -> Result<bool, String> {
    run_git(&root, &["fetch", "--quiet"])?;
    let behind = run_git(&root, &["rev-list", "--count", "HEAD..@{u}"])?;
    Ok(behind.trim().parse::<u64>().unwrap_or(0) > 0)
}

/// Merges the already-fetched upstream branch into the working tree. The
/// server always wins: committed conflicts resolve with `-X theirs`, and when
/// a merge is blocked by uncommitted local edits those are stashed around the
/// merge — reapplied afterwards, except where they collide with what the
/// server changed (the merged version is kept there).
#[tauri::command]
async fn pull_upstream(root: String) -> Result<String, String> {
    run_git(&root, &["fetch", "--quiet"])?;
    let merge = || run_git(&root, &["merge", "--no-edit", "-X", "theirs", "@{u}"]);
    if merge().is_ok() {
        return Ok("Updated from server.".to_string());
    }
    let _ = run_git(&root, &["merge", "--abort"]);
    let dirty = !run_git(&root, &["status", "--porcelain"])?.trim().is_empty();
    if !dirty {
        // A clean tree that still can't merge is a real failure (unrelated
        // histories, diverged in a way -X theirs can't settle, …).
        return merge().map(|_| "Updated from server.".to_string());
    }
    run_git(
        &root,
        &["stash", "push", "--include-untracked", "-m", "posto-fetch"],
    )?;
    if let Err(e) = merge() {
        let _ = run_git(&root, &["merge", "--abort"]);
        let _ = run_git(&root, &["stash", "pop"]);
        return Err(e);
    }
    if run_git(&root, &["stash", "pop"]).is_err() {
        // Local edits conflict with what the server changed: keep the merged
        // (server) version of each conflicted file, then drop the stash.
        let conflicted = run_git(&root, &["diff", "--name-only", "--diff-filter=U"])?;
        for file in conflicted.lines().map(str::trim).filter(|l| !l.is_empty()) {
            let _ = run_git(&root, &["checkout", "--ours", "--", file]);
        }
        let _ = run_git(&root, &["reset", "-q"]);
        let _ = run_git(&root, &["stash", "drop"]);
    }
    Ok("Updated from server.".to_string())
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
        let parse = |head: &str| {
            let req = parse_request_head(head).unwrap();
            (req.path.clone(), req.is_get && req.navigate && !req.prefetch)
        };
        let nav = "GET /blog/my-post HTTP/1.1\r\nHost: x\r\nSec-Fetch-Mode: navigate\r\nSec-Fetch-Dest: iframe\r\n\r\n";
        assert_eq!(parse(nav), ("/blog/my-post".to_string(), true));
        let fetch = "GET /about HTTP/1.1\r\nHost: x\r\nSec-Fetch-Mode: cors\r\n\r\n";
        assert_eq!(parse(fetch), ("/about".to_string(), false));
        let prefetch_link = "GET /about HTTP/1.1\r\nHost: x\r\nSec-Fetch-Mode: navigate\r\nSec-Purpose: prefetch\r\n\r\n";
        assert_eq!(parse(prefetch_link), ("/about".to_string(), false));
        let legacy_nav = "GET /now HTTP/1.1\r\nHost: x\r\nAccept: text/html,application/xhtml+xml\r\n\r\n";
        assert_eq!(parse(legacy_nav), ("/now".to_string(), true));
        let query = "GET /about?x=1 HTTP/1.1\r\nSec-Fetch-Mode: navigate\r\n\r\n";
        assert_eq!(parse(query), ("/about".to_string(), true));

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
                // Paths containing "page" answer as HTML pages; others don't.
                if ok && req.contains("page") {
                    let body = "<html><head></head><body>hi</body></html>";
                    let _ = conn.write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        )
                        .as_bytes(),
                    );
                } else {
                    let body: &[u8] = if ok { b"ok" } else { b"NO" };
                    let _ = conn.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n",
                    );
                    let _ = conn.write_all(body);
                }
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

        // Client-router page loads and hover prefetches are indistinguishable
        // on the wire, so a plain fetch() of a page gets the reporter script
        // injected but must NOT move the route by itself.
        let resp = send(
            b"GET /blog/some-page HTTP/1.1\r\nHost: x\r\nSec-Fetch-Mode: cors\r\nAccept-Encoding: gzip\r\n\r\n",
        );
        assert!(
            resp.contains(REPORTER),
            "HTML pages must get the reporter script injected"
        );
        let body = resp.split("\r\n\r\n").nth(1).unwrap_or("");
        assert!(
            resp.contains(&format!("Content-Length: {}", body.len())),
            "Content-Length must cover the injected script"
        );
        assert!(body.ends_with("</html>"));
        assert_eq!(
            state.last_route.lock().unwrap().clone(),
            Some("/about".to_string()),
            "a page fetch alone (possibly a prefetch) must not move the route"
        );

        // The injected reporter is what records the real location.
        let resp = send(b"GET /__posto_route?p=%2Fblog%2Fsome-page HTTP/1.1\r\nHost: x\r\n\r\n");
        assert!(resp.starts_with("HTTP/1.1 204"));
        assert_eq!(
            state.last_route.lock().unwrap().clone(),
            Some("/blog/some-page".to_string()),
            "the reporter endpoint must record the served route"
        );
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
            delete_file,
            start_dev_server,
            stop_dev_server,
            ping_dev_server,
            fetch_page,
            get_last_route,
            needs_install,
            install_dependencies,
            check_environment,
            install_git,
            install_node,
            install_package_manager,
            get_last_root,
            set_last_root,
            changed_files,
            revert_file,
            fetch_upstream,
            pull_upstream,
            publish,
            watch_root
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

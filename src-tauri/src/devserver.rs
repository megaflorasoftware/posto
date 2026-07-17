use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

use crate::env::setup_path;
use crate::proxy::{connect_localhost, dechunk, ensure_proxy, ProxyState};

pub struct DevServer {
    child: Child,
    port: u16,
}

#[derive(Default)]
pub struct DevServerState {
    pub(crate) server: Mutex<Option<DevServer>>,
    // Rolling tail of the current dev server's stdout/stderr, kept so the
    // frontend can show diagnostics when the server fails to come up. Survives
    // the DevServer entry being reaped after an early exit.
    server_logs: std::sync::Arc<Mutex<Vec<String>>>,
}

pub(crate) fn kill_server(server: &mut DevServer) {
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

pub(crate) fn pid_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("dev-server.pid"))
}

/// Kill a dev server left behind by a previous app instance (e.g. when the
/// process was killed without running its exit handler).
pub(crate) fn kill_stale_server(app: &tauri::AppHandle) {
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

const SERVER_LOG_LINES: usize = 400;

/// Drops ANSI escape sequences (colors, cursor moves) from dev server output
/// so the captured logs read as plain text.
fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            out.push(ch);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            // CSI sequence: parameters end at the first alphabetic final byte.
            for terminator in chars.by_ref() {
                if terminator.is_ascii_alphabetic() {
                    break;
                }
            }
        }
    }
    out
}

/// Streams one of the dev server's output pipes into the rolling log buffer.
fn spool_server_output(
    reader: impl std::io::Read + Send + 'static,
    logs: std::sync::Arc<Mutex<Vec<String>>>,
) {
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        for line in BufReader::new(reader).lines() {
            let Ok(line) = line else { break };
            let mut logs = logs.lock().unwrap();
            if logs.len() >= SERVER_LOG_LINES {
                logs.remove(0);
            }
            logs.push(strip_ansi(&line));
        }
    });
}

#[tauri::command]
pub async fn start_dev_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, DevServerState>,
    proxy: tauri::State<'_, ProxyState>,
    root: String,
) -> Result<u16, String> {
    let root_path = Path::new(&root);
    let port = free_port()?;
    let mut cmd = detect_dev_command(root_path, port, &setup_path(&app))?;
    cmd.current_dir(root_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start dev server: {e}"))?;

    state.server_logs.lock().unwrap().clear();
    if let Some(stdout) = child.stdout.take() {
        spool_server_output(stdout, state.server_logs.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spool_server_output(stderr, state.server_logs.clone());
    }

    if let Some(path) = pid_file(&app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, child.id().to_string());
    }

    *proxy.last_route.lock().unwrap() = None;
    *proxy.upstream_port.lock().unwrap() = port;
    let proxy_port = ensure_proxy(proxy.inner())?;

    let mut guard = state.server.lock().unwrap();
    if let Some(mut old) = guard.take() {
        kill_server(&mut old);
    }
    *guard = Some(DevServer { child, port });
    // The frontend talks to the proxy; the dev server itself stays internal.
    Ok(proxy_port)
}

/// Tail of the current dev server's stdout/stderr, for the "info for
/// developers" panel shown when the server fails to start.
#[tauri::command]
pub fn get_dev_server_logs(state: tauri::State<'_, DevServerState>) -> Vec<String> {
    state.server_logs.lock().unwrap().clone()
}

#[tauri::command]
pub fn stop_dev_server(state: tauri::State<'_, DevServerState>) {
    if let Some(mut server) = state.server.lock().unwrap().take() {
        kill_server(&mut server);
    }
}

/// Returns true once the dev server is accepting connections. Also reports an
/// error if the process died before ever binding the port.
#[tauri::command]
pub fn ping_dev_server(state: tauri::State<'_, DevServerState>) -> Result<bool, String> {
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

/// Fetches a page's HTML from the internal dev server, for SEO previews that
/// parse the rendered <head>. Done in Rust so the webview needs no CORS
/// cooperation from the dev server.
#[tauri::command]
pub async fn fetch_page(
    state: tauri::State<'_, DevServerState>,
    route: String,
) -> Result<String, String> {
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

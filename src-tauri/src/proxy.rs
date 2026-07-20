use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::sync::Mutex;
use std::time::Duration;

#[derive(Default)]
pub struct ProxyState {
    // The preview iframe loads the site through a local proxy (see
    // `start_proxy`) so the app can observe which page the user navigates to
    // — the iframe itself is cross-origin and unreadable.
    proxy_port: Mutex<Option<u16>>,
    pub(crate) upstream_port: std::sync::Arc<Mutex<u16>>,
    pub(crate) last_route: std::sync::Arc<Mutex<Option<String>>>,
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

/// Spliced into every served HTML page. Does two jobs:
///
/// 1. Reports the document's real location to the proxy on load, on history
///    changes (client-side routers), and on Astro's post-swap event.
///    Prefetched documents are downloaded but never executed, so prefetches
///    can't produce reports.
/// 2. Persists scroll position across dev-server full reloads. Astro (and
///    other SSGs) can't hot-swap page HTML, so editing content triggers a
///    full `location.reload()`. A normal browser restores scroll for that via
///    `history.scrollRestoration`, but WKWebView drops it for the preview
///    iframe — so we save the position in sessionStorage (same origin as the
///    page) and restore it after reload when the path is unchanged.
const REPORTER: &str = concat!(
    "<script>(()=>{",
    "const r=()=>{fetch('/__posto_route?p='+encodeURIComponent(location.pathname))",
    ".catch(()=>{})};",
    "for(const f of['pushState','replaceState']){",
    "const o=history[f].bind(history);",
    "history[f]=(...a)=>{const v=o(...a);setTimeout(r,0);return v};}",
    "addEventListener('popstate',r);",
    "addEventListener('astro:page-load',r);",
    // Scroll persistence. Keyed on pathname so only a same-page reload
    // restores; a real navigation (new path) falls through to scroll-to-top.
    "const K='__posto_scroll';",
    "let q=0;const save=()=>{if(q)return;q=1;requestAnimationFrame(()=>{q=0;",
    "try{sessionStorage.setItem(K,JSON.stringify({p:location.pathname,x:scrollX,y:scrollY}))}catch(e){}})};",
    "addEventListener('scroll',save,{passive:true});",
    "addEventListener('pagehide',()=>{q=1;",
    "try{sessionStorage.setItem(K,JSON.stringify({p:location.pathname,x:scrollX,y:scrollY}))}catch(e){}});",
    "try{const s=JSON.parse(sessionStorage.getItem(K)||'null');",
    "if(s&&s.p===location.pathname){const go=()=>scrollTo(s.x,s.y);",
    "addEventListener('DOMContentLoaded',go);addEventListener('load',go);}}catch(e){}",
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

pub(crate) fn connect_localhost(port: u16) -> std::io::Result<TcpStream> {
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
pub(crate) fn ensure_proxy(state: &ProxyState) -> Result<u16, String> {
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

pub(crate) fn dechunk(mut data: &[u8]) -> Vec<u8> {
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

#[tauri::command]
pub fn get_last_route(state: tauri::State<'_, ProxyState>) -> Option<String> {
    state.last_route.lock().unwrap().clone()
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

        let state = ProxyState::default();
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
}

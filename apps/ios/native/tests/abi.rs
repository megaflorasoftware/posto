//! Drives commands through the C ABI exactly as Swift does: `posto_init`
//! once, then `posto_invoke` with a C callback. Nothing here touches the
//! network or the login Keychain.

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, Once, OnceLock};
use std::time::Duration;

use posto_native::{posto_init, posto_invoke};
use serde_json::{json, Value};

const TIMEOUT: Duration = Duration::from_secs(60);

/// The process-wide engine and the events it has emitted.
struct Engine {
    root: PathBuf,
    events: Mutex<Vec<(String, Value)>>,
}

impl Engine {
    fn config_dir(&self) -> PathBuf {
        self.root.join("config")
    }

    fn cache_dir(&self) -> PathBuf {
        self.root.join("cache")
    }

    fn events_named(&self, name: &str) -> Vec<Value> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(event, _)| event == name)
            .map(|(_, payload)| payload.clone())
            .collect()
    }
}

extern "C" fn on_event(context: *mut c_void, event: *const c_char, payload: *const c_char) {
    // SAFETY: `context` is the static `Engine`; the strings are valid for
    // the duration of the callback.
    let engine = unsafe { &*(context as *const Engine) };
    let event = unsafe { CStr::from_ptr(event) }
        .to_string_lossy()
        .into_owned();
    let payload = unsafe { CStr::from_ptr(payload) }.to_string_lossy();
    let payload = serde_json::from_str(&payload).unwrap_or(Value::Null);
    if let Ok(mut events) = engine.events.lock() {
        events.push((event, payload));
    }
}

fn engine() -> &'static Engine {
    static ENGINE: OnceLock<Engine> = OnceLock::new();
    static INIT: Once = Once::new();
    let engine = ENGINE.get_or_init(|| {
        let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join("abi-app");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        Engine {
            root,
            events: Mutex::new(Vec::new()),
        }
    });
    INIT.call_once(|| {
        let config = json!({
            "dataDir": engine.root.join("data"),
            "cacheDir": engine.cache_dir(),
            "configDir": engine.config_dir(),
        });
        let config = CString::new(config.to_string()).unwrap();
        let context = engine as *const Engine as *mut c_void;
        // SAFETY: `config` outlives the call and `context` is static.
        let status = unsafe { posto_init(config.as_ptr(), Some(on_event), context) };
        assert_eq!(status, 0);
    });
    engine
}

type Responses = Mutex<Sender<(u64, String)>>;

extern "C" fn on_response(context: *mut c_void, request_id: u64, response: *const c_char) {
    // SAFETY: `context` is the `Responses` owned by `invoke`, which outlives
    // the callback; `response` is valid for the duration of the callback.
    let responses = unsafe { &*(context as *const Responses) };
    let response = unsafe { CStr::from_ptr(response) }
        .to_string_lossy()
        .into_owned();
    if let Ok(sender) = responses.lock() {
        let _ = sender.send((request_id, response));
    }
}

type Pending = (u64, Box<Responses>, Receiver<(u64, String)>);

/// Starts a command and returns where its response will arrive.
fn start(command: &str, args: &Value) -> Pending {
    start_raw(command, Some(&args.to_string()))
}

fn start_raw(command: &str, args_json: Option<&str>) -> Pending {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    engine();
    let request_id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = mpsc::channel();
    let responses = Box::new(Mutex::new(sender));
    let command = CString::new(command).unwrap();
    let args_json = args_json.map(|args| CString::new(args).unwrap());
    let context = &*responses as *const Responses as *mut c_void;
    // SAFETY: both strings outlive the call; `responses` stays alive until
    // the caller has received the response.
    unsafe {
        posto_invoke(
            request_id,
            command.as_ptr(),
            args_json
                .as_ref()
                .map_or(std::ptr::null(), |args| args.as_ptr()),
            Some(on_response),
            context,
        )
    };
    (request_id, responses, receiver)
}

/// The response JSON for one command, checking that its callback fired
/// exactly once with the right request id.
fn invoke(command: &str, args: Value) -> Value {
    let (request_id, responses, receiver) = start(command, &args);
    let (responded_id, response) = receiver
        .recv_timeout(TIMEOUT)
        .unwrap_or_else(|_| panic!("{command} never responded"));
    assert_eq!(responded_id, request_id);
    assert!(
        receiver.recv_timeout(Duration::from_millis(20)).is_err(),
        "{command} responded twice"
    );
    drop(responses);
    serde_json::from_str(&response).unwrap()
}

fn ok(command: &str, args: Value) -> Value {
    let response = invoke(command, args);
    match response.get("ok") {
        Some(value) => value.clone(),
        None => panic!("{command} failed: {response}"),
    }
}

fn error(command: &str, args: Value) -> String {
    let response = invoke(command, args);
    response["error"]
        .as_str()
        .unwrap_or_else(|| panic!("{command} succeeded: {response}"))
        .to_string()
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[test]
fn path_exists_reports_kinds() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("post.md");
    std::fs::write(&file, "hello").unwrap();

    assert_eq!(
        ok("path_exists", json!({ "path": dir.path() })),
        json!(true)
    );
    assert_eq!(
        ok("path_exists", json!({ "path": file, "kind": "file" })),
        json!(true)
    );
    assert_eq!(
        ok("path_exists", json!({ "path": file, "kind": "directory" })),
        json!(false)
    );
    assert_eq!(
        ok("path_exists", json!({ "path": dir.path().join("missing") })),
        json!(false)
    );
    assert_eq!(
        error("path_exists", json!({ "path": file, "kind": "socket" })),
        "Unknown path kind: socket"
    );
}

#[test]
fn text_files_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("content/posts/hello.md");
    let content = "---\ntitle: Hello\n---\n\nUnicode survives: ✓ \"quotes\" \\ and\nnewlines\n";

    assert_eq!(
        ok(
            "write_text_file",
            json!({ "path": path, "content": content })
        ),
        Value::Null
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
    assert_eq!(
        ok("read_text_file", json!({ "path": path })),
        json!(content)
    );
    assert_eq!(
        ok(
            "read_text_file_optional",
            json!({ "path": dir.path().join("missing.md") })
        ),
        Value::Null
    );
    assert!(error(
        "read_text_file",
        json!({ "path": dir.path().join("missing.md") })
    )
    .starts_with("Failed to read"));
}

#[test]
fn list_files_groups_a_markdown_tree() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("blog")).unwrap();
    std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
    std::fs::create_dir_all(root.join(".drafts")).unwrap();
    std::fs::write(root.join("index.md"), "---\ntitle: Home Page\n---\n").unwrap();
    std::fs::write(root.join("about.md"), "About").unwrap();
    std::fs::write(root.join("blog/first-post.md"), "---\ntitle: First\n---\n").unwrap();
    std::fs::write(root.join("node_modules/pkg/readme.md"), "skipped").unwrap();
    std::fs::write(root.join(".drafts/secret.md"), "skipped").unwrap();
    std::fs::write(root.join("site.css"), "body {}").unwrap();

    let groups = ok("list_files", json!({ "root": root }));
    let summary: Vec<(String, Option<String>, Vec<String>)> = groups
        .as_array()
        .unwrap()
        .iter()
        .map(|group| {
            (
                group["label"].as_str().unwrap().to_string(),
                group["kind"].as_str().map(str::to_string),
                group["files"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|file| file["name"].as_str().unwrap().to_string())
                    .collect(),
            )
        })
        .collect();
    assert_eq!(
        summary,
        [
            (
                String::new(),
                None,
                vec!["about.md".to_string(), "index.md".to_string()]
            ),
            ("blog".to_string(), None, vec!["first-post.md".to_string()]),
            (
                "Styles".to_string(),
                Some("styles".to_string()),
                vec!["site.css".to_string()]
            ),
        ]
    );
    let index = &groups[0]["files"][1];
    assert_eq!(index["title"], "Home Page");
    assert_eq!(index["frontmatter"], json!({ "title": "Home Page" }));
    assert_eq!(index["path"], json!(path_string(&root.join("index.md"))));

    assert_eq!(
        error("list_files", json!({ "root": root.join("about.md") })),
        format!("Not a directory: {}", path_string(&root.join("about.md")))
    );
}

#[test]
fn scan_projects_finds_markers() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("apps/site/.posto")).unwrap();
    std::fs::write(root.join("pnpm-workspace.yaml"), "packages: [apps/*]").unwrap();
    std::fs::write(root.join("apps/site/astro.config.mjs"), "").unwrap();
    std::fs::write(root.join("apps/site/.posto/index.json"), r#"{"version":1}"#).unwrap();

    assert_eq!(
        ok("scan_projects", json!({ "root": root })),
        json!([
            {
                "dir": root,
                "markers": ["pnpm-workspace.yaml"],
                "postoIndex": null,
            },
            {
                "dir": root.join("apps/site"),
                "markers": [".posto", ".posto/index.json", "astro.config.mjs"],
                "postoIndex": r#"{"version":1}"#,
            },
        ])
    );
}

fn init_repo(root: &Path) -> git2::Repository {
    let repo = git2::Repository::init(root).unwrap();
    std::fs::write(root.join("README.md"), "hello\n").unwrap();
    std::fs::write(root.join("removed.md"), "bye\n").unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new("README.md")).unwrap();
    index.add_path(Path::new("removed.md")).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let signature = git2::Signature::now("Test", "test@example.com").unwrap();
    repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
        .unwrap();
    drop(tree);
    repo
}

#[test]
fn changed_files_reports_porcelain_statuses() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    init_repo(root);
    std::fs::write(root.join("README.md"), "hello again\n").unwrap();
    std::fs::remove_file(root.join("removed.md")).unwrap();
    std::fs::write(root.join("new.md"), "new\n").unwrap();

    let mut changed: Vec<(String, String)> = ok("changed_files", json!({ "root": root }))
        .as_array()
        .unwrap()
        .iter()
        .map(|file| {
            (
                file["status"].as_str().unwrap().to_string(),
                file["path"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    changed.sort();
    assert_eq!(
        changed,
        [
            ("??".to_string(), "new.md".to_string()),
            ("D".to_string(), "removed.md".to_string()),
            ("M".to_string(), "README.md".to_string()),
        ]
    );
}

#[test]
fn checkout_emits_fs_changed() {
    let dir = tempfile::tempdir().unwrap();
    let root = path_string(dir.path());
    init_repo(dir.path());

    let outcome = ok(
        "checkout_branch",
        json!({ "root": root, "name": "drafts", "create": true, "force": false }),
    );
    assert_eq!(outcome, json!({ "switched": true, "conflicts": [] }));
    assert_eq!(
        ok("current_branch", json!({ "root": root })),
        json!("drafts")
    );
    // Emitted before the command resolved, on the engine's thread.
    assert!(engine().events_named("fs-changed").contains(&json!([root])));
}

#[test]
fn developer_mode_round_trips_through_the_config_dir() {
    let settings = engine().config_dir().join("settings.json");
    assert_eq!(ok("get_developer_mode", json!({})), json!(false));

    assert_eq!(
        ok("set_developer_mode", json!({ "enabled": true })),
        Value::Null
    );
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
    assert_eq!(saved["developer_mode"], json!(true));
    assert_eq!(ok("get_developer_mode", json!({})), json!(true));

    ok("set_developer_mode", json!({ "enabled": false }));
    assert_eq!(ok("get_developer_mode", json!({})), json!(false));
}

#[test]
fn write_temp_image_uses_the_cache_dir() {
    let path = ok(
        "write_temp_image",
        json!({ "bytes": [137, 80, 78, 71], "extension": "png" }),
    );
    let path = PathBuf::from(path.as_str().unwrap());
    assert!(path.starts_with(engine().cache_dir().join("image-imports")));
    assert_eq!(std::fs::read(&path).unwrap(), [137, 80, 78, 71]);
    assert_eq!(
        ok("read_image_bytes", json!({ "path": path })),
        json!([137, 80, 78, 71])
    );
}

#[test]
fn unknown_commands_fail() {
    assert_eq!(
        invoke(
            "open_in_app_browser",
            json!({ "url": "https://example.com" })
        ),
        json!({ "error": "unknown command: open_in_app_browser" })
    );
    assert_eq!(
        invoke("nope", json!({})),
        json!({ "error": "unknown command: nope" })
    );
}

#[test]
fn missing_and_invalid_arguments_fail_like_tauri() {
    assert_eq!(
        error("read_text_file", json!({})),
        "invalid args `path` for command `read_text_file`: command read_text_file missing required key path"
    );
    // Keys are camelCase, as Tauri reads them.
    assert_eq!(
        error(
            "image_thumbnail",
            json!({ "path": "/missing.png", "max_width": 10, "maxHeight": 10 })
        ),
        "invalid args `maxWidth` for command `image_thumbnail`: command image_thumbnail missing required key maxWidth"
    );
    assert!(error("path_exists", json!({ "path": 7 }))
        .starts_with("invalid args `path` for command `path_exists`: invalid type"));
    // A missing optional argument is `None`.
    assert_eq!(
        ok(
            "path_exists",
            json!({ "path": engine().config_dir().parent().unwrap() })
        ),
        json!(true)
    );
}

#[test]
fn raw_args_json_is_parsed_or_rejected() {
    let respond = |args_json: Option<&str>| {
        let (request_id, responses, receiver) = start_raw("get_recent_roots", args_json);
        let (responded_id, response) = receiver.recv_timeout(TIMEOUT).unwrap();
        assert_eq!(responded_id, request_id);
        drop(responses);
        serde_json::from_str::<Value>(&response).unwrap()
    };
    // NULL args mean `{}`.
    assert!(respond(None)["ok"].is_array());
    assert!(respond(Some("{not json"))["error"]
        .as_str()
        .unwrap()
        .starts_with("invalid args JSON:"));
}

#[test]
fn concurrent_invokes_each_respond_once() {
    let dir = tempfile::tempdir().unwrap();
    let pending: Vec<_> = (0..32)
        .map(|index| {
            let path = dir.path().join(format!("{index}.md"));
            start(
                "write_text_file",
                &json!({ "path": path, "content": index.to_string() }),
            )
        })
        .collect();
    for (request_id, responses, receiver) in pending {
        let (responded_id, response) = receiver.recv_timeout(TIMEOUT).unwrap();
        assert_eq!(responded_id, request_id);
        assert_eq!(response, r#"{"ok":null}"#);
        drop(responses);
    }
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 32);
}

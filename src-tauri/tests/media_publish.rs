//! Proves the media publish transaction against real git repositories and a fake
//! storage server, including failures and crashes at every step.

use axum::body::{to_bytes, Body};
use axum::extract::{Request, State};
use axum::http::Method;
use axum::response::Response;
use axum::Router;
use posto_lib::git::Client;
use posto_lib::media::bunny::BunnyClient;
use posto_lib::media::deletes::{self, DeleteIntent};
use posto_lib::media::provider::{MediaSource, Provider, ProviderKind};
use posto_lib::media::publish::{
    execute, recover, Hooks, PlannedDelete, PlannedUpload, PlannedWrite, PublishProgress,
    PublishRequest, PublishSource, RecoveryOutcome,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const HARBOR: &[u8] = b"harbor image bytes";
const FRESH: &[u8] = b"fresh image bytes";
const HARBOR_METADATA: &str = "src: ./harbor.jpg\nalt: Boats\n";
const FRESH_METADATA: &str = "src: ./fresh.jpg\nalt: New\n";
const HARBOR_URL: &str = "https://media.example.com/images/harbor-1a2b3c4d.jpg";
const FRESH_URL: &str = "https://media.example.com/images/fresh-5e6f7a8b.jpg";

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Default)]
struct Storage {
    objects: Mutex<BTreeMap<String, Vec<u8>>>,
    puts: AtomicUsize,
    lists: AtomicUsize,
    reject_uploads: AtomicBool,
    fail_deletes: AtomicBool,
}

async fn storage_handler(State(storage): State<Arc<Storage>>, request: Request) -> Response {
    let respond = |status: u16, body: String| {
        Response::builder()
            .status(status)
            .body(Body::from(body))
            .unwrap()
    };
    let key = request
        .uri()
        .path()
        .trim_start_matches("/zone/")
        .to_string();
    let method = request.method().clone();
    let bytes = to_bytes(request.into_body(), usize::MAX).await.unwrap();
    if method == Method::DELETE {
        if storage.fail_deletes.load(Ordering::SeqCst) {
            return respond(500, "{}".to_string());
        }
        let removed = storage.objects.lock().unwrap().remove(&key).is_some();
        return respond(if removed { 200 } else { 404 }, "{}".to_string());
    }
    if method == Method::PUT {
        storage.puts.fetch_add(1, Ordering::SeqCst);
        if storage.reject_uploads.load(Ordering::SeqCst) {
            return respond(401, r#"{"Message":"Unauthorized"}"#.to_string());
        }
        storage.objects.lock().unwrap().insert(key, bytes.to_vec());
        return respond(201, "{}".to_string());
    }
    storage.lists.fetch_add(1, Ordering::SeqCst);
    let entries: Vec<_> = storage
        .objects
        .lock()
        .unwrap()
        .iter()
        .filter_map(|(name, stored)| {
            let child = name.strip_prefix(&key)?;
            (!child.contains('/')).then(|| {
                serde_json::json!({
                    "ObjectName": child,
                    "Length": stored.len(),
                    "Checksum": hex(stored).to_uppercase(),
                    "IsDirectory": false,
                })
            })
        })
        .collect();
    respond(200, serde_json::to_string(&entries).unwrap())
}

struct Fixture {
    _dir: tempfile::TempDir,
    local: PathBuf,
    other: PathBuf,
    origin: PathBuf,
    storage: Arc<Storage>,
    storage_url: String,
}

fn commit_all(path: &Path, message: &str) {
    let repo = git2::Repository::open(path).unwrap();
    let mut index = repo.index().unwrap();
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let signature = git2::Signature::now("Test", "test@example.com").unwrap();
    let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
    let parents: Vec<_> = parent.iter().collect();
    repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        message,
        &tree,
        &parents,
    )
    .unwrap();
}

fn push(path: &Path) {
    let repo = git2::Repository::open(path).unwrap();
    repo.find_remote("origin")
        .unwrap()
        .push(&["refs/heads/main:refs/heads/main"], None)
        .unwrap();
}

fn write(root: &Path, relative: &str, bytes: &[u8]) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}

fn clone(origin: &Path, destination: &Path) {
    let repo = git2::Repository::clone(origin.to_str().unwrap(), destination).unwrap();
    let mut config = repo.config().unwrap();
    config.set_str("user.name", "Test").unwrap();
    config.set_str("user.email", "test@example.com").unwrap();
}

async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let origin = root.join("origin.git");
    let mut options = git2::RepositoryInitOptions::new();
    options.bare(true).initial_head("main");
    git2::Repository::init_opts(&origin, &options).unwrap();

    let seed = root.join("seed");
    let mut options = git2::RepositoryInitOptions::new();
    options.initial_head("main");
    let repo = git2::Repository::init_opts(&seed, &options).unwrap();
    repo.remote("origin", origin.to_str().unwrap()).unwrap();
    write(&seed, "index.md", b"# home\n");
    write(&seed, ".gitignore", b"*.ignored.jpg\n");
    write(&seed, "src/data/photos/harbor.jpg", HARBOR);
    write(
        &seed,
        "src/data/photos/harbor.yaml",
        HARBOR_METADATA.as_bytes(),
    );
    commit_all(&seed, "initial");
    push(&seed);

    let local = root.join("local");
    let other = root.join("other");
    clone(&origin, &local);
    clone(&origin, &other);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = local.join("src/data/photos/harbor.yaml");
        std::fs::set_permissions(metadata, std::fs::Permissions::from_mode(0o640)).unwrap();
    }
    // Unpublished work: an edit, plus an image that git hasn't seen yet.
    write(&local, "index.md", b"# home, edited\n");
    write(&local, "src/data/photos/fresh.jpg", FRESH);
    write(
        &local,
        "src/data/photos/fresh.yaml",
        FRESH_METADATA.as_bytes(),
    );

    let storage = Arc::new(Storage::default());
    let app = Router::new()
        .fallback(storage_handler)
        .with_state(storage.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let storage_url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Fixture {
        _dir: dir,
        local,
        other,
        origin,
        storage,
        storage_url,
    }
}

impl Fixture {
    fn path(&self, relative: &str) -> String {
        self.local.join(relative).to_string_lossy().to_string()
    }

    fn upload(&self, relative: &str, key: &str, bytes: &[u8]) -> PlannedUpload {
        PlannedUpload {
            source_name: "cdn".to_string(),
            path: self.path(relative),
            key: key.to_string(),
            sha256: hex(bytes),
            size: bytes.len() as u64,
            content_type: "image/jpeg".to_string(),
        }
    }

    fn request(&self) -> PublishRequest {
        let rewrite = |relative: &str, previous: &str, url: &str| PlannedWrite {
            path: self.path(relative),
            previous: previous.to_string(),
            content: format!("src: \"{url}\"\nalt: Published\n"),
        };
        PublishRequest {
            root: self.local.to_string_lossy().to_string(),
            message: "publish media".to_string(),
            sources: vec![PublishSource {
                name: "cdn".to_string(),
                prefix: Some("images".to_string()),
                connection: MediaSource {
                    provider: ProviderKind::Bunny,
                    bucket: "zone".to_string(),
                    region: None,
                    endpoint: None,
                    path_style: None,
                },
            }],
            uploads: vec![
                self.upload(
                    "src/data/photos/harbor.jpg",
                    "images/harbor-1a2b3c4d.jpg",
                    HARBOR,
                ),
                self.upload(
                    "src/data/photos/fresh.jpg",
                    "images/fresh-5e6f7a8b.jpg",
                    FRESH,
                ),
            ],
            writes: vec![
                rewrite("src/data/photos/harbor.yaml", HARBOR_METADATA, HARBOR_URL),
                rewrite("src/data/photos/fresh.yaml", FRESH_METADATA, FRESH_URL),
            ],
            removals: vec![
                self.path("src/data/photos/harbor.jpg"),
                self.path("src/data/photos/fresh.jpg"),
            ],
            deletes: Vec::new(),
        }
    }

    async fn run(
        &self,
        request: PublishRequest,
        hooks: Hooks,
    ) -> Result<Vec<PublishProgress>, String> {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let progress = Arc::new(move |event| sink.lock().unwrap().push(event));
        let client = BunnyClient::new(&self.storage_url, "zone", "password").unwrap();
        let providers = HashMap::from([("cdn".to_string(), Provider::Bunny(client))]);
        execute(request, providers, progress, hooks).await?;
        let events = events.lock().unwrap().clone();
        Ok(events)
    }

    fn set_origin(&self, url: &Path) {
        git2::Repository::open(&self.local)
            .unwrap()
            .remote_set_url("origin", url.to_str().unwrap())
            .unwrap();
    }

    fn origin_head(&self) -> git2::Oid {
        git2::Repository::open(&self.origin)
            .unwrap()
            .find_reference("refs/heads/main")
            .unwrap()
            .target()
            .unwrap()
    }

    fn origin_file(&self, relative: &str) -> Option<Vec<u8>> {
        let repo = git2::Repository::open(&self.origin).unwrap();
        let tree = repo
            .find_reference("refs/heads/main")
            .unwrap()
            .peel_to_tree()
            .unwrap();
        let entry = tree.get_path(Path::new(relative)).ok()?;
        let blob = repo.find_blob(entry.id()).unwrap();
        let content = blob.content().to_vec();
        Some(content)
    }

    fn journal_exists(&self) -> bool {
        self.local
            .join(".git/posto/media-publish/journal.json")
            .exists()
    }
}

/// Every observable part of the project: files, git status, and HEAD.
#[derive(Debug, PartialEq, Eq)]
struct ProjectState {
    files: BTreeMap<String, (Vec<u8>, u32)>,
    status: Vec<(String, String)>,
    head: git2::Oid,
}

#[cfg(unix)]
fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode()
}

#[cfg(not(unix))]
fn mode(_path: &Path) -> u32 {
    0
}

fn collect_files(root: &Path, directory: &Path, files: &mut BTreeMap<String, (Vec<u8>, u32)>) {
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.file_name().is_some_and(|name| name == ".git") {
            continue;
        }
        if path.is_dir() {
            collect_files(root, &path, files);
        } else {
            let relative = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .to_string();
            let permissions = mode(&path);
            files.insert(relative, (std::fs::read(path).unwrap(), permissions));
        }
    }
}

fn state(local: &Path) -> ProjectState {
    let mut files = BTreeMap::new();
    collect_files(local, local, &mut files);
    let client = Client::open(local.to_str().unwrap()).unwrap();
    let mut status: Vec<_> = client
        .changed_files()
        .unwrap()
        .into_iter()
        .map(|file| (file.status, file.path))
        .collect();
    status.sort();
    ProjectState {
        files,
        status,
        head: git2::Repository::open(local)
            .unwrap()
            .head()
            .unwrap()
            .target()
            .unwrap(),
    }
}

#[tokio::test]
async fn publishes_images_and_content_together() {
    let f = fixture().await;

    let events = f.run(f.request(), Hooks::default()).await.unwrap();

    let objects = f.storage.objects.lock().unwrap().clone();
    assert_eq!(objects["images/harbor-1a2b3c4d.jpg"], HARBOR);
    assert_eq!(objects["images/fresh-5e6f7a8b.jpg"], FRESH);
    let metadata = f.origin_file("src/data/photos/harbor.yaml").unwrap();
    assert!(String::from_utf8(metadata).unwrap().contains(HARBOR_URL));
    assert_eq!(
        f.origin_file("src/data/photos/harbor.jpg"),
        None,
        "image left git"
    );
    assert_eq!(
        f.origin_file("src/data/photos/fresh.jpg"),
        None,
        "new image never committed"
    );
    assert_eq!(f.origin_file("index.md").unwrap(), b"# home, edited\n");
    assert!(!f.local.join("src/data/photos/harbor.jpg").exists());
    #[cfg(unix)]
    assert_eq!(
        mode(&f.local.join("src/data/photos/harbor.yaml")) & 0o777,
        0o640,
        "rewritten files keep their permissions"
    );
    assert!(state(&f.local).status.is_empty(), "nothing left to publish");
    assert!(!f.journal_exists());
    assert_eq!(
        events[events.len() - 4..],
        [
            PublishProgress::Applying,
            PublishProgress::Committing,
            PublishProgress::Pushing,
            PublishProgress::Finishing,
        ]
    );
    assert!(events.contains(&PublishProgress::Uploading {
        completed: 2,
        total: 2
    }));
    assert_eq!(
        f.storage.lists.load(Ordering::SeqCst),
        1,
        "the folder is listed once, not once per image"
    );
}

#[tokio::test]
async fn failed_upload_changes_nothing() {
    let f = fixture().await;
    f.storage.reject_uploads.store(true, Ordering::SeqCst);
    let before = state(&f.local);
    let origin = f.origin_head();

    let error = f.run(f.request(), Hooks::default()).await.unwrap_err();

    assert!(error.contains("rejected the saved credentials"), "{error}");
    assert_eq!(state(&f.local), before);
    assert_eq!(f.origin_head(), origin);
    assert!(!f.journal_exists());
}

#[tokio::test]
async fn newer_server_changes_stop_before_any_upload() {
    let f = fixture().await;
    write(&f.other, "index.md", b"# from the server\n");
    commit_all(&f.other, "server edit");
    push(&f.other);
    let before = state(&f.local);

    let error = f.run(f.request(), Hooks::default()).await.unwrap_err();

    assert!(error.contains("newer changes"), "{error}");
    assert_eq!(f.storage.puts.load(Ordering::SeqCst), 0);
    assert_eq!(state(&f.local), before);
}

#[tokio::test]
async fn failed_push_restores_everything_and_retry_reuses_uploads() {
    let f = fixture().await;
    let before = state(&f.local);
    let origin = f.origin_head();
    f.set_origin(&f.local.parent().unwrap().join("missing.git"));

    assert!(f.run(f.request(), Hooks::default()).await.is_err());

    assert_eq!(state(&f.local), before, "the project is exactly as it was");
    assert_eq!(f.origin_head(), origin);
    assert_eq!(
        f.storage.puts.load(Ordering::SeqCst),
        2,
        "uploads stay on the CDN"
    );
    assert!(!f.journal_exists());

    f.set_origin(&f.origin);
    f.run(f.request(), Hooks::default()).await.unwrap();

    assert_eq!(
        f.storage.puts.load(Ordering::SeqCst),
        2,
        "retry skips finished uploads"
    );
    assert!(f.origin_file("src/data/photos/harbor.jpg").is_none());
}

#[tokio::test]
async fn edits_made_after_planning_are_never_overwritten() {
    let f = fixture().await;
    write(
        &f.local,
        "src/data/photos/harbor.yaml",
        b"src: ./harbor.jpg\nalt: Edited\n",
    );
    let before = state(&f.local);

    let error = f.run(f.request(), Hooks::default()).await.unwrap_err();

    assert!(error.contains("changed while publishing"), "{error}");
    assert_eq!(state(&f.local), before);
    assert!(!f.journal_exists());
}

#[tokio::test]
async fn replaced_images_are_never_removed() {
    let f = fixture().await;
    write(&f.local, "src/data/photos/harbor.jpg", b"a different photo");
    let before = state(&f.local);
    let mut request = f.request();
    // The fake storage accepts any bytes, so only the local hash check stops this.
    request.uploads[0].size = 17;

    let result = f.run(request, Hooks::default()).await;

    assert!(result.is_err());
    assert_eq!(state(&f.local), before);
}

#[tokio::test]
async fn gitignored_images_stay_on_disk() {
    let f = fixture().await;
    let ignored = "src/data/photos/draft.ignored.jpg";
    write(&f.local, ignored, FRESH);
    let mut request = f.request();
    request
        .uploads
        .push(f.upload(ignored, "images/draft-5e6f7a8b.jpg", FRESH));
    request.removals.push(f.path(ignored));

    f.run(request, Hooks::default()).await.unwrap();

    assert_eq!(std::fs::read(f.local.join(ignored)).unwrap(), FRESH);
    assert!(f
        .storage
        .objects
        .lock()
        .unwrap()
        .contains_key("images/draft-5e6f7a8b.jpg"));
}

#[tokio::test]
async fn unsafe_requests_are_refused_before_any_work() {
    let f = fixture().await;
    let outside = f.local.parent().unwrap().join("outside.txt");
    std::fs::write(&outside, "keep me").unwrap();
    type Change = Box<dyn Fn(&mut PublishRequest)>;
    let cases: Vec<(&str, Change)> = vec![
        (
            "outside this project",
            Box::new({
                let outside = outside.clone();
                move |request| request.writes[0].path = outside.to_string_lossy().to_string()
            }),
        ),
        (
            "outside this project",
            Box::new({
                let outside = outside.clone();
                move |request| request.removals[0] = outside.to_string_lossy().to_string()
            }),
        ),
        (
            "can't be removed",
            Box::new(|request| request.uploads.remove(0).path.clear()),
        ),
        (
            "outside its CDN folder",
            Box::new(|request| {
                request.uploads[0].key = "private/harbor.jpg".to_string();
            }),
        ),
        (
            "Invalid storage object path",
            Box::new(|request| {
                request.uploads[0].key = "images/".to_string();
            }),
        ),
        (
            "Unknown CDN source",
            Box::new(|request| {
                request.uploads[0].source_name = "other".to_string();
            }),
        ),
    ];
    let before = state(&f.local);
    for (expected, change) in cases {
        let mut request = f.request();
        change(&mut request);
        let error = f.run(request, Hooks::default()).await.unwrap_err();
        assert!(
            error.contains(expected),
            "expected {expected:?}, got {error:?}"
        );
    }
    assert_eq!(state(&f.local), before);
    assert_eq!(f.storage.puts.load(Ordering::SeqCst), 0);
    assert_eq!(std::fs::read_to_string(outside).unwrap(), "keep me");
}

const POINTS_BEFORE_PUSH: [&str; 5] = [
    "before-apply",
    "mid-apply",
    "after-apply",
    "after-commit",
    "before-push",
];

#[tokio::test]
async fn failures_at_every_step_restore_identical_bytes() {
    for point in POINTS_BEFORE_PUSH {
        let f = fixture().await;
        let before = state(&f.local);
        let origin = f.origin_head();
        let hooks = Hooks {
            fail_at: Some(point),
            crash_at: None,
        };

        let error = f.run(f.request(), hooks).await.unwrap_err();

        assert!(error.contains("simulated"), "{point}: {error}");
        assert_eq!(state(&f.local), before, "{point}");
        assert_eq!(f.origin_head(), origin, "{point}");
        assert!(!f.journal_exists(), "{point}");
    }
}

#[tokio::test]
async fn crashes_at_every_step_recover_identical_bytes() {
    for point in POINTS_BEFORE_PUSH {
        let f = fixture().await;
        let before = state(&f.local);
        let hooks = Hooks {
            fail_at: None,
            crash_at: Some(point),
        };

        f.run(f.request(), hooks).await.unwrap_err();

        assert!(f.journal_exists(), "{point}: the crash leaves a journal");
        let mut client = Client::open(f.local.to_str().unwrap()).unwrap();
        for error in [
            client.publish("blocked").unwrap_err(),
            client.pull().unwrap_err(),
        ] {
            assert!(error.contains("didn't finish"), "{point}: {error}");
        }

        let root = f.local.to_str().unwrap();
        assert_eq!(
            recover(root).unwrap(),
            RecoveryOutcome::RolledBack,
            "{point}"
        );
        assert_eq!(state(&f.local), before, "{point}");
        assert_eq!(recover(root).unwrap(), RecoveryOutcome::Clean, "{point}");

        f.run(f.request(), Hooks::default()).await.expect(point);
        assert!(
            f.origin_file("src/data/photos/harbor.jpg").is_none(),
            "{point}"
        );
    }
}

#[tokio::test]
async fn crashes_after_the_push_finish_the_publish() {
    for point in ["after-push", "before-finalize"] {
        let f = fixture().await;
        let hooks = Hooks {
            fail_at: None,
            crash_at: Some(point),
        };

        f.run(f.request(), hooks).await.unwrap_err();
        let pushed = f.origin_head();

        let root = f.local.to_str().unwrap();
        assert_eq!(
            recover(root).unwrap(),
            RecoveryOutcome::Finalized,
            "{point}"
        );
        assert_eq!(f.origin_head(), pushed, "{point}");
        assert!(state(&f.local).status.is_empty(), "{point}");
        assert!(
            !f.local.join("src/data/photos/harbor.jpg").exists(),
            "{point}"
        );
        assert!(!f.journal_exists(), "{point}");
    }
}

#[tokio::test]
async fn an_unreachable_server_keeps_the_interrupted_publish_blocked() {
    let f = fixture().await;
    let before = state(&f.local);
    let hooks = Hooks {
        fail_at: None,
        crash_at: Some("before-push"),
    };
    f.run(f.request(), hooks).await.unwrap_err();
    f.set_origin(&f.local.parent().unwrap().join("missing.git"));

    let root = f.local.to_str().unwrap();
    assert!(matches!(
        recover(root).unwrap(),
        RecoveryOutcome::Blocked { .. }
    ));
    assert!(
        f.journal_exists(),
        "nothing is guessed while the outcome is unknown"
    );

    f.set_origin(&f.origin);
    assert_eq!(recover(root).unwrap(), RecoveryOutcome::RolledBack);
    assert_eq!(state(&f.local), before);
}

const LIVE_KEY: &str = "images/live-9a8b7c6d.jpg";
const LIVE_URL: &str = "https://media.example.com/images/live-9a8b7c6d.jpg";

/// A library entry already published to the CDN, then deleted from the library.
async fn deleted_entry() -> Fixture {
    let f = fixture().await;
    write(
        &f.local,
        "src/data/photos/live.yaml",
        format!("src: {LIVE_URL}\n").as_bytes(),
    );
    commit_all(&f.local, "publish live entry");
    push(&f.local);
    f.storage
        .objects
        .lock()
        .unwrap()
        .insert(LIVE_KEY.to_string(), b"live".to_vec());
    std::fs::remove_file(f.local.join("src/data/photos/live.yaml")).unwrap();
    let client = Client::open(f.local.to_str().unwrap()).unwrap();
    deletes::record(
        &client,
        DeleteIntent {
            source_name: "cdn".to_string(),
            key: LIVE_KEY.to_string(),
            url: LIVE_URL.to_string(),
            metadata_path: Some(f.path("src/data/photos/live.yaml")),
        },
    )
    .unwrap();
    f
}

fn with_delete(mut request: PublishRequest) -> PublishRequest {
    request.deletes.push(PlannedDelete {
        source_name: "cdn".to_string(),
        key: LIVE_KEY.to_string(),
    });
    request
}

fn pending(f: &Fixture) -> Vec<DeleteIntent> {
    deletes::pending(&Client::open(f.local.to_str().unwrap()).unwrap()).unwrap()
}

#[tokio::test]
async fn deleted_library_entries_remove_their_cdn_object_after_publishing() {
    let f = deleted_entry().await;
    assert_eq!(pending(&f).len(), 1);

    f.run(with_delete(f.request()), Hooks::default())
        .await
        .unwrap();

    assert!(!f.storage.objects.lock().unwrap().contains_key(LIVE_KEY));
    assert_eq!(f.origin_file("src/data/photos/live.yaml"), None);
    assert!(pending(&f).is_empty());
}

#[tokio::test]
async fn restoring_the_entry_cancels_its_delete() {
    let f = deleted_entry().await;
    Client::open(f.local.to_str().unwrap())
        .unwrap()
        .revert_file("src/data/photos/live.yaml")
        .unwrap();

    assert!(
        pending(&f).is_empty(),
        "the restored entry cancels the delete"
    );
    f.run(with_delete(f.request()), Hooks::default())
        .await
        .unwrap();
    assert!(f.storage.objects.lock().unwrap().contains_key(LIVE_KEY));
}

#[tokio::test]
async fn unrecorded_deletes_are_ignored() {
    let f = fixture().await;
    f.storage
        .objects
        .lock()
        .unwrap()
        .insert(LIVE_KEY.to_string(), b"live".to_vec());

    f.run(with_delete(f.request()), Hooks::default())
        .await
        .unwrap();

    assert!(f.storage.objects.lock().unwrap().contains_key(LIVE_KEY));
}

#[tokio::test]
async fn a_failed_publish_never_deletes() {
    let f = deleted_entry().await;
    f.set_origin(&f.local.parent().unwrap().join("missing.git"));

    assert!(f
        .run(with_delete(f.request()), Hooks::default())
        .await
        .is_err());

    assert!(f.storage.objects.lock().unwrap().contains_key(LIVE_KEY));
    assert_eq!(
        pending(&f).len(),
        1,
        "the delete waits for a successful publish"
    );
}

#[tokio::test]
async fn failed_deletes_are_retried_on_the_next_publish() {
    let f = deleted_entry().await;
    f.storage.fail_deletes.store(true, Ordering::SeqCst);

    let summary = f.run(with_delete(f.request()), Hooks::default()).await;

    assert!(summary.is_ok(), "the content still published");
    assert!(f.storage.objects.lock().unwrap().contains_key(LIVE_KEY));
    assert_eq!(pending(&f).len(), 1);

    f.storage.fail_deletes.store(false, Ordering::SeqCst);
    let mut retry = with_delete(f.request());
    retry.uploads.clear();
    retry.writes.clear();
    retry.removals.clear();
    f.run(retry, Hooks::default()).await.unwrap();

    assert!(!f.storage.objects.lock().unwrap().contains_key(LIVE_KEY));
    assert!(pending(&f).is_empty());
}

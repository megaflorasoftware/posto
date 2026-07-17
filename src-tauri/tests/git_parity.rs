//! Parity tests pinning the git semantics the desktop app had with CLI git:
//! dirty-tree pulls, server-wins conflicts, untracked stash round-trips,
//! publish, revert, and behind-count detection — all against temp repos with
//! a local bare "origin".

use posto_lib::git::Client;
use std::path::{Path, PathBuf};

struct Fixture {
    #[allow(dead_code)]
    dir: tempfile::TempDir,
    /// The user's clone (what posto operates on).
    local: PathBuf,
    /// A second clone standing in for "someone else" / the server side.
    other: PathBuf,
    origin: PathBuf,
}

fn init_user(repo: &git2::Repository, name: &str) {
    let mut config = repo.config().unwrap();
    config.set_str("user.name", name).unwrap();
    config
        .set_str("user.email", &format!("{name}@example.com"))
        .unwrap();
}

fn commit_all(repo_path: &Path, message: &str) {
    let repo = git2::Repository::open(repo_path).unwrap();
    let mut index = repo.index().unwrap();
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .unwrap();
    index.update_all(["*"].iter(), None).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = repo.signature().unwrap();
    let parents: Vec<git2::Commit> = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .into_iter()
        .collect();
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parent_refs)
        .unwrap();
}

fn push(repo_path: &Path) {
    let repo = git2::Repository::open(repo_path).unwrap();
    let mut remote = repo.find_remote("origin").unwrap();
    remote
        .push(&["refs/heads/main:refs/heads/main"], None)
        .unwrap();
    // Keep the remote-tracking ref current, as a fetch would.
    repo.reference(
        "refs/remotes/origin/main",
        repo.head().unwrap().target().unwrap(),
        true,
        "test push",
    )
    .unwrap();
}

fn write(root: &Path, rel: &str, content: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

fn read(root: &Path, rel: &str) -> String {
    std::fs::read_to_string(root.join(rel)).unwrap()
}

fn clone(origin: &Path, dest: &Path, user: &str) -> git2::Repository {
    let repo = git2::build::RepoBuilder::new()
        .clone(origin.to_str().unwrap(), dest)
        .unwrap();
    init_user(&repo, user);
    repo
}

/// Bare origin holding one initial commit, plus two clones of it.
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let origin = dir.path().join("origin.git");
    let mut init_opts = git2::RepositoryInitOptions::new();
    init_opts.bare(true).initial_head("main");
    git2::Repository::init_opts(&origin, &init_opts).unwrap();

    // Seed the origin through a scratch clone so both real clones start with
    // history and an upstream.
    let seed = dir.path().join("seed");
    let mut seed_opts = git2::RepositoryInitOptions::new();
    seed_opts.initial_head("main");
    let seed_repo = git2::Repository::init_opts(&seed, &seed_opts).unwrap();
    init_user(&seed_repo, "seed");
    seed_repo
        .remote("origin", origin.to_str().unwrap())
        .unwrap();
    write(&seed, "index.md", "# home\n");
    write(&seed, "posts/first.md", "first\n");
    commit_all(&seed, "initial");
    push(&seed);

    let local = dir.path().join("local");
    let other = dir.path().join("other");
    clone(&origin, &local, "local");
    clone(&origin, &other, "other");
    Fixture { dir, local, other, origin }
}

/// Publishes a change from the "other" clone, so `local` is behind.
fn server_change(f: &Fixture, rel: &str, content: &str, message: &str) {
    write(&f.other, rel, content);
    commit_all(&f.other, message);
    push(&f.other);
}

#[test]
fn behind_detection_and_pull() {
    let f = fixture();
    let client = Client::open(f.local.to_str().unwrap()).unwrap();
    assert!(!client.fetch_and_check_behind().unwrap(), "fresh clone is current");

    server_change(&f, "posts/first.md", "first, updated\n", "server edit");
    assert!(client.fetch_and_check_behind().unwrap(), "server pushed — behind");

    let mut client = Client::open(f.local.to_str().unwrap()).unwrap();
    assert_eq!(client.pull().unwrap(), "Updated from server.");
    assert_eq!(read(&f.local, "posts/first.md"), "first, updated\n");
    assert!(!client.fetch_and_check_behind().unwrap(), "caught up after pull");
}

#[test]
fn dirty_tree_pull_keeps_non_conflicting_local_edits() {
    let f = fixture();
    // Local uncommitted edit in one file; server changes a different file.
    write(&f.local, "index.md", "# home, local draft\n");
    server_change(&f, "posts/first.md", "server version\n", "server edit");

    let mut client = Client::open(f.local.to_str().unwrap()).unwrap();
    assert_eq!(client.pull().unwrap(), "Updated from server.");
    assert_eq!(read(&f.local, "posts/first.md"), "server version\n", "server change applied");
    assert_eq!(read(&f.local, "index.md"), "# home, local draft\n", "local edit survives");
    // The local edit is back as an ordinary uncommitted change.
    let changed = client.changed_files().unwrap();
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].path, "index.md");
    assert_eq!(changed[0].status, "M");
    let repo = git2::Repository::open(&f.local).unwrap();
    assert_eq!(stash_count(repo), 0, "stash consumed");
}

#[test]
fn conflicting_uncommitted_edits_lose_to_server() {
    let f = fixture();
    // Local uncommitted edit and server commit touch the same file.
    write(&f.local, "posts/first.md", "local draft\n");
    server_change(&f, "posts/first.md", "server version\n", "server edit");

    let mut client = Client::open(f.local.to_str().unwrap()).unwrap();
    assert_eq!(client.pull().unwrap(), "Updated from server.");
    assert_eq!(read(&f.local, "posts/first.md"), "server version\n", "server wins");
    let repo = git2::Repository::open(&f.local).unwrap();
    assert_eq!(stash_count(repo), 0, "stash dropped, not left behind");
}

#[test]
fn conflicting_committed_edits_lose_to_server() {
    let f = fixture();
    // Local *committed* (unpushed) change vs a conflicting server commit:
    // merge resolves in the server's favor (-X theirs).
    write(&f.local, "posts/first.md", "local committed\n");
    commit_all(&f.local, "local edit");
    server_change(&f, "posts/first.md", "server version\n", "server edit");

    let mut client = Client::open(f.local.to_str().unwrap()).unwrap();
    assert_eq!(client.pull().unwrap(), "Updated from server.");
    assert_eq!(read(&f.local, "posts/first.md"), "server version\n", "server wins");
    assert!(!client.fetch_and_check_behind().unwrap());
}

#[test]
fn untracked_files_survive_the_stash_round_trip() {
    let f = fixture();
    write(&f.local, "posts/draft.md", "untracked draft\n");
    // The server changes a tracked file the local tree also edited, forcing
    // the stash path (a merely-untracked file wouldn't block the merge).
    write(&f.local, "index.md", "# home, local draft\n");
    server_change(&f, "index.md", "# home, server\n", "server edit");

    let mut client = Client::open(f.local.to_str().unwrap()).unwrap();
    assert_eq!(client.pull().unwrap(), "Updated from server.");
    assert_eq!(read(&f.local, "index.md"), "# home, server\n", "server wins the conflict");
    assert_eq!(read(&f.local, "posts/draft.md"), "untracked draft\n", "untracked file survives");
    let changed = client.changed_files().unwrap();
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].path, "posts/draft.md");
    assert_eq!(changed[0].status, "??");
}

#[test]
fn publish_with_nothing_to_commit() {
    let f = fixture();
    let client = Client::open(f.local.to_str().unwrap()).unwrap();
    assert_eq!(
        client.publish("anything").unwrap(),
        "Nothing to publish — no local changes."
    );
}

#[test]
fn publish_commits_and_pushes() {
    let f = fixture();
    write(&f.local, "posts/new.md", "brand new\n");
    write(&f.local, "index.md", "# home v2\n");
    std::fs::remove_file(f.local.join("posts/first.md")).unwrap();

    let client = Client::open(f.local.to_str().unwrap()).unwrap();
    assert_eq!(client.publish("publish from test").unwrap(), "Published.");

    // The origin's main must now hold the commit with all three changes.
    let origin = git2::Repository::open(&f.origin).unwrap();
    let head = origin
        .find_reference("refs/heads/main")
        .unwrap()
        .peel_to_commit()
        .unwrap();
    assert_eq!(head.message().unwrap(), "publish from test");
    let tree = head.tree().unwrap();
    assert!(tree.get_path(Path::new("posts/new.md")).is_ok(), "addition pushed");
    assert!(tree.get_path(Path::new("posts/first.md")).is_err(), "deletion pushed");
    // And the local tree is clean.
    assert!(client.changed_files().unwrap().is_empty());
    assert_eq!(
        client.publish("again").unwrap(),
        "Nothing to publish — no local changes."
    );
}

#[test]
fn revert_tracked_and_untracked() {
    let f = fixture();
    let client = Client::open(f.local.to_str().unwrap()).unwrap();

    // Tracked: modified content returns to the committed state.
    write(&f.local, "index.md", "# scribbles\n");
    assert_eq!(client.changed_files().unwrap()[0].status, "M");
    client.revert_file("index.md").unwrap();
    assert_eq!(read(&f.local, "index.md"), "# home\n");

    // Tracked: a deleted file comes back.
    std::fs::remove_file(f.local.join("posts/first.md")).unwrap();
    assert_eq!(client.changed_files().unwrap()[0].status, "D");
    client.revert_file("posts/first.md").unwrap();
    assert_eq!(read(&f.local, "posts/first.md"), "first\n");

    // Untracked: revert means delete.
    write(&f.local, "posts/draft.md", "temp\n");
    assert_eq!(client.changed_files().unwrap()[0].status, "??");
    client.revert_file("posts/draft.md").unwrap();
    assert!(!f.local.join("posts/draft.md").exists());
    assert!(client.changed_files().unwrap().is_empty());
}

#[test]
fn changed_files_reports_porcelain_codes() {
    let f = fixture();
    let client = Client::open(f.local.to_str().unwrap()).unwrap();
    write(&f.local, "index.md", "# edited\n");
    write(&f.local, "posts/new.md", "new\n");
    std::fs::remove_file(f.local.join("posts/first.md")).unwrap();
    let mut changed = client.changed_files().unwrap();
    changed.sort_by(|a, b| a.path.cmp(&b.path));
    let pairs: Vec<(&str, &str)> = changed
        .iter()
        .map(|c| (c.status.as_str(), c.path.as_str()))
        .collect();
    assert_eq!(
        pairs,
        vec![
            ("M", "index.md"),
            ("D", "posts/first.md"),
            ("??", "posts/new.md"),
        ]
    );
}

fn stash_count(mut repo: git2::Repository) -> usize {
    let mut count = 0;
    repo.stash_foreach(|_, _, _| {
        count += 1;
        true
    })
    .unwrap();
    count
}

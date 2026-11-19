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
    Fixture {
        dir,
        local,
        other,
        origin,
    }
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
    assert!(
        !client.fetch_and_check_behind().unwrap(),
        "fresh clone is current"
    );

    server_change(&f, "posts/first.md", "first, updated\n", "server edit");
    assert!(
        client.fetch_and_check_behind().unwrap(),
        "server pushed — behind"
    );

    let mut client = Client::open(f.local.to_str().unwrap()).unwrap();
    assert_eq!(client.pull().unwrap(), "Updated from server.");
    assert_eq!(read(&f.local, "posts/first.md"), "first, updated\n");
    assert!(
        !client.fetch_and_check_behind().unwrap(),
        "caught up after pull"
    );
}

#[test]
fn dirty_tree_pull_keeps_non_conflicting_local_edits() {
    let f = fixture();
    // Local uncommitted edit in one file; server changes a different file.
    write(&f.local, "index.md", "# home, local draft\n");
    server_change(&f, "posts/first.md", "server version\n", "server edit");

    let mut client = Client::open(f.local.to_str().unwrap()).unwrap();
    assert_eq!(client.pull().unwrap(), "Updated from server.");
    assert_eq!(
        read(&f.local, "posts/first.md"),
        "server version\n",
        "server change applied"
    );
    assert_eq!(
        read(&f.local, "index.md"),
        "# home, local draft\n",
        "local edit survives"
    );
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
    assert_eq!(
        read(&f.local, "posts/first.md"),
        "server version\n",
        "server wins"
    );
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
    assert_eq!(
        read(&f.local, "posts/first.md"),
        "server version\n",
        "server wins"
    );
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
    assert_eq!(
        read(&f.local, "index.md"),
        "# home, server\n",
        "server wins the conflict"
    );
    assert_eq!(
        read(&f.local, "posts/draft.md"),
        "untracked draft\n",
        "untracked file survives"
    );
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
    assert!(
        tree.get_path(Path::new("posts/new.md")).is_ok(),
        "addition pushed"
    );
    assert!(
        tree.get_path(Path::new("posts/first.md")).is_err(),
        "deletion pushed"
    );
    // And the local tree is clean.
    assert!(client.changed_files().unwrap().is_empty());
    assert_eq!(
        client.publish("again").unwrap(),
        "Nothing to publish — no local changes."
    );
}

fn head_oid(repo_path: &Path) -> git2::Oid {
    git2::Repository::open(repo_path)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap()
}

fn origin_main(f: &Fixture) -> git2::Oid {
    git2::Repository::open(&f.origin)
        .unwrap()
        .find_reference("refs/heads/main")
        .unwrap()
        .target()
        .unwrap()
}

fn status_pairs(client: &Client) -> Vec<(String, String)> {
    let mut pairs: Vec<(String, String)> = client
        .changed_files()
        .unwrap()
        .into_iter()
        .map(|file| (file.status, file.path))
        .collect();
    pairs.sort();
    pairs
}

#[test]
fn rejected_push_restores_changes_for_another_publish() {
    let f = fixture();
    write(&f.local, "index.md", "# home v2\n");
    write(&f.local, "posts/new.md", "brand new\n");
    server_change(&f, "posts/first.md", "server version\n", "server edit");
    let before = head_oid(&f.local);
    let server = origin_main(&f);

    let client = Client::open(f.local.to_str().unwrap()).unwrap();
    let expected = status_pairs(&client);
    assert!(client.publish("will be rejected").is_err());

    assert_eq!(head_oid(&f.local), before, "the failed commit is undone");
    assert_eq!(origin_main(&f), server, "origin is unchanged");
    assert_eq!(status_pairs(&client), expected, "changes look untouched");
    assert_eq!(read(&f.local, "posts/new.md"), "brand new\n");

    // New files are untracked again, so the publish modal can still revert them.
    write(&f.local, "posts/discard.md", "discard me\n");
    client.publish("rejected again").unwrap_err();
    client.revert_file("posts/discard.md").unwrap();
    assert!(!f.local.join("posts/discard.md").exists());

    let mut client = Client::open(f.local.to_str().unwrap()).unwrap();
    client.pull().unwrap();
    assert_eq!(client.publish("after pull").unwrap(), "Published.");
    assert_eq!(origin_main(&f), head_oid(&f.local));
}

#[test]
fn unreachable_remote_restores_changes_and_retry_succeeds() {
    let f = fixture();
    write(&f.local, "index.md", "# home v2\n");
    write(&f.local, "posts/new.md", "brand new\n");
    let before = head_oid(&f.local);
    let repo = git2::Repository::open(&f.local).unwrap();
    let missing = f.local.parent().unwrap().join("missing.git");
    repo.remote_set_url("origin", missing.to_str().unwrap())
        .unwrap();

    let client = Client::open(f.local.to_str().unwrap()).unwrap();
    let expected = status_pairs(&client);
    assert!(client.publish("offline").is_err());
    assert_eq!(head_oid(&f.local), before);
    assert_eq!(status_pairs(&client), expected);

    repo.remote_set_url("origin", f.origin.to_str().unwrap())
        .unwrap();
    let client = Client::open(f.local.to_str().unwrap()).unwrap();
    assert_eq!(client.publish("back online").unwrap(), "Published.");
    assert_eq!(origin_main(&f), head_oid(&f.local));
    assert!(client.changed_files().unwrap().is_empty());
}

#[test]
fn publish_pushes_a_commit_stranded_by_an_earlier_failure() {
    let f = fixture();
    write(&f.local, "index.md", "# stranded\n");
    commit_all(&f.local, "committed but never pushed");
    let stranded = head_oid(&f.local);
    assert_ne!(origin_main(&f), stranded);

    let client = Client::open(f.local.to_str().unwrap()).unwrap();
    assert_eq!(client.publish("retry").unwrap(), "Published.");
    assert_eq!(origin_main(&f), stranded);
    assert_eq!(head_oid(&f.local), stranded, "no empty commit is added");
}

#[test]
fn failed_scoped_publish_preserves_staged_sibling_changes() {
    let f = fixture();
    write(&f.local, "apps/site/index.md", "site\n");
    write(&f.local, "apps/sibling/index.md", "sibling\n");
    commit_all(&f.local, "add workspace");
    push(&f.local);

    write(&f.local, "apps/site/index.md", "site changed\n");
    write(&f.local, "apps/sibling/index.md", "sibling staged\n");
    let repo = git2::Repository::open(&f.local).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new("apps/sibling/index.md")).unwrap();
    index.write().unwrap();
    let missing = f.local.parent().unwrap().join("missing.git");
    repo.remote_set_url("origin", missing.to_str().unwrap())
        .unwrap();

    let client = Client::open(f.local.join("apps/site").to_str().unwrap()).unwrap();
    assert!(client.publish("site only").is_err());

    let repo = git2::Repository::open(&f.local).unwrap();
    let sibling = repo
        .status_file(Path::new("apps/sibling/index.md"))
        .unwrap();
    assert!(sibling.is_index_modified(), "sibling remains staged");
    let site = repo.status_file(Path::new("apps/site/index.md")).unwrap();
    assert!(site.is_wt_modified(), "site edit is back to unstaged");
    assert!(!site.is_index_modified(), "site staging was undone");
}

#[test]
fn failed_first_publish_returns_the_branch_to_unborn() {
    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("local");
    let mut options = git2::RepositoryInitOptions::new();
    options.initial_head("main");
    let repo = git2::Repository::init_opts(&local, &options).unwrap();
    init_user(&repo, "local");
    let missing = dir.path().join("missing.git");
    repo.remote("origin", missing.to_str().unwrap()).unwrap();
    write(&local, "index.md", "# first\n");

    let client = Client::open(local.to_str().unwrap()).unwrap();
    assert!(client.publish("first").is_err());

    let error = repo.head().err().expect("HEAD should be unborn");
    assert_eq!(error.code(), git2::ErrorCode::UnbornBranch);
    assert_eq!(
        status_pairs(&client),
        vec![("??".to_string(), "index.md".to_string())]
    );
}

#[test]
fn repository_lock_blocks_operations_that_rewrite_the_repository() {
    let f = fixture();
    write(&f.local, "index.md", "# edited\n");
    let mut client = Client::open(f.local.to_str().unwrap()).unwrap();
    let holder = Client::open(f.local.to_str().unwrap()).unwrap();
    let lock = holder.lock().unwrap();

    for error in [
        client.publish("blocked").unwrap_err(),
        client.pull().unwrap_err(),
        client.revert_file("index.md").unwrap_err(),
        client
            .checkout_branch("blocked", true, false)
            .err()
            .expect("checkout should be blocked"),
    ] {
        assert!(error.contains("still running"), "unexpected error: {error}");
    }
    assert_eq!(read(&f.local, "index.md"), "# edited\n");

    drop(lock);
    assert_eq!(client.publish("unblocked").unwrap(), "Published.");
}

#[test]
fn monorepo_status_and_publish_are_scoped_to_selected_project() {
    let f = fixture();
    write(&f.local, "apps/site/index.md", "site\n");
    write(&f.local, "apps/sibling/index.md", "sibling\n");
    commit_all(&f.local, "add workspace");
    push(&f.local);

    write(&f.local, "apps/site/index.md", "site changed\n");
    write(&f.local, "apps/sibling/index.md", "sibling changed\n");
    let client = Client::open(f.local.join("apps/site").to_str().unwrap()).unwrap();
    let changed = client.changed_files().unwrap();
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].path, "apps/site/index.md");

    assert_eq!(client.publish("site only").unwrap(), "Published.");
    assert!(client.changed_files().unwrap().is_empty());
    assert_eq!(
        read(&f.local, "apps/sibling/index.md"),
        "sibling changed\n",
        "sibling edit stays in the working tree"
    );
    let repo = git2::Repository::open(&f.local).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    let sibling = head
        .tree()
        .unwrap()
        .get_path(Path::new("apps/sibling/index.md"))
        .unwrap()
        .to_object(&repo)
        .unwrap()
        .peel_to_blob()
        .unwrap();
    assert_eq!(
        sibling.content(),
        b"sibling\n",
        "sibling edit was not committed"
    );
}

#[test]
fn scoped_publish_preserves_staged_sibling_changes() {
    let f = fixture();
    write(&f.local, "apps/site/index.md", "site\n");
    write(&f.local, "apps/sibling/index.md", "sibling\n");
    commit_all(&f.local, "add workspace");
    push(&f.local);

    write(&f.local, "apps/site/index.md", "site changed\n");
    write(&f.local, "apps/sibling/index.md", "sibling staged\n");
    let repo = git2::Repository::open(&f.local).unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new("apps/sibling/index.md")).unwrap();
    index.write().unwrap();

    let client = Client::open(f.local.join("apps/site").to_str().unwrap()).unwrap();
    assert_eq!(client.publish("site only").unwrap(), "Published.");

    let repo = git2::Repository::open(&f.local).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    let sibling = head
        .tree()
        .unwrap()
        .get_path(Path::new("apps/sibling/index.md"))
        .unwrap()
        .to_object(&repo)
        .unwrap()
        .peel_to_blob()
        .unwrap();
    assert_eq!(
        sibling.content(),
        b"sibling\n",
        "staged sibling was not committed"
    );
    let status = repo
        .status_file(Path::new("apps/sibling/index.md"))
        .unwrap();
    assert!(status.is_index_modified(), "staged sibling remains staged");
    assert!(
        !status.is_wt_modified(),
        "sibling working tree still matches its staged content"
    );
}

#[test]
fn scoped_pull_blocks_conflicting_sibling_changes() {
    let f = fixture();
    write(&f.local, "apps/site/index.md", "site\n");
    write(&f.local, "apps/sibling/index.md", "sibling\n");
    commit_all(&f.local, "add workspace");
    push(&f.local);
    Client::open(f.other.to_str().unwrap())
        .unwrap()
        .pull()
        .unwrap();

    write(&f.local, "apps/sibling/index.md", "local sibling draft\n");
    server_change(
        &f,
        "apps/sibling/index.md",
        "server sibling\n",
        "server sibling edit",
    );

    let mut client = Client::open(f.local.join("apps/site").to_str().unwrap()).unwrap();
    let error = client.pull().unwrap_err();
    assert!(
        error.contains("changes outside the selected project"),
        "pull explains that hidden sibling changes require manual resolution: {error}"
    );
    assert_eq!(
        read(&f.local, "apps/sibling/index.md"),
        "local sibling draft\n",
        "a pull from the selected project never discards hidden sibling edits"
    );
    let repo = git2::Repository::open(&f.local).unwrap();
    assert_eq!(stash_count(repo), 0, "hidden changes were never stashed");
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

#[test]
fn reports_which_files_git_ignores() {
    let f = fixture();
    write(&f.local, ".gitignore", "cache\n*.log\n");
    write(&f.local, "cache/data-store.json", "{}");
    write(&f.local, "debug.log", "");
    write(&f.local, "src/page.astro", "");
    let path = |rel: &str| f.local.join(rel).to_string_lossy().to_string();
    let client = Client::open(f.local.to_str().unwrap()).unwrap();

    let ignored = client
        .ignored_paths(vec![
            path("cache/data-store.json"),
            path("debug.log"),
            path("src/page.astro"),
            "/elsewhere/file.json".to_string(),
        ])
        .unwrap();

    assert_eq!(
        ignored,
        vec![path("cache/data-store.json"), path("debug.log")]
    );
}

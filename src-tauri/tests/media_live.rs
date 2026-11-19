//! Runs the storage backends against real Bunny zones. Ignored by default:
//!
//! ```sh
//! source ~/.config/posto-cdn-spike.env
//! cargo test --test media_live -- --ignored --test-threads=1
//! ```

use posto_lib::media::probe::inspect_file;
use posto_lib::media::provider::{
    Credential, MediaSource, Provider, ProviderKind, Upload, UploadBody,
};
use posto_lib::media::publish::{
    execute, Hooks, PlannedUpload, PlannedWrite, PublishRequest, PublishSource,
};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"))
}

fn bunny(zone: &str, password: &str, region: &str) -> Provider {
    let source = MediaSource {
        provider: ProviderKind::Bunny,
        bucket: env(zone),
        region: Some(env(region)),
        endpoint: None,
        path_style: None,
    };
    let credential = Credential {
        access_key_id: None,
        secret: env(password),
    };
    Provider::connect(&source, &credential).unwrap()
}

fn s3() -> Provider {
    let region = env("POSTO_BUNNY_S3_REGION");
    let source = MediaSource {
        provider: ProviderKind::S3,
        bucket: env("POSTO_BUNNY_S3_ZONE"),
        region: Some(region.clone()),
        endpoint: Some(format!("https://{region}-s3.storage.bunnycdn.com")),
        path_style: Some(true),
    };
    let credential = Credential {
        access_key_id: Some(env("POSTO_BUNNY_S3_ZONE")),
        secret: env("POSTO_BUNNY_S3_PASSWORD"),
    };
    Provider::connect(&source, &credential).unwrap()
}

async fn round_trip(provider: Provider, label: &str) {
    let run = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let folder = format!("posto-spike/live-{label}-{run}");
    let key = format!("{folder}/harbor (1)-1a2b3c4d.png");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("harbor.png");
    image::RgbImage::new(12, 8).save(&path).unwrap();
    let file = inspect_file(&path).unwrap();

    assert_eq!(provider.stat(&key).await.unwrap(), None, "starts absent");
    provider
        .put(&Upload {
            key: &key,
            body: UploadBody::File(&path),
            size: file.size,
            sha256: &file.sha256,
            content_type: &file.content_type,
        })
        .await
        .expect("upload succeeds");

    let info = provider.stat(&key).await.unwrap().expect("object exists");
    assert!(
        info.matches(file.size, &file.sha256),
        "stored content matches"
    );

    let corrupt_key = format!("{folder}/corrupt.png");
    let wrong = "0".repeat(64);
    let rejected = provider
        .put(&Upload {
            key: &corrupt_key,
            body: UploadBody::File(&path),
            size: file.size,
            sha256: &wrong,
            content_type: &file.content_type,
        })
        .await;
    assert!(rejected.is_err(), "a wrong checksum must be rejected");
    assert_eq!(
        provider.stat(&corrupt_key).await.unwrap(),
        None,
        "nothing stored"
    );

    let listing = provider.list(&folder).await.unwrap();
    assert_eq!(listing.objects.len(), 1, "{listing:?}");
    assert_eq!(listing.objects[0].key, key);

    provider.delete(&key).await.expect("delete succeeds");
    assert_eq!(provider.stat(&key).await.unwrap(), None, "object removed");
    provider.delete(&key).await.expect("repeat delete succeeds");
}

#[tokio::test]
#[ignore = "requires real Bunny storage zones"]
async fn native_api_on_a_standard_zone() {
    let provider = bunny(
        "POSTO_BUNNY_NATIVE_ZONE",
        "POSTO_BUNNY_NATIVE_PASSWORD",
        "POSTO_BUNNY_NATIVE_REGION",
    );
    round_trip(provider, "native").await;
}

#[tokio::test]
#[ignore = "requires real Bunny storage zones"]
async fn native_api_on_an_s3_enabled_zone() {
    let provider = bunny(
        "POSTO_BUNNY_S3_ZONE",
        "POSTO_BUNNY_S3_PASSWORD",
        "POSTO_BUNNY_S3_REGION",
    );
    round_trip(provider, "native-on-s3").await;
}

#[tokio::test]
#[ignore = "requires real Bunny storage zones"]
async fn s3_api_on_an_s3_enabled_zone() {
    round_trip(s3(), "s3").await;
}

#[tokio::test]
#[ignore = "requires real Bunny storage zones"]
async fn wrong_passwords_are_reported_clearly() {
    let source = MediaSource {
        provider: ProviderKind::Bunny,
        bucket: env("POSTO_BUNNY_NATIVE_ZONE"),
        region: Some(env("POSTO_BUNNY_NATIVE_REGION")),
        endpoint: None,
        path_style: None,
    };
    let credential = Credential {
        access_key_id: None,
        secret: "definitely-wrong".to_string(),
    };
    let provider = Provider::connect(&source, &credential).unwrap();
    let error = provider.list("posto-spike").await.unwrap_err();
    assert!(error.contains("rejected the saved credentials"), "{error}");
}

fn commit_and_push(path: &Path, message: &str) {
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
    repo.find_remote("origin")
        .unwrap()
        .push(&["refs/heads/main:refs/heads/main"], None)
        .unwrap();
}

#[tokio::test]
#[ignore = "requires real Bunny storage zones"]
async fn a_full_publish_reaches_real_storage() {
    let run = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let origin = root.join("origin.git");
    let mut options = git2::RepositoryInitOptions::new();
    options.bare(true).initial_head("main");
    git2::Repository::init_opts(&origin, &options).unwrap();
    let local = root.join("site");
    let mut options = git2::RepositoryInitOptions::new();
    options.initial_head("main");
    let repo = git2::Repository::init_opts(&local, &options).unwrap();
    repo.remote("origin", origin.to_str().unwrap()).unwrap();
    let mut config = repo.config().unwrap();
    config.set_str("user.name", "Test").unwrap();
    config.set_str("user.email", "test@example.com").unwrap();
    let photos = local.join("src/data/photos");
    std::fs::create_dir_all(&photos).unwrap();
    let image = photos.join("harbor.png");
    image::RgbImage::new(12, 8).save(&image).unwrap();
    let metadata = "src: ./harbor.png\nalt: Harbor\n";
    std::fs::write(photos.join("harbor.yaml"), metadata).unwrap();
    commit_and_push(&local, "initial");

    let file = inspect_file(&image).unwrap();
    let prefix = format!("posto-spike/live-publish-{run}");
    let key = format!("{prefix}/harbor-{}.png", &file.sha256[..8]);
    let url = format!("https://media.example.com/{key}");
    let connection = MediaSource {
        provider: ProviderKind::Bunny,
        bucket: env("POSTO_BUNNY_NATIVE_ZONE"),
        region: Some(env("POSTO_BUNNY_NATIVE_REGION")),
        endpoint: None,
        path_style: None,
    };
    let request = PublishRequest {
        root: local.to_string_lossy().to_string(),
        message: "move photos to the CDN".to_string(),
        sources: vec![PublishSource {
            name: "cdn".to_string(),
            prefix: Some(prefix),
            connection: connection.clone(),
        }],
        uploads: vec![PlannedUpload {
            source_name: "cdn".to_string(),
            path: image.to_string_lossy().to_string(),
            key: key.clone(),
            sha256: file.sha256.clone(),
            size: file.size,
            content_type: file.content_type.clone(),
            derived: None,
        }],
        writes: vec![PlannedWrite {
            path: photos.join("harbor.yaml").to_string_lossy().to_string(),
            previous: metadata.to_string(),
            content: format!("src: \"{url}\"\nalt: Harbor\nwidth: 12\nheight: 8\n"),
        }],
        removals: vec![image.to_string_lossy().to_string()],
        deletes: Vec::new(),
    };
    let credential = Credential {
        access_key_id: None,
        secret: env("POSTO_BUNNY_NATIVE_PASSWORD"),
    };
    let providers = HashMap::from([(
        "cdn".to_string(),
        Provider::connect(&connection, &credential).unwrap(),
    )]);

    let summary = execute(request, providers, Arc::new(|_| {}), Hooks::default())
        .await
        .expect("publish succeeds");

    assert_eq!(summary.message, "Published.");
    let storage = Provider::connect(&connection, &credential).unwrap();
    let stored = storage
        .stat(&key)
        .await
        .unwrap()
        .expect("image is on Bunny");
    assert!(stored.matches(file.size, &file.sha256));
    assert!(!image.exists(), "local image removed");
    let origin = git2::Repository::open(&origin).unwrap();
    let tree = origin
        .find_reference("refs/heads/main")
        .unwrap()
        .peel_to_tree()
        .unwrap();
    assert!(tree
        .get_path(Path::new("src/data/photos/harbor.png"))
        .is_err());
    let entry = tree
        .get_path(Path::new("src/data/photos/harbor.yaml"))
        .unwrap();
    let published = origin.find_blob(entry.id()).unwrap().content().to_vec();
    assert!(String::from_utf8(published).unwrap().contains(&url));

    storage.delete(&key).await.unwrap();
}

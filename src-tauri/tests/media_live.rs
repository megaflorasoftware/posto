//! Runs the storage backends against real Bunny zones. Ignored by default:
//!
//! ```sh
//! source ~/.config/posto-cdn-spike.env
//! cargo test --test media_live -- --ignored --test-threads=1
//! ```

use posto_lib::media::probe::inspect_file;
use posto_lib::media::provider::{Credential, MediaSource, Provider, ProviderKind, Upload};
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
            path: &path,
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
            path: &path,
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

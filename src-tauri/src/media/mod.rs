//! CDN storage: per-device credentials, provider access, and image inspection.
//! Secrets stay on the Rust side; the webview can only save, check, or remove them.

pub mod backfill;
pub mod bunny;
pub mod deletes;
pub mod derive;
pub mod journal;
pub mod probe;
pub mod provider;
pub mod publish;
pub mod remote;
pub mod s3;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use crate::git::Client;
use crate::secrets;
use deletes::DeleteIntent;
use probe::FileInspection;
use provider::{Credential, Listing, MediaSource, Provider, ProviderKind};
use publish::{Hooks, PublishProgress, PublishRequest, PublishSummary, RecoveryOutcome};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

const SECRET_SERVICE: &str = "net.megaflora.posto.media";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredCredential {
    access_key_id: Option<String>,
    secret: String,
}

/// Identifies a secret by where it may be sent. Clones of a site share it, and
/// editing the committed config can't redirect it to a different host.
pub fn credential_account(source: &MediaSource) -> Result<String, String> {
    let (provider, host) = match source.provider {
        ProviderKind::Bunny => ("bunny", bunny::storage_host(source.region.as_deref())?),
        ProviderKind::S3 => {
            let endpoint = source
                .endpoint
                .as_deref()
                .ok_or("This S3 source has no endpoint")?;
            let url = reqwest::Url::parse(endpoint)
                .map_err(|_| "Invalid storage endpoint URL".to_string())?;
            let host = url.host_str().ok_or("Invalid storage endpoint URL")?;
            let host = match url.port() {
                Some(port) => format!("{host}:{port}"),
                None => host.to_string(),
            };
            ("s3", host)
        }
    };
    Ok(format!("{provider}:{host}:{}", source.bucket))
}

fn load_credential(source: &MediaSource) -> Result<Option<Credential>, String> {
    let account = credential_account(source)?;
    secrets::get(SECRET_SERVICE, &account)?
        .map(|value| {
            let stored: StoredCredential =
                serde_json::from_str(&value).map_err(|_| "The saved credential is unreadable")?;
            Ok(Credential {
                access_key_id: stored.access_key_id,
                secret: stored.secret,
            })
        })
        .transpose()
}

pub(crate) async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| error.to_string())?
}

async fn connected(source: &MediaSource) -> Result<Provider, String> {
    let lookup = source.clone();
    let credential = blocking(move || load_credential(&lookup))
        .await?
        .ok_or("No storage credentials are saved on this device")?;
    Provider::connect(source, &credential)
}

#[tauri::command]
pub async fn media_credential_exists(source: MediaSource) -> Result<bool, String> {
    blocking(move || load_credential(&source).map(|credential| credential.is_some())).await
}

/// Checks a credential against storage, then saves it to the device keychain.
#[tauri::command]
pub async fn media_credential_save(
    source: MediaSource,
    credential: Credential,
    prefix: String,
) -> Result<(), String> {
    Provider::connect(&source, &credential)?
        .list(&prefix)
        .await?;
    blocking(move || {
        let account = credential_account(&source)?;
        let stored = serde_json::to_string(&StoredCredential {
            access_key_id: credential.access_key_id,
            secret: credential.secret,
        })
        .map_err(|error| error.to_string())?;
        secrets::set(SECRET_SERVICE, &account, &stored)
    })
    .await
}

#[tauri::command]
pub async fn media_credential_delete(source: MediaSource) -> Result<(), String> {
    blocking(move || secrets::delete(SECRET_SERVICE, &credential_account(&source)?)).await
}

#[tauri::command]
pub async fn media_list_objects(source: MediaSource, prefix: String) -> Result<Listing, String> {
    connected(&source).await?.list(&prefix).await
}

type Stamp = (u64, SystemTime);
type FileCache<T> = OnceLock<Mutex<HashMap<PathBuf, (Stamp, T)>>>;

/// Results by file, reused while its size and modification time stay the
/// same. Opening Publish plans again each time, and reading large photos is
/// the slow part. Publish still hashes each image before removing it.
static INSPECTIONS: FileCache<FileInspection> = OnceLock::new();
static PLACEHOLDERS: FileCache<String> = OnceLock::new();

fn stamp(path: &Path) -> Result<Stamp, String> {
    let metadata =
        std::fs::metadata(path).map_err(|error| format!("Could not read the image: {error}"))?;
    let modified = metadata
        .modified()
        .map_err(|error| format!("Could not read the image: {error}"))?;
    Ok((metadata.len(), modified))
}

fn cached<T: Clone>(
    cache: &FileCache<T>,
    path: &Path,
    compute: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    let cache = cache.get_or_init(Default::default);
    let before = stamp(path)?;
    let hit = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(path)
        .filter(|(stamp, _)| *stamp == before)
        .map(|(_, value)| value.clone());
    if let Some(value) = hit {
        return Ok(value);
    }
    let value = compute(path)?;
    // A file that changed while it was read can't be reused.
    if stamp(path)? == before {
        cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(path.to_path_buf(), (before, value.clone()));
    }
    Ok(value)
}

pub fn inspect_file_cached(path: &Path) -> Result<FileInspection, String> {
    cached(&INSPECTIONS, path, probe::inspect_file)
}

pub fn placeholder_cached(path: &Path) -> Result<String, String> {
    cached(&PLACEHOLDERS, path, |path| {
        derive::placeholder(&derive::decode(path)?)
    })
}

/// A tiny copy of a local image as a `data:` URI, for a placeholder field.
#[tauri::command]
pub async fn media_placeholder(path: PathBuf) -> Result<String, String> {
    blocking(move || placeholder_cached(&path)).await
}

/// Makes what an image already on a CDN is missing: its sizes, uploaded beside
/// it, and its placeholder. Downloads the original only when needed.
#[tauri::command]
pub async fn media_derive_remote(
    request: backfill::RemoteDeriveRequest,
) -> Result<backfill::RemoteDerived, String> {
    let provider = connected(&request.source.connection).await?;
    backfill::derive_remote(request, &provider).await
}

#[tauri::command]
pub async fn media_inspect_file(path: PathBuf) -> Result<FileInspection, String> {
    blocking(move || inspect_file_cached(&path)).await
}

/// The size and capture date of an image already on a CDN.
#[tauri::command]
pub async fn media_remote_image_details(
    url: String,
    needs_date: bool,
) -> Result<probe::ImageDetails, String> {
    remote::image_details(&url, needs_date).await
}

/// A photo's capture date and display size, without hashing the file.
#[tauri::command]
pub async fn media_image_details(path: PathBuf) -> Result<probe::ImageDetails, String> {
    blocking(move || Ok(probe::image_details(&path))).await
}

/// Uploads pending images, rewrites content, and publishes it as one transaction.
#[tauri::command]
pub async fn media_publish(
    request: PublishRequest,
    on_progress: Channel<PublishProgress>,
) -> Result<PublishSummary, String> {
    let mut providers = HashMap::new();
    for source in &request.sources {
        let used = request
            .uploads
            .iter()
            .map(|upload| &upload.source_name)
            .chain(request.deletes.iter().map(|delete| &delete.source_name))
            .any(|name| *name == source.name);
        if used {
            providers.insert(source.name.clone(), connected(&source.connection).await?);
        }
    }
    let progress = Arc::new(move |event| {
        let _ = on_progress.send(event);
    });
    publish::execute(request, providers, progress, Hooks::default()).await
}

/// Remembers that a library entry's CDN object should be deleted at Publish.
#[tauri::command]
pub async fn media_record_delete(root: String, intent: DeleteIntent) -> Result<(), String> {
    blocking(move || deletes::record(&Client::open(&root)?, intent)).await
}

/// CDN deletes waiting for the next Publish.
#[tauri::command]
pub async fn media_pending_deletes(root: String) -> Result<Vec<DeleteIntent>, String> {
    blocking(move || deletes::pending(&Client::open(&root)?)).await
}

/// Finishes or undoes a publish that was interrupted, such as by a crash.
#[tauri::command]
pub async fn media_publish_recover(root: String) -> Result<RecoveryOutcome, String> {
    blocking(move || publish::recover(&root)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(provider: ProviderKind) -> MediaSource {
        MediaSource {
            provider,
            bucket: "site-media".to_string(),
            region: Some("ny".to_string()),
            endpoint: Some("https://account.r2.example.com:8443/base".to_string()),
            path_style: None,
        }
    }

    #[test]
    fn credentials_are_bound_to_their_destination() {
        assert_eq!(
            credential_account(&source(ProviderKind::Bunny)).unwrap(),
            "bunny:ny.storage.bunnycdn.com:site-media"
        );
        assert_eq!(
            credential_account(&source(ProviderKind::S3)).unwrap(),
            "s3:account.r2.example.com:8443:site-media"
        );
        let mut moved = source(ProviderKind::S3);
        moved.endpoint = Some("https://attacker.example.com".to_string());
        assert_ne!(
            credential_account(&moved).unwrap(),
            credential_account(&source(ProviderKind::S3)).unwrap()
        );
    }

    #[test]
    fn unknown_bunny_regions_are_rejected() {
        let mut unknown = source(ProviderKind::Bunny);
        unknown.region = Some("attacker.example.com/".to_string());
        assert!(credential_account(&unknown).is_err());
    }

    #[test]
    fn inspections_are_reused_until_the_file_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("harbor.jpg");
        std::fs::write(&path, b"first").unwrap();
        let first = inspect_file_cached(&path).unwrap();
        assert_eq!(inspect_file_cached(&path).unwrap(), first);

        // Same size, new content: the later modification time forces a re-read.
        std::fs::write(&path, b"other").unwrap();
        let file = std::fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(SystemTime::now() + std::time::Duration::from_secs(5))
            .unwrap();
        let changed = inspect_file_cached(&path).unwrap();
        assert_ne!(changed.sha256, first.sha256);
        assert_eq!(changed.sha256, probe::file_digest(&path).unwrap().0);
    }

    #[test]
    fn credential_debug_output_hides_secrets() {
        let credential = Credential {
            access_key_id: Some("key-id".to_string()),
            secret: "top-secret".to_string(),
        };
        assert_eq!(format!("{credential:?}"), "Credential { .. }");
    }
}

//! CDN storage: per-device credentials, provider access, and image inspection.
//! Secrets stay on the Rust side; the webview can only save, check, or remove them.

pub mod bunny;
pub mod probe;
pub mod provider;
pub mod s3;

use std::path::PathBuf;

use crate::secrets;
use probe::FileInspection;
use provider::{Credential, Listing, MediaSource, Provider, ProviderKind};
use serde::{Deserialize, Serialize};

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

async fn blocking<T: Send + 'static>(
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

#[tauri::command]
pub async fn media_inspect_file(path: PathBuf) -> Result<FileInspection, String> {
    blocking(move || probe::inspect_file(&path)).await
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
    fn credential_debug_output_hides_secrets() {
        let credential = Credential {
            access_key_id: Some("key-id".to_string()),
            secret: "top-secret".to_string(),
        };
        assert_eq!(format!("{credential:?}"), "Credential { .. }");
    }
}

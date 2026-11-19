//! The storage operations Posto needs, independent of the backend API.

use reqwest::{RequestBuilder, Response, StatusCode, Url};
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::path::Path;
use std::time::Duration;

use super::bunny::BunnyClient;
use super::s3::S3Client;

const RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(250), Duration::from_secs(1)];
const MAX_RETRY_AFTER: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Bunny,
    S3,
}

/// Connection details from `.posto/index.json`. Never holds a secret.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaSource {
    pub provider: ProviderKind,
    pub bucket: String,
    pub region: Option<String>,
    pub endpoint: Option<String>,
    pub path_style: Option<bool>,
}

/// A secret supplied by the user. Bunny uses only `secret`, the zone password.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub access_key_id: Option<String>,
    pub secret: String,
}

impl std::fmt::Debug for Credential {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Credential { .. }")
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectInfo {
    pub key: String,
    pub size: u64,
    /// Lowercase SHA-256, when the backend reports one.
    pub sha256: Option<String>,
}

impl ObjectInfo {
    /// Whether this object already holds the given content. Backends without a
    /// stored SHA-256 compare size; object keys also embed the content hash.
    pub fn matches(&self, size: u64, sha256: &str) -> bool {
        self.size == size && self.sha256.as_deref().is_none_or(|stored| stored == sha256)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub objects: Vec<ObjectInfo>,
    /// Full keys of immediate child folders, without a trailing slash.
    pub directories: Vec<String>,
}

/// Where an upload's bytes come from.
pub enum UploadBody<'a> {
    File(&'a Path),
    /// Already in memory, such as a resized copy.
    Bytes(&'a [u8]),
}

impl UploadBody<'_> {
    /// A fresh body for each attempt, since a failed send consumes it.
    pub(super) async fn body(&self) -> Result<reqwest::Body, String> {
        match self {
            Self::File(path) => tokio::fs::File::open(path)
                .await
                .map(reqwest::Body::from)
                .map_err(|error| format!("Could not read the image: {error}")),
            Self::Bytes(bytes) => Ok(reqwest::Body::from(bytes.to_vec())),
        }
    }
}

/// One image to store at `key`.
pub struct Upload<'a> {
    pub key: &'a str,
    pub body: UploadBody<'a>,
    pub size: u64,
    /// Lowercase SHA-256 of the file. The backend rejects a mismatch.
    pub sha256: &'a str,
    pub content_type: &'a str,
}

pub enum Provider {
    Bunny(BunnyClient),
    S3(S3Client),
}

impl Provider {
    pub fn connect(source: &MediaSource, credential: &Credential) -> Result<Self, String> {
        match source.provider {
            ProviderKind::Bunny => BunnyClient::for_source(source, credential).map(Self::Bunny),
            ProviderKind::S3 => S3Client::for_source(source, credential).map(Self::S3),
        }
    }

    pub async fn stat(&self, key: &str) -> Result<Option<ObjectInfo>, String> {
        validate_object_key(key)?;
        match self {
            Self::Bunny(client) => client.stat(key).await,
            Self::S3(client) => client.stat(key).await,
        }
    }

    pub async fn put(&self, upload: &Upload<'_>) -> Result<(), String> {
        validate_object_key(upload.key)?;
        match self {
            Self::Bunny(client) => client.put(upload).await,
            Self::S3(client) => client.put(upload).await,
        }
    }

    /// Deletes one object. An object that is already gone counts as deleted.
    pub async fn delete(&self, key: &str) -> Result<(), String> {
        validate_object_key(key)?;
        match self {
            Self::Bunny(client) => client.delete(key).await,
            Self::S3(client) => client.delete(key).await,
        }
    }

    /// Lists the immediate children of `prefix`; an empty prefix is the root.
    pub async fn list(&self, prefix: &str) -> Result<Listing, String> {
        if !prefix.is_empty() {
            validate_object_key(prefix)?;
        }
        match self {
            Self::Bunny(client) => client.list(prefix).await,
            Self::S3(client) => client.list(prefix).await,
        }
    }
}

/// Rejects keys that could address a folder or escape their location. Bunny's
/// DELETE removes a whole folder when given a path ending in a slash.
pub fn validate_object_key(key: &str) -> Result<(), String> {
    let safe = !key.is_empty()
        && !key.contains('\\')
        && !key.chars().any(char::is_control)
        && key
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..");
    if safe {
        Ok(())
    } else {
        Err(format!("Invalid storage object path: {key:?}"))
    }
}

/// Parses a backend base URL. Plain HTTP is only allowed for loopback servers.
pub(super) fn endpoint_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Invalid storage endpoint URL".to_string())?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if url.scheme() == "https" || (url.scheme() == "http" && loopback) {
        Ok(url)
    } else {
        Err("Storage endpoints must use HTTPS".to_string())
    }
}

pub(super) fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Posto")
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(transport_error)
}

/// Allows slow connections at least 32 KB/s on top of a fixed minimum.
pub(super) fn upload_timeout(size: u64) -> Duration {
    Duration::from_secs(60 + size / (32 * 1024))
}

/// Omits the URL because signed requests carry credentials in the query string.
pub(super) fn transport_error(error: reqwest::Error) -> String {
    format!("Could not reach storage: {}", error.without_url())
}

fn retryable(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

fn retry_after(response: &Response) -> Option<Duration> {
    let seconds = response.headers().get("retry-after")?.to_str().ok()?;
    let delay = Duration::from_secs(seconds.trim().parse().ok()?);
    Some(delay.min(MAX_RETRY_AFTER))
}

/// Sends a request, retrying rate limits, server errors, and dropped
/// connections. `attempt` rebuilds the request because file bodies are consumed.
pub(super) async fn send<F, Fut>(mut attempt: F) -> Result<Response, String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<RequestBuilder, String>>,
{
    for delay in RETRY_DELAYS {
        match attempt().await?.send().await {
            Ok(response) if !retryable(response.status()) => return Ok(response),
            Ok(response) => {
                tokio::time::sleep(retry_after(&response).unwrap_or(delay)).await;
            }
            Err(error) if error.is_connect() || error.is_timeout() || error.is_request() => {
                tokio::time::sleep(delay).await;
            }
            Err(error) => return Err(transport_error(error)),
        }
    }
    attempt().await?.send().await.map_err(transport_error)
}

/// Describes a failed response without echoing a long provider body.
pub(super) fn status_error(action: &str, status: StatusCode, detail: Option<String>) -> String {
    if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
        return format!("Storage rejected the saved credentials while trying to {action}.");
    }
    let detail: String = detail.unwrap_or_default().chars().take(160).collect();
    if detail.is_empty() {
        format!("Storage could not {action} (HTTP {}).", status.as_u16())
    } else {
        format!(
            "Storage could not {action} (HTTP {}): {detail}",
            status.as_u16()
        )
    }
}

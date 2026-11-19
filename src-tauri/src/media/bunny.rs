//! Bunny Storage's native HTTP API, which works on every storage zone.

use reqwest::header::{CONTENT_LENGTH, CONTENT_TYPE};
use reqwest::{Client, Method, RequestBuilder, Response, StatusCode, Url};
use serde::Deserialize;

use super::provider::{
    endpoint_url, http_client, send, status_error, transport_error, upload_timeout, Credential,
    Listing, MediaSource, ObjectInfo, Upload,
};

const REGIONS: [&str; 9] = ["de", "uk", "ny", "la", "sg", "se", "br", "jh", "syd"];

pub struct BunnyClient {
    http: Client,
    base: Url,
    zone: String,
    password: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Entry {
    object_name: String,
    length: u64,
    checksum: Option<String>,
    is_directory: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ErrorBody {
    message: String,
}

/// The storage hostname for a zone's primary region. Frankfurt has no prefix.
pub fn storage_host(region: Option<&str>) -> Result<String, String> {
    match region.unwrap_or("de") {
        "de" => Ok("storage.bunnycdn.com".to_string()),
        region if REGIONS.contains(&region) => Ok(format!("{region}.storage.bunnycdn.com")),
        region => Err(format!("Unknown Bunny storage region: {region}")),
    }
}

async fn failure(action: &str, response: Response) -> String {
    let status = response.status();
    let detail = response
        .json::<ErrorBody>()
        .await
        .ok()
        .map(|body| body.message);
    status_error(action, status, detail)
}

impl BunnyClient {
    pub fn for_source(source: &MediaSource, credential: &Credential) -> Result<Self, String> {
        let host = storage_host(source.region.as_deref())?;
        Self::new(
            &format!("https://{host}"),
            &source.bucket,
            &credential.secret,
        )
    }

    pub fn new(base: &str, zone: &str, password: &str) -> Result<Self, String> {
        Ok(Self {
            http: http_client()?,
            base: endpoint_url(base)?,
            zone: zone.to_string(),
            password: password.to_string(),
        })
    }

    fn url(&self, key: &str, directory: bool) -> Result<Url, String> {
        let mut url = self.base.clone();
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|()| "Invalid storage endpoint URL".to_string())?;
            segments.pop_if_empty().push(&self.zone);
            segments.extend(key.split('/').filter(|segment| !segment.is_empty()));
            // Bunny treats a trailing slash as a request for the folder.
            if directory {
                segments.push("");
            }
        }
        Ok(url)
    }

    fn request(&self, method: Method, url: Url) -> RequestBuilder {
        self.http
            .request(method, url)
            .header("AccessKey", &self.password)
    }

    /// Bunny answers HEAD with 401, so the parent listing supplies the size and
    /// stored SHA-256 instead.
    pub async fn stat(&self, key: &str) -> Result<Option<ObjectInfo>, String> {
        let parent = key.rsplit_once('/').map_or("", |(parent, _)| parent);
        let listing = self.list(parent).await?;
        Ok(listing.objects.into_iter().find(|item| item.key == key))
    }

    pub async fn put(&self, upload: &Upload<'_>) -> Result<(), String> {
        let url = self.url(upload.key, false)?;
        let response = send(|| {
            let url = url.clone();
            async move {
                let body = upload.body.body().await?;
                Ok(self
                    .request(Method::PUT, url)
                    .header("Checksum", upload.sha256.to_ascii_uppercase())
                    .header(CONTENT_TYPE, upload.content_type)
                    .header(CONTENT_LENGTH, upload.size)
                    .timeout(upload_timeout(upload.size))
                    .body(body))
            }
        })
        .await?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(failure("upload the image", response).await)
        }
    }

    pub async fn delete(&self, key: &str) -> Result<(), String> {
        let url = self.url(key, false)?;
        let response = send(|| {
            let url = url.clone();
            async move { Ok(self.request(Method::DELETE, url)) }
        })
        .await?;
        if response.status().is_success() || response.status() == StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(failure("delete the image", response).await)
        }
    }

    pub async fn list(&self, prefix: &str) -> Result<Listing, String> {
        let url = self.url(prefix, true)?;
        let response = send(|| {
            let url = url.clone();
            async move { Ok(self.request(Method::GET, url)) }
        })
        .await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(Listing::default());
        }
        if !response.status().is_success() {
            return Err(failure("list files", response).await);
        }
        let entries: Vec<Entry> = response.json().await.map_err(transport_error)?;
        let full_key = |name: &str| match prefix {
            "" => name.to_string(),
            prefix => format!("{prefix}/{name}"),
        };
        let mut listing = Listing::default();
        for entry in entries {
            if entry.is_directory {
                listing.directories.push(full_key(&entry.object_name));
            } else {
                listing.objects.push(ObjectInfo {
                    key: full_key(&entry.object_name),
                    size: entry.length,
                    sha256: entry.checksum.map(|sum| sum.to_ascii_lowercase()),
                });
            }
        }
        Ok(listing)
    }
}

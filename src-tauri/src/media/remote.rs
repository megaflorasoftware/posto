//! Reads details of images already on a CDN without keeping a local copy.

use reqwest::header::RANGE;
use reqwest::{Client, StatusCode};

use super::probe::{details_from_bytes, ImageDetails};
use super::provider::{endpoint_url, http_client, status_error, transport_error};

/// Usually enough for the header and EXIF block of a camera photo.
const PREVIEW_BYTES: usize = 512 * 1024;
/// Refuses to buffer more than this when the start of a file isn't enough.
const MAX_BYTES: usize = 128 * 1024 * 1024;

struct Download {
    bytes: Vec<u8>,
    /// Whether this is the whole file, so a second request can't find more.
    complete: bool,
}

async fn download(client: &Client, url: &reqwest::Url, limit: usize) -> Result<Download, String> {
    let mut response = client
        .get(url.clone())
        .header(RANGE, format!("bytes=0-{}", limit - 1))
        .send()
        .await
        .map_err(transport_error)?;
    let status = response.status();
    if !status.is_success() {
        return Err(status_error("read the image", status, None));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(transport_error)? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() >= limit {
            bytes.truncate(limit);
            return Ok(Download {
                bytes,
                complete: false,
            });
        }
    }
    // A ranged reply that filled the range may have more after it.
    let complete = status != StatusCode::PARTIAL_CONTENT || bytes.len() < limit;
    Ok(Download { bytes, complete })
}

/// Reads an image's size and, when `needs_date`, its capture date. Starts
/// with the beginning of the file and downloads the rest only if needed.
pub async fn image_details_with(
    client: &Client,
    url: &str,
    needs_date: bool,
    preview_bytes: usize,
) -> Result<ImageDetails, String> {
    let url = endpoint_url(url)?;
    let preview = download(client, &url, preview_bytes).await?;
    let details = details_from_bytes(&preview.bytes);
    let enough = details.dimensions.is_some() && (!needs_date || details.capture_date.is_some());
    if enough || preview.complete {
        return Ok(details);
    }
    let full = download(client, &url, MAX_BYTES).await?;
    if !full.complete {
        return Err("The image is too large to read.".to_string());
    }
    Ok(details_from_bytes(&full.bytes))
}

pub async fn image_details(url: &str, needs_date: bool) -> Result<ImageDetails, String> {
    image_details_with(&http_client()?, url, needs_date, PREVIEW_BYTES).await
}

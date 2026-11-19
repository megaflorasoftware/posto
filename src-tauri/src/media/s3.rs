//! Any storage service that implements the S3 API.

use base64::Engine;
use reqwest::header::{CONTENT_LENGTH, CONTENT_TYPE};
use reqwest::{Client, Response, StatusCode, Url};
use rusty_s3::actions::{DeleteObject, HeadObject, ListObjectsV2, PutObject, S3Action};
use rusty_s3::{Bucket, Credentials, UrlStyle};
use std::borrow::Cow;
use std::time::Duration;

use super::provider::{
    endpoint_url, http_client, send, status_error, transport_error, upload_timeout, Credential,
    Listing, MediaSource, ObjectInfo, Upload,
};

const SIGNATURE_LIFETIME: Duration = Duration::from_secs(300);
const CHECKSUM_HEADER: &str = "x-amz-checksum-sha256";

pub struct S3Client {
    http: Client,
    bucket: Bucket,
    credentials: Credentials,
}

fn hex_to_base64(sha256: &str) -> Result<String, String> {
    let invalid = || "Invalid image checksum".to_string();
    if sha256.len() != 64 || !sha256.is_ascii() {
        return Err(invalid());
    }
    let bytes = (0..sha256.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&sha256[index..index + 2], 16).map_err(|_| invalid()))
        .collect::<Result<Vec<u8>, String>>()?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Extracts the error code from an S3 XML error body.
fn error_code(body: &str) -> Option<String> {
    let start = body.find("<Code>")? + "<Code>".len();
    let end = body[start..].find("</Code>")? + start;
    Some(body[start..end].to_string())
}

/// Adds the S3 namespace the listing parser requires. Some compatible services,
/// including Bunny, omit it from their responses.
fn with_s3_namespace(body: &str) -> Cow<'_, str> {
    const ROOT: &str = "<ListBucketResult";
    let Some(start) = body.find(ROOT) else {
        return Cow::Borrowed(body);
    };
    let attributes = start + ROOT.len();
    let Some(length) = body[attributes..].find('>') else {
        return Cow::Borrowed(body);
    };
    if body[attributes..attributes + length].contains("xmlns=") {
        return Cow::Borrowed(body);
    }
    let namespace = r#" xmlns="http://s3.amazonaws.com/doc/2006-03-01/""#;
    Cow::Owned(format!(
        "{}{namespace}{}",
        &body[..attributes],
        &body[attributes..]
    ))
}

async fn failure(action: &str, response: Response) -> String {
    let status = response.status();
    let detail = response
        .text()
        .await
        .ok()
        .and_then(|body| error_code(&body));
    status_error(action, status, detail)
}

impl S3Client {
    pub fn for_source(source: &MediaSource, credential: &Credential) -> Result<Self, String> {
        let endpoint = source
            .endpoint
            .as_deref()
            .ok_or("This S3 source has no endpoint")?;
        let access_key = credential
            .access_key_id
            .as_deref()
            .ok_or("This S3 source needs an access key ID")?;
        Self::new(
            endpoint,
            source.path_style.unwrap_or(true),
            &source.bucket,
            source.region.as_deref().unwrap_or("auto"),
            access_key,
            &credential.secret,
        )
    }

    pub fn new(
        endpoint: &str,
        path_style: bool,
        bucket: &str,
        region: &str,
        access_key: &str,
        secret: &str,
    ) -> Result<Self, String> {
        let mut endpoint: Url = endpoint_url(endpoint)?;
        if !endpoint.path().ends_with('/') {
            endpoint.set_path(&format!("{}/", endpoint.path()));
        }
        let style = if path_style {
            UrlStyle::Path
        } else {
            UrlStyle::VirtualHost
        };
        let bucket = Bucket::new(endpoint, style, bucket.to_string(), region.to_string())
            .map_err(|_| "Invalid S3 bucket configuration".to_string())?;
        Ok(Self {
            http: http_client()?,
            bucket,
            credentials: Credentials::new(access_key.to_string(), secret.to_string()),
        })
    }

    pub async fn stat(&self, key: &str) -> Result<Option<ObjectInfo>, String> {
        let response = send(|| async {
            let url = HeadObject::new(&self.bucket, Some(&self.credentials), key)
                .sign(SIGNATURE_LIFETIME);
            Ok(self.http.head(url))
        })
        .await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(status_error("check the image", response.status(), None));
        }
        let size = response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok())
            .ok_or("Storage did not report the image size")?;
        Ok(Some(ObjectInfo {
            key: key.to_string(),
            size,
            sha256: None,
        }))
    }

    pub async fn put(&self, upload: &Upload<'_>) -> Result<(), String> {
        // Services may ignore the signed payload hash, so the explicit checksum
        // header is what makes them reject a corrupted upload.
        let checksum = hex_to_base64(upload.sha256)?;
        let lifetime = SIGNATURE_LIFETIME + upload_timeout(upload.size) * 3;
        let response = send(|| {
            let checksum = checksum.clone();
            async move {
                let mut action = PutObject::new(&self.bucket, Some(&self.credentials), upload.key);
                action
                    .headers_mut()
                    .insert(CHECKSUM_HEADER, checksum.clone());
                action
                    .headers_mut()
                    .insert("content-type", upload.content_type);
                let url = action.sign(lifetime);
                let body = upload.body.body().await?;
                Ok(self
                    .http
                    .put(url)
                    .header(CHECKSUM_HEADER, checksum)
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
        let response = send(|| async {
            let url = DeleteObject::new(&self.bucket, Some(&self.credentials), key)
                .sign(SIGNATURE_LIFETIME);
            Ok(self.http.delete(url))
        })
        .await?;
        if response.status().is_success() || response.status() == StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(failure("delete the image", response).await)
        }
    }

    pub async fn list(&self, prefix: &str) -> Result<Listing, String> {
        let folder = match prefix {
            "" => String::new(),
            prefix => format!("{prefix}/"),
        };
        let mut listing = Listing::default();
        let mut token: Option<String> = None;
        loop {
            let response = send(|| {
                let token = token.clone();
                let folder = folder.clone();
                async move {
                    let mut action = ListObjectsV2::new(&self.bucket, Some(&self.credentials));
                    action.with_delimiter("/");
                    if !folder.is_empty() {
                        action.with_prefix(folder);
                    }
                    if let Some(token) = token {
                        action.with_continuation_token(token);
                    }
                    Ok(self.http.get(action.sign(SIGNATURE_LIFETIME)))
                }
            })
            .await?;
            if !response.status().is_success() {
                return Err(failure("list files", response).await);
            }
            let body = response.text().await.map_err(transport_error)?;
            let page = ListObjectsV2::parse_response(&with_s3_namespace(&body))
                .map_err(|_| "Storage returned an unreadable file listing".to_string())?;
            listing.objects.extend(
                page.contents
                    .into_iter()
                    .filter(|item| item.key != folder)
                    .map(|item| ObjectInfo {
                        key: item.key,
                        size: item.size.unwrap_or(0),
                        sha256: None,
                    }),
            );
            listing.directories.extend(
                page.common_prefixes
                    .into_iter()
                    .map(|item| item.prefix.trim_end_matches('/').to_string()),
            );
            token = page.next_continuation_token;
            if token.is_none() {
                return Ok(listing);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENTRIES: &str = "<IsTruncated>false</IsTruncated>\
        <Contents><Key>images/a &amp; b.jpg</Key><Size>7</Size></Contents>\
        <CommonPrefixes><Prefix>images/trips/</Prefix></CommonPrefixes>";

    #[test]
    fn parses_listings_with_and_without_the_s3_namespace() {
        let roots = [
            r#"<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">"#,
            r#"<ListBucketResult xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">"#,
            "<ListBucketResult>",
        ];
        for root in roots {
            let body = format!(
                r#"<?xml version="1.0" encoding="utf-8"?>{root}{ENTRIES}</ListBucketResult>"#
            );
            let page = ListObjectsV2::parse_response(&with_s3_namespace(&body)).unwrap();
            assert_eq!(page.contents[0].key, "images/a & b.jpg", "{root}");
            assert_eq!(page.contents[0].size, Some(7), "{root}");
            assert_eq!(page.common_prefixes[0].prefix, "images/trips/", "{root}");
        }
    }

    #[test]
    fn encodes_checksums_for_the_s3_header() {
        let sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert_eq!(
            hex_to_base64(sha256).unwrap(),
            "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0="
        );
        assert!(hex_to_base64("not-a-checksum").is_err());
    }
}

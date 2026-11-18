//! Exercises both storage backends against an in-memory server that follows the
//! behavior observed from Bunny's native and S3 APIs.

use axum::body::{to_bytes, Body};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use axum::Router;
use base64::Engine;
use posto_lib::media::bunny::BunnyClient;
use posto_lib::media::provider::{validate_object_key, Listing, ObjectInfo, Provider, Upload};
use posto_lib::media::s3::S3Client;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const PASSWORD: &str = "zone-password";

#[derive(Default)]
struct Server {
    objects: Mutex<BTreeMap<String, Stored>>,
    /// Statuses returned, in order, before requests are handled normally.
    failures: Mutex<VecDeque<u16>>,
    requests: Mutex<Vec<Seen>>,
}

#[derive(Clone)]
struct Stored {
    bytes: Vec<u8>,
    content_type: String,
}

#[derive(Clone, Debug)]
struct Seen {
    method: Method,
    content_length: Option<String>,
    chunked: bool,
}

fn sha256(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn respond(status: u16, body: impl Into<Body>) -> Response {
    Response::builder()
        .status(status)
        .body(body.into())
        .unwrap()
}

fn decoded(path: &str) -> String {
    let mut bytes = Vec::new();
    let raw = path.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        if raw[index] == b'%' {
            let pair = std::str::from_utf8(&raw[index + 1..index + 3]).unwrap();
            bytes.push(u8::from_str_radix(pair, 16).unwrap());
            index += 3;
        } else {
            bytes.push(raw[index]);
            index += 1;
        }
    }
    String::from_utf8(bytes).unwrap()
}

fn record(server: &Server, request: &Request) -> Option<Response> {
    let headers: &HeaderMap = request.headers();
    server.requests.lock().unwrap().push(Seen {
        method: request.method().clone(),
        content_length: headers
            .get("content-length")
            .map(|value| value.to_str().unwrap().to_string()),
        chunked: headers.contains_key("transfer-encoding"),
    });
    let failure = server.failures.lock().unwrap().pop_front();
    failure.map(|status| respond(status, ""))
}

async fn bunny_handler(State(server): State<Arc<Server>>, request: Request) -> Response {
    if let Some(response) = record(&server, &request) {
        return response;
    }
    if request.method() == Method::HEAD {
        return respond(401, "");
    }
    if request.headers().get("accesskey").map(|v| v.as_bytes()) != Some(PASSWORD.as_bytes()) {
        return respond(401, r#"{"HttpCode":401,"Message":"Unauthorized"}"#);
    }
    let path = decoded(request.uri().path());
    let key = path.strip_prefix("/zone/").unwrap().to_string();
    let method = request.method().clone();
    let headers = request.headers().clone();
    let bytes = to_bytes(request.into_body(), usize::MAX).await.unwrap();
    let mut objects = server.objects.lock().unwrap();
    match method {
        Method::PUT => {
            let expected = headers
                .get("checksum")
                .map(|v| v.to_str().unwrap().to_lowercase());
            if expected.is_some_and(|sum| sum != hex(&sha256(&bytes))) {
                return respond(400, r#"{"HttpCode":400,"Message":"Checksum missmatch"}"#);
            }
            let content_type = headers["content-type"].to_str().unwrap().to_string();
            objects.insert(
                key,
                Stored {
                    bytes: bytes.to_vec(),
                    content_type,
                },
            );
            respond(201, r#"{"HttpCode":201,"Message":"File uploaded."}"#)
        }
        Method::GET if key.is_empty() || key.ends_with('/') => {
            let mut entries = BTreeMap::new();
            for (name, stored) in objects.iter() {
                let Some(rest) = name.strip_prefix(&key) else {
                    continue;
                };
                let (child, directory) = match rest.split_once('/') {
                    Some((folder, _)) => (folder, true),
                    None => (rest, false),
                };
                entries.insert(
                    child.to_string(),
                    serde_json::json!({
                        "ObjectName": child,
                        "Length": if directory { 0 } else { stored.bytes.len() },
                        "Checksum": (!directory).then(|| hex(&sha256(&stored.bytes)).to_uppercase()),
                        "IsDirectory": directory,
                    }),
                );
            }
            let list: Vec<_> = entries.into_values().collect();
            respond(200, serde_json::to_string(&list).unwrap())
        }
        Method::DELETE if key.ends_with('/') => {
            objects.retain(|name, _| !name.starts_with(&key));
            respond(200, "")
        }
        Method::DELETE => match objects.remove(&key) {
            Some(_) => respond(200, ""),
            None => respond(404, r#"{"HttpCode":404,"Message":"Object Not Found"}"#),
        },
        _ => respond(405, ""),
    }
}

fn query_value(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name).then(|| decoded(value))
    })
}

async fn s3_handler(State(server): State<Arc<Server>>, request: Request) -> Response {
    if let Some(response) = record(&server, &request) {
        return response;
    }
    let query = request.uri().query().unwrap_or_default().to_string();
    if query_value(&query, "X-Amz-Credential").is_none_or(|value| !value.starts_with("access/")) {
        return respond(403, "<Error><Code>SignatureDoesNotMatch</Code></Error>");
    }
    let path = decoded(request.uri().path());
    let key = path
        .strip_prefix("/bucket/")
        .unwrap_or_default()
        .to_string();
    let method = request.method().clone();
    let headers = request.headers().clone();
    let bytes = to_bytes(request.into_body(), usize::MAX).await.unwrap();
    let mut objects = server.objects.lock().unwrap();
    match method {
        Method::PUT => {
            let expected = base64::engine::general_purpose::STANDARD.encode(sha256(&bytes));
            if headers["x-amz-checksum-sha256"].to_str().unwrap() != expected {
                return respond(400, "<Error><Code>BadDigest</Code></Error>");
            }
            let content_type = headers["content-type"].to_str().unwrap().to_string();
            objects.insert(
                key,
                Stored {
                    bytes: bytes.to_vec(),
                    content_type,
                },
            );
            respond(200, "")
        }
        Method::HEAD => match objects.get(&key) {
            Some(stored) => Response::builder()
                .status(200)
                .header("content-length", stored.bytes.len())
                .body(Body::empty())
                .unwrap(),
            None => respond(404, ""),
        },
        Method::DELETE => {
            objects.remove(&key);
            respond(204, "")
        }
        Method::GET => {
            let prefix = query_value(&query, "prefix").unwrap_or_default();
            let start: usize =
                query_value(&query, "continuation-token").map_or(0, |token| token.parse().unwrap());
            let mut contents = Vec::new();
            let mut folders = std::collections::BTreeSet::new();
            for (name, stored) in objects.iter() {
                let Some(rest) = name.strip_prefix(&prefix) else {
                    continue;
                };
                match rest.split_once('/') {
                    Some((folder, _)) => {
                        folders.insert(format!("{prefix}{folder}/"));
                    }
                    None => contents.push((name.clone(), stored.bytes.len())),
                }
            }
            // One object per page, so listing must follow continuation tokens.
            let page = contents.get(start);
            let next = (start + 1 < contents.len()).then(|| start + 1);
            let mut xml = String::from("<ListBucketResult>");
            if let Some((name, size)) = page {
                xml += &format!("<Contents><Key>{name}</Key><Size>{size}</Size></Contents>");
            }
            if start == 0 {
                for folder in folders {
                    xml += &format!("<CommonPrefixes><Prefix>{folder}</Prefix></CommonPrefixes>");
                }
            }
            if let Some(next) = next {
                xml += &format!("<NextContinuationToken>{next}</NextContinuationToken>");
            }
            respond(200, xml + "</ListBucketResult>")
        }
        _ => respond(405, ""),
    }
}

struct Harness {
    server: Arc<Server>,
    base: String,
    dir: tempfile::TempDir,
}

impl Harness {
    async fn start(handler: fn(Router<Arc<Server>>) -> Router<Arc<Server>>) -> Self {
        let server = Arc::new(Server::default());
        let app = handler(Router::new()).with_state(server.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            server,
            base,
            dir: tempfile::tempdir().unwrap(),
        }
    }

    async fn bunny() -> (Self, Provider) {
        let harness = Self::start(|router| router.fallback(bunny_handler)).await;
        let client = BunnyClient::new(&harness.base, "zone", PASSWORD).unwrap();
        (harness, Provider::Bunny(client))
    }

    async fn s3() -> (Self, Provider) {
        let harness = Self::start(|router| router.fallback(s3_handler)).await;
        let client =
            S3Client::new(&harness.base, true, "bucket", "de", "access", "secret").unwrap();
        (harness, Provider::S3(client))
    }

    fn file(&self, name: &str, bytes: &[u8]) -> (PathBuf, String) {
        let path = self.dir.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        (path, hex(&sha256(bytes)))
    }

    fn stored(&self, key: &str) -> Option<Stored> {
        self.server.objects.lock().unwrap().get(key).cloned()
    }

    fn fail_next(&self, statuses: &[u16]) {
        self.server.failures.lock().unwrap().extend(statuses);
    }

    fn request_count(&self) -> usize {
        self.server.requests.lock().unwrap().len()
    }
}

async fn put(
    harness: &Harness,
    provider: &Provider,
    key: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let (path, sha256) = harness.file("upload.bin", bytes);
    provider
        .put(&Upload {
            key,
            path: &path,
            size: bytes.len() as u64,
            sha256: &sha256,
            content_type: "image/avif",
        })
        .await
}

async fn exercises_the_object_lifecycle(harness: Harness, provider: Provider) {
    let key = "images/trips/harbor-1a2b3c4d.avif";
    assert_eq!(provider.stat(key).await.unwrap(), None);

    put(&harness, &provider, key, b"image bytes").await.unwrap();
    let stored = harness.stored(key).expect("object stored");
    assert_eq!(stored.bytes, b"image bytes");
    assert_eq!(stored.content_type, "image/avif");

    let info = provider.stat(key).await.unwrap().expect("object found");
    assert!(info.matches(11, &hex(&sha256(b"image bytes"))));
    assert!(!info.matches(12, &hex(&sha256(b"image bytes"))));

    put(&harness, &provider, "images/trips/nested/deep.avif", b"x")
        .await
        .unwrap();
    let listing: Listing = provider.list("images/trips").await.unwrap();
    assert_eq!(
        listing
            .objects
            .iter()
            .map(|item| item.key.as_str())
            .collect::<Vec<_>>(),
        vec![key]
    );
    assert_eq!(listing.directories, vec!["images/trips/nested"]);

    provider.delete(key).await.unwrap();
    assert_eq!(provider.stat(key).await.unwrap(), None);
    provider
        .delete(key)
        .await
        .expect("deleting a missing object succeeds");

    let upload = harness
        .server
        .requests
        .lock()
        .unwrap()
        .iter()
        .find(|seen| seen.method == Method::PUT)
        .cloned()
        .unwrap();
    assert_eq!(upload.content_length.as_deref(), Some("11"));
    assert!(!upload.chunked, "uploads declare their length");
}

async fn rejects_corrupted_uploads(harness: Harness, provider: Provider) {
    let (path, _) = harness.file("corrupt.bin", b"actual bytes");
    let wrong = hex(&sha256(b"different bytes"));
    let error = provider
        .put(&Upload {
            key: "images/corrupt.jpg",
            path: &path,
            size: 12,
            sha256: &wrong,
            content_type: "image/jpeg",
        })
        .await
        .unwrap_err();
    assert!(error.contains("HTTP 400"), "unexpected error: {error}");
    assert!(harness.stored("images/corrupt.jpg").is_none());
}

async fn retries_transient_failures(harness: Harness, provider: Provider) {
    harness.fail_next(&[503, 429]);
    put(&harness, &provider, "images/retried.jpg", b"bytes")
        .await
        .unwrap();
    assert_eq!(
        harness.stored("images/retried.jpg").unwrap().bytes,
        b"bytes"
    );
    assert_eq!(harness.request_count(), 3);
}

async fn gives_up_after_repeated_failures(harness: Harness, provider: Provider) {
    harness.fail_next(&[500, 500, 500]);
    let error = put(&harness, &provider, "images/down.jpg", b"bytes")
        .await
        .unwrap_err();
    assert!(error.contains("HTTP 500"), "unexpected error: {error}");
    assert_eq!(harness.request_count(), 3);
    assert!(harness.stored("images/down.jpg").is_none());
}

async fn does_not_retry_rejected_credentials(harness: Harness, provider: Provider) {
    harness.fail_next(&[403]);
    let error = put(&harness, &provider, "images/denied.jpg", b"bytes")
        .await
        .unwrap_err();
    assert!(
        error.contains("rejected the saved credentials"),
        "unexpected error: {error}"
    );
    assert_eq!(harness.request_count(), 1);
}

async fn blocks_unsafe_keys_before_any_request(harness: Harness, provider: Provider) {
    for key in [
        "",
        "/",
        "images/",
        "/images/a.jpg",
        "images//a.jpg",
        "images/../a.jpg",
        "a\\b.jpg",
    ] {
        assert!(
            validate_object_key(key).is_err(),
            "{key:?} should be rejected"
        );
        assert!(
            provider.delete(key).await.is_err(),
            "{key:?} should not be deleted"
        );
    }
    assert_eq!(harness.request_count(), 0);
}

macro_rules! provider_tests {
    ($module:ident, $start:path) => {
        mod $module {
            use super::*;

            #[tokio::test]
            async fn object_lifecycle() {
                let (harness, provider) = $start().await;
                exercises_the_object_lifecycle(harness, provider).await;
            }

            #[tokio::test]
            async fn corrupted_uploads_are_rejected() {
                let (harness, provider) = $start().await;
                rejects_corrupted_uploads(harness, provider).await;
            }

            #[tokio::test]
            async fn transient_failures_are_retried() {
                let (harness, provider) = $start().await;
                retries_transient_failures(harness, provider).await;
            }

            #[tokio::test]
            async fn repeated_failures_stop() {
                let (harness, provider) = $start().await;
                gives_up_after_repeated_failures(harness, provider).await;
            }

            #[tokio::test]
            async fn rejected_credentials_are_not_retried() {
                let (harness, provider) = $start().await;
                does_not_retry_rejected_credentials(harness, provider).await;
            }

            #[tokio::test]
            async fn unsafe_keys_never_reach_storage() {
                let (harness, provider) = $start().await;
                blocks_unsafe_keys_before_any_request(harness, provider).await;
            }
        }
    };
}

provider_tests!(bunny, Harness::bunny);
provider_tests!(s3, Harness::s3);

#[tokio::test]
async fn bunny_stat_uses_the_stored_sha256() {
    let (harness, provider) = Harness::bunny().await;
    put(&harness, &provider, "images/a.jpg", b"bytes")
        .await
        .unwrap();
    let info: ObjectInfo = provider.stat("images/a.jpg").await.unwrap().unwrap();
    assert_eq!(
        info.sha256.as_deref(),
        Some(hex(&sha256(b"bytes")).as_str())
    );
    assert!(
        !info.matches(5, &hex(&sha256(b"other"))),
        "same size, different content"
    );
}

#[tokio::test]
async fn s3_listing_follows_every_page() {
    let (harness, provider) = Harness::s3().await;
    for name in ["a", "b", "c"] {
        put(&harness, &provider, &format!("images/{name}.jpg"), b"x")
            .await
            .unwrap();
    }
    let listing = provider.list("images").await.unwrap();
    assert_eq!(listing.objects.len(), 3);
}

#[test]
fn plain_http_is_limited_to_loopback() {
    assert!(BunnyClient::new("http://storage.example.com", "zone", PASSWORD).is_err());
    assert!(S3Client::new("http://s3.example.com", true, "b", "de", "a", "s").is_err());
    assert!(BunnyClient::new("http://127.0.0.1:9000", "zone", PASSWORD).is_ok());
}

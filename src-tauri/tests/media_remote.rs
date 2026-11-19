//! Reads CDN image details from a local server that may or may not honor ranges.

use axum::extract::{Request, State};
use axum::response::Response;
use axum::Router;
use posto_lib::media::remote::image_details_with;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

struct Server {
    image: Vec<u8>,
    honor_ranges: AtomicBool,
    requests: AtomicUsize,
}

async fn handler(State(server): State<Arc<Server>>, request: Request) -> Response {
    server.requests.fetch_add(1, Ordering::SeqCst);
    let range = request
        .headers()
        .get("range")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("bytes=0-"))
        .and_then(|end| end.parse::<usize>().ok());
    match range {
        Some(end) if server.honor_ranges.load(Ordering::SeqCst) => {
            let end = end.min(server.image.len() - 1);
            Response::builder()
                .status(206)
                .body(server.image[..=end].to_vec().into())
                .unwrap()
        }
        _ => Response::builder()
            .status(200)
            .body(server.image.clone().into())
            .unwrap(),
    }
}

/// A 40×20 JPEG whose EXIF records a capture date.
fn photo() -> Vec<u8> {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("photo.jpg");
    image::RgbImage::new(40, 20).save(&path).unwrap();
    let jpeg = std::fs::read(path).unwrap();
    let mut tiff = b"II*\0\x08\0\0\0".to_vec();
    tiff.extend([1, 0, 0x69, 0x87, 4, 0, 1, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0]);
    tiff.extend([1, 0, 0x03, 0x90, 2, 0, 20, 0, 0, 0, 44, 0, 0, 0, 0, 0, 0, 0]);
    tiff.extend(b"2026:10:07 13:26:04\0");
    let mut exif = b"Exif\0\0".to_vec();
    exif.extend(tiff);
    let length = u16::try_from(exif.len() + 2).unwrap().to_be_bytes();
    let mut output = jpeg[..2].to_vec();
    output.extend([0xFF, 0xE1, length[0], length[1]]);
    output.extend(exif);
    output.extend(&jpeg[2..]);
    output
}

async fn start(honor_ranges: bool) -> (Arc<Server>, String) {
    let server = Arc::new(Server {
        image: photo(),
        honor_ranges: AtomicBool::new(honor_ranges),
        requests: AtomicUsize::new(0),
    });
    let app = Router::new().fallback(handler).with_state(server.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://{}/photos/harbor.jpg",
        listener.local_addr().unwrap()
    );
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (server, url)
}

#[tokio::test]
async fn the_start_of_the_file_is_usually_enough() {
    let (server, url) = start(true).await;
    let details = image_details_with(&reqwest::Client::new(), &url, true, 64 * 1024)
        .await
        .unwrap();
    assert_eq!(details.capture_date.as_deref(), Some("2026-10-07T13:26:04"));
    assert_eq!(
        details.dimensions.map(|d| (d.width, d.height)),
        Some((40, 20))
    );
    assert_eq!(server.requests.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn reads_the_whole_file_when_the_start_isnt_enough() {
    for honor_ranges in [true, false] {
        let (server, url) = start(honor_ranges).await;
        let details = image_details_with(&reqwest::Client::new(), &url, true, 16)
            .await
            .unwrap();
        assert_eq!(details.capture_date.as_deref(), Some("2026-10-07T13:26:04"));
        assert_eq!(
            details.dimensions.map(|d| (d.width, d.height)),
            Some((40, 20))
        );
        assert_eq!(
            server.requests.load(Ordering::SeqCst),
            2,
            "ranges: {honor_ranges}"
        );
    }
}

#[tokio::test]
async fn a_missing_date_isnt_fetched_when_not_needed() {
    let (server, url) = start(true).await;
    let details = image_details_with(&reqwest::Client::new(), &url, false, 200)
        .await
        .unwrap();
    assert!(details.dimensions.is_some());
    assert_eq!(server.requests.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn only_secure_or_local_urls_are_read() {
    let error = image_details_with(
        &reqwest::Client::new(),
        "http://media.example.com/a.jpg",
        false,
        1024,
    )
    .await
    .unwrap_err();
    assert!(error.contains("HTTPS"), "{error}");
}

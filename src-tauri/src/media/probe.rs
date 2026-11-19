//! Reads the facts Publish needs about a local image without decoding its pixels.

use image::metadata::Orientation;
use image::ImageDecoder;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

/// Enough of an SVG to reach its root element past comments and a doctype.
const SVG_HEADER_BYTES: u64 = 256 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInspection {
    pub sha256: String,
    pub size: u64,
    pub content_type: String,
    /// Display dimensions, or `None` when the format doesn't declare them.
    pub dimensions: Option<Dimensions>,
}

/// Facts about an image that schemas can take values from.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageDetails {
    pub capture_date: Option<String>,
    pub dimensions: Option<Dimensions>,
}

/// Reads an image's capture date and display size without hashing it.
pub fn image_details(path: &Path) -> ImageDetails {
    ImageDetails {
        capture_date: capture_date(path),
        dimensions: image_dimensions(path),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Dimensions {
    pub width: u32,
    pub height: u32,
}

pub fn inspect_file(path: &Path) -> Result<FileInspection, String> {
    let (sha256, size) = file_digest(path)?;
    Ok(FileInspection {
        sha256,
        size,
        content_type: content_type(path).to_string(),
        dimensions: image_dimensions(path),
    })
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// Storage services don't all infer these, and AVIF is the common omission.
pub fn content_type(path: &Path) -> &'static str {
    match extension(path).as_str() {
        "apng" => "image/apng",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "jfif" | "jpeg" | "jpg" | "pjp" | "pjpeg" => "image/jpeg",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "tif" | "tiff" => "image/tiff",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

pub fn bytes_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn file_digest(path: &Path) -> Result<(String, u64), String> {
    let mut file =
        std::fs::File::open(path).map_err(|error| format!("Could not read the image: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 64 * 1024];
    let mut size = 0;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not read the image: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size += read as u64;
    }
    let sha256 = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok((sha256, size))
}

/// When the photo was taken, from its embedded EXIF metadata, as local time in
/// `YYYY-MM-DDTHH:MM:SS` form. EXIF rarely records a time zone, so none is
/// added. Returns `None` when the file carries no usable date.
pub fn capture_date(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let exif = exif::Reader::new()
        .read_from_container(&mut std::io::BufReader::new(file))
        .ok()?;
    exif_capture_date(&exif)
}

fn exif_capture_date(exif: &exif::Exif) -> Option<String> {
    [exif::Tag::DateTimeOriginal, exif::Tag::DateTimeDigitized]
        .into_iter()
        .find_map(|tag| {
            let field = exif.get_field(tag, exif::In::PRIMARY)?;
            let exif::Value::Ascii(values) = &field.value else {
                return None;
            };
            let date = exif::DateTime::from_ascii(values.first()?).ok()?;
            let valid = date.year >= 1800
                && (1..=12).contains(&date.month)
                && (1..=31).contains(&date.day)
                && date.hour < 24
                && date.minute < 60
                && date.second < 61;
            valid.then(|| {
                format!(
                    "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
                    date.year,
                    date.month,
                    date.day,
                    date.hour,
                    date.minute,
                    date.second.min(59)
                )
            })
        })
}

pub fn image_dimensions(path: &Path) -> Option<Dimensions> {
    if extension(path) == "svg" {
        let mut source = String::new();
        std::fs::File::open(path)
            .ok()?
            .take(SVG_HEADER_BYTES)
            .read_to_string(&mut source)
            .ok()?;
        return svg_dimensions(&source);
    }
    let size = imagesize::size(path).ok()?;
    let (width, height) = (
        u32::try_from(size.width).ok()?,
        u32::try_from(size.height).ok()?,
    );
    Some(if rotated_by_metadata(path) {
        Dimensions {
            width: height,
            height: width,
        }
    } else {
        Dimensions { width, height }
    })
}

/// Reads the same details from the start of an image, such as a partial
/// download. Returns what the bytes contain; anything missing stays `None`.
pub fn details_from_bytes(bytes: &[u8]) -> ImageDetails {
    let head = &bytes[..bytes.len().min(SVG_HEADER_BYTES as usize)];
    if let Some(dimensions) = std::str::from_utf8(head).ok().and_then(svg_dimensions) {
        return ImageDetails {
            capture_date: None,
            dimensions: Some(dimensions),
        };
    }
    let exif = exif::Reader::new()
        .read_from_container(&mut std::io::Cursor::new(bytes))
        .ok();
    let rotated = exif.as_ref().is_some_and(exif_rotated);
    let dimensions = imagesize::blob_size(bytes).ok().and_then(|size| {
        let (width, height) = (
            u32::try_from(size.width).ok()?,
            u32::try_from(size.height).ok()?,
        );
        Some(if rotated {
            Dimensions {
                width: height,
                height: width,
            }
        } else {
            Dimensions { width, height }
        })
    });
    ImageDetails {
        capture_date: exif.as_ref().and_then(exif_capture_date),
        dimensions,
    }
}

/// EXIF orientations 5 through 8 turn the image a quarter, swapping its sides.
fn exif_rotated(exif: &exif::Exif) -> bool {
    exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|field| field.value.get_uint(0))
        .is_some_and(|orientation| (5..=8).contains(&orientation))
}

/// Browsers apply EXIF rotation, so a sideways photo displays with swapped sides.
fn rotated_by_metadata(path: &Path) -> bool {
    let decoder = image::ImageReader::open(path)
        .and_then(|reader| reader.with_guessed_format())
        .ok()
        .and_then(|reader| reader.into_decoder().ok());
    decoder
        .and_then(|mut decoder| decoder.orientation().ok())
        .is_some_and(|orientation| {
            matches!(
                orientation,
                Orientation::Rotate90
                    | Orientation::Rotate270
                    | Orientation::Rotate90FlipH
                    | Orientation::Rotate270FlipH
            )
        })
}

fn svg_attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let mut rest = tag;
    while let Some(index) = rest.find(name) {
        let boundary = rest[..index]
            .chars()
            .next_back()
            .is_none_or(char::is_whitespace);
        let after = rest[index + name.len()..].trim_start();
        if let (true, Some(value)) = (boundary, after.strip_prefix('=')) {
            let value = value.trim_start();
            let quote = value.chars().next().filter(|c| *c == '"' || *c == '\'')?;
            let value = &value[1..];
            return value.find(quote).map(|end| &value[..end]);
        }
        rest = &rest[index + name.len()..];
    }
    None
}

fn svg_length(value: &str) -> Option<f64> {
    let number = value.trim().strip_suffix("px").unwrap_or(value.trim());
    number
        .parse()
        .ok()
        .filter(|n: &f64| n.is_finite() && *n > 0.0)
}

fn svg_dimensions(source: &str) -> Option<Dimensions> {
    let start = source.find("<svg")?;
    let tag = &source[start + "<svg".len()..];
    let tag = &tag[..tag.find('>')?];
    let declared = svg_attribute(tag, "width")
        .and_then(svg_length)
        .zip(svg_attribute(tag, "height").and_then(svg_length));
    let (width, height) = declared.or_else(|| {
        let view_box = svg_attribute(tag, "viewBox")?;
        let values: Vec<f64> = view_box
            .split(|c: char| c.is_whitespace() || c == ',')
            .filter(|part| !part.is_empty())
            .map(|part| part.parse().ok())
            .collect::<Option<_>>()?;
        match values[..] {
            [_, _, width, height] if width > 0.0 && height > 0.0 => Some((width, height)),
            _ => None,
        }
    })?;
    Some(Dimensions {
        width: width.round().max(1.0) as u32,
        height: height.round().max(1.0) as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn size(width: u32, height: u32) -> Option<Dimensions> {
        Some(Dimensions { width, height })
    }

    #[test]
    fn reads_svg_dimensions() {
        let cases = [
            (r#"<svg width="640" height="480"></svg>"#, size(640, 480)),
            (r#"<svg width='64px' height='48px'/>"#, size(64, 48)),
            (r#"<svg viewBox="0 0 120 80"/>"#, size(120, 80)),
            (r#"<svg viewBox="0,0,120.4,79.6"/>"#, size(120, 80)),
            (
                r#"<?xml version="1.0"?><!-- x --><svg xmlns="http://www.w3.org/2000/svg"
                   width="100%" height="100%" viewBox="0 0 16 9"></svg>"#,
                size(16, 9),
            ),
            (r#"<svg data-width="9" viewBox="0 0 3 2"/>"#, size(3, 2)),
            (r#"<svg width="2em" height="1em"/>"#, None),
            (r#"<svg viewBox="0 0 0 10"/>"#, None),
            ("<html></html>", None),
        ];
        for (source, expected) in cases {
            assert_eq!(svg_dimensions(source), expected, "{source}");
        }
    }

    /// Inserts an APP1 EXIF segment holding `tiff` after the JPEG start marker.
    fn with_exif(jpeg: &[u8], tiff: &[u8]) -> Vec<u8> {
        let mut exif = b"Exif\0\0".to_vec();
        exif.extend(tiff);
        let length = u16::try_from(exif.len() + 2).unwrap().to_be_bytes();
        let mut output = jpeg[..2].to_vec();
        output.extend([0xFF, 0xE1, length[0], length[1]]);
        output.extend(exif);
        output.extend(&jpeg[2..]);
        output
    }

    fn with_exif_orientation(jpeg: &[u8], orientation: u8) -> Vec<u8> {
        let mut tiff = b"II*\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0".to_vec();
        tiff.extend([orientation, 0, 0, 0, 0, 0, 0, 0]);
        with_exif(jpeg, &tiff)
    }

    /// EXIF holding one date tag (0x9003 original, 0x9004 digitized) in the
    /// Exif sub-IFD that IFD0 points to.
    fn with_exif_date(jpeg: &[u8], tag: u16, date: &[u8; 20]) -> Vec<u8> {
        let mut tiff = b"II*\0\x08\0\0\0".to_vec();
        // IFD0: one entry pointing at the Exif sub-IFD at offset 26.
        tiff.extend([1, 0, 0x69, 0x87, 4, 0, 1, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0]);
        // Exif IFD: one 20-byte ASCII value stored at offset 44.
        let [low, high] = tag.to_le_bytes();
        tiff.extend([1, 0, low, high, 2, 0, 20, 0, 0, 0, 44, 0, 0, 0, 0, 0, 0, 0]);
        tiff.extend(date);
        with_exif(jpeg, &tiff)
    }

    #[test]
    fn reads_details_from_partial_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wide.jpg");
        image::RgbImage::new(40, 20).save(&path).unwrap();
        let jpeg = std::fs::read(&path).unwrap();

        let dated = with_exif_date(&jpeg, 0x9003, b"2026:10:07 13:26:04\0");
        let details = details_from_bytes(&dated);
        assert_eq!(details.capture_date.as_deref(), Some("2026-10-07T13:26:04"));
        assert_eq!(details.dimensions, size(40, 20));

        let sideways = details_from_bytes(&with_exif_orientation(&jpeg, 6));
        assert_eq!(sideways.dimensions, size(20, 40));

        let truncated = details_from_bytes(&dated[..dated.len() / 2]);
        assert_eq!(
            truncated.dimensions,
            size(40, 20),
            "the size is in the header"
        );

        let svg = details_from_bytes(br#"<svg viewBox="0 0 30 10"></svg>"#);
        assert_eq!(svg.dimensions, size(30, 10));
        assert_eq!(details_from_bytes(b"not an image").dimensions, None);
    }

    #[test]
    fn reads_capture_dates() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("plain.jpg");
        image::RgbImage::new(4, 4).save(&plain).unwrap();
        let bytes = std::fs::read(&plain).unwrap();
        assert_eq!(capture_date(&plain), None, "no EXIF");

        let cases: [(u16, &[u8; 20], Option<&str>); 4] = [
            (
                0x9003,
                b"2026:10:07 13:26:04\0",
                Some("2026-10-07T13:26:04"),
            ),
            (
                0x9004,
                b"2025:01:02 03:04:05\0",
                Some("2025-01-02T03:04:05"),
            ),
            (0x9003, b"0000:00:00 00:00:00\0", None),
            (0x9003, b"    :  :     :  :  \0", None),
        ];
        for (index, (tag, date, expected)) in cases.into_iter().enumerate() {
            let path = dir.path().join(format!("dated-{index}.jpg"));
            std::fs::write(&path, with_exif_date(&bytes, tag, date)).unwrap();
            assert_eq!(capture_date(&path).as_deref(), expected, "{date:?}");
        }
        assert_eq!(capture_date(&dir.path().join("missing.jpg")), None);
    }

    #[test]
    fn inspects_images_and_applies_exif_rotation() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("wide.PNG");
        image::RgbImage::new(40, 20)
            .save_with_format(&png, image::ImageFormat::Png)
            .unwrap();
        let inspected = inspect_file(&png).unwrap();
        assert_eq!(inspected.dimensions, size(40, 20));
        assert_eq!(inspected.content_type, "image/png");
        assert_eq!(inspected.size, std::fs::metadata(&png).unwrap().len());

        let plain = dir.path().join("plain.jpg");
        image::RgbImage::new(40, 20).save(&plain).unwrap();
        let bytes = std::fs::read(&plain).unwrap();
        assert_eq!(image_dimensions(&plain), size(40, 20));

        let sideways = dir.path().join("sideways.jpg");
        std::fs::write(&sideways, with_exif_orientation(&bytes, 6)).unwrap();
        assert_eq!(image_dimensions(&sideways), size(20, 40));

        let upside_down = dir.path().join("upside-down.jpg");
        std::fs::write(&upside_down, with_exif_orientation(&bytes, 3)).unwrap();
        assert_eq!(image_dimensions(&upside_down), size(40, 20));
    }

    #[test]
    fn digests_match_known_sha256() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.bin");
        std::fs::write(&path, "abc").unwrap();
        assert_eq!(
            file_digest(&path).unwrap(),
            (
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".to_string(),
                3
            )
        );
    }

    #[test]
    fn unreadable_images_have_no_dimensions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken.png");
        std::fs::write(&path, "not an image").unwrap();
        assert_eq!(image_dimensions(&path), None);
        assert_eq!(content_type(Path::new("photo.AVIF")), "image/avif");
        assert_eq!(
            content_type(Path::new("archive.zip")),
            "application/octet-stream"
        );
    }
}

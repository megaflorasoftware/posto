//! Reads the facts Publish needs about a local image without decoding its pixels.

use image::metadata::Orientation;
use image::ImageDecoder;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

/// Enough of an SVG to reach its root element past comments and a doctype.
const SVG_HEADER_BYTES: u64 = 256 * 1024;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInspection {
    pub sha256: String,
    pub size: u64,
    pub content_type: String,
    /// Display dimensions, or `None` when the format doesn't declare them.
    pub dimensions: Option<Dimensions>,
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

    /// Inserts an EXIF block declaring `orientation` after the JPEG start marker.
    fn with_exif_orientation(jpeg: &[u8], orientation: u8) -> Vec<u8> {
        let mut exif = b"Exif\0\0II*\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0".to_vec();
        exif.extend([orientation, 0, 0, 0, 0, 0, 0, 0]);
        let length = u16::try_from(exif.len() + 2).unwrap().to_be_bytes();
        let mut output = jpeg[..2].to_vec();
        output.extend([0xFF, 0xE1, length[0], length[1]]);
        output.extend(exif);
        output.extend(&jpeg[2..]);
        output
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

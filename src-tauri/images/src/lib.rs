//! Decodes, resizes and encodes images. The app's settings and naming live in
//! `posto::media::derive`; this crate only does the pixel work.

use base64::Engine;
use fast_image_resize::{images::Image, PixelType, ResizeOptions, Resizer};
pub use image::DynamicImage;
use image::{ImageDecoder, ImageReader};
use std::io::Cursor;
use std::path::Path;

/// Placeholders are shown blurred and stretched, so a few pixels are enough.
pub const PLACEHOLDER_WIDTH: u32 = 24;
const PLACEHOLDER_QUALITY: u8 = 30;
/// WebP can't store larger images.
pub const MAX_DIMENSION: u32 = 16_383;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Webp,
    Jpeg,
}

/// Decodes an image and turns it the way its camera recorded, since the
/// copies carry no EXIF data for browsers to rotate them by.
pub fn decode(path: &Path) -> Result<DynamicImage, String> {
    let reader = ImageReader::open(path)
        .and_then(|reader| reader.with_guessed_format())
        .map_err(|error| format!("Could not read the image: {error}"))?;
    decode_from(reader)
}

/// Like [`decode`], for an image already in memory, such as a download.
pub fn decode_bytes(bytes: &[u8]) -> Result<DynamicImage, String> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| format!("Could not read the image: {error}"))?;
    decode_from(reader)
}

fn decode_from<R: std::io::BufRead + std::io::Seek>(
    reader: ImageReader<R>,
) -> Result<DynamicImage, String> {
    let unreadable = |error: &dyn std::fmt::Display| format!("Could not read the image: {error}");
    let mut decoder = reader.into_decoder().map_err(|error| unreadable(&error))?;
    let orientation = decoder.orientation().map_err(|error| unreadable(&error))?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(|error| unreadable(&error))?;
    image.apply_orientation(orientation);
    Ok(normalized(image))
}

/// 8-bit RGB, or RGBA when the image has transparency.
fn normalized(image: DynamicImage) -> DynamicImage {
    match image {
        DynamicImage::ImageRgb8(_) | DynamicImage::ImageRgba8(_) => image,
        image if image.color().has_alpha() => DynamicImage::ImageRgba8(image.into_rgba8()),
        image => DynamicImage::ImageRgb8(image.into_rgb8()),
    }
}

fn resize(image: &DynamicImage, width: u32, height: u32) -> Result<DynamicImage, String> {
    if image.width() == width && image.height() == height {
        return Ok(image.clone());
    }
    let (pixel_type, alpha) = match image {
        DynamicImage::ImageRgba8(_) => (PixelType::U8x4, true),
        _ => (PixelType::U8x3, false),
    };
    let mut target = Image::new(width, height, pixel_type);
    Resizer::new()
        .resize(image, &mut target, &ResizeOptions::new())
        .map_err(|error| format!("Could not resize the image: {error}"))?;
    let pixels = target.into_vec();
    let resized = if alpha {
        image::RgbaImage::from_raw(width, height, pixels).map(DynamicImage::ImageRgba8)
    } else {
        image::RgbImage::from_raw(width, height, pixels).map(DynamicImage::ImageRgb8)
    };
    resized.ok_or_else(|| "Could not resize the image".to_string())
}

fn encode(image: &DynamicImage, format: Format, quality: u8) -> Result<Vec<u8>, String> {
    match format {
        Format::Webp => {
            let encoder = match image {
                DynamicImage::ImageRgba8(pixels) => {
                    webp::Encoder::from_rgba(pixels.as_raw(), image.width(), image.height())
                }
                _ => webp::Encoder::from_rgb(image.as_bytes(), image.width(), image.height()),
            };
            encoder
                .encode_simple(false, f32::from(quality))
                .map(|memory| memory.to_vec())
                .map_err(|error| format!("Could not encode the image as WebP: {error:?}"))
        }
        Format::Jpeg => {
            let mut bytes = Vec::new();
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality);
            // JPEG has no transparency, so drop it.
            DynamicImage::ImageRgb8(image.to_rgb8())
                .write_with_encoder(encoder)
                .map_err(|error| format!("Could not encode the image as JPEG: {error}"))?;
            Ok(bytes)
        }
    }
}

/// Makes one size of an already decoded image.
pub fn render(
    image: &DynamicImage,
    width: u32,
    height: u32,
    format: Format,
    quality: u8,
) -> Result<Vec<u8>, String> {
    encode(&resize(image, width, height)?, format, quality)
}

/// A tiny WebP of the image as a `data:` URI, ready to use as a background
/// while the real image loads.
pub fn placeholder(image: &DynamicImage) -> Result<String, String> {
    let height = ((u64::from(PLACEHOLDER_WIDTH) * u64::from(image.height()))
        .div_ceil(u64::from(image.width().max(1))))
    .clamp(1, u64::from(MAX_DIMENSION)) as u32;
    let small = resize(image, PLACEHOLDER_WIDTH, height)?;
    let bytes = encode(&small, Format::Webp, PLACEHOLDER_QUALITY)?;
    Ok(format!(
        "data:image/webp;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// Reads a decoded image back, for checking output in tests.
#[doc(hidden)]
pub fn read(bytes: &[u8]) -> Result<DynamicImage, String> {
    ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| error.to_string())?
        .decode()
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_each_size_in_the_requested_format() {
        let image = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            400,
            200,
            image::Rgb([200, 40, 40]),
        ));
        for format in [Format::Webp, Format::Jpeg] {
            let small = read(&render(&image, 100, 50, format, 80).unwrap()).unwrap();
            assert_eq!((small.width(), small.height()), (100, 50), "{format:?}");
            let large = read(&render(&image, 300, 150, format, 80).unwrap()).unwrap();
            let pixel = large.to_rgb8().get_pixel(150, 75).0;
            assert!(
                pixel[0] > 150 && pixel[1] < 90,
                "{format:?} kept the color: {pixel:?}"
            );
        }
    }

    #[test]
    fn keeps_transparency_in_webp() {
        let image = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            40,
            40,
            image::Rgba([0, 0, 0, 0]),
        ));
        let bytes = render(&image, 20, 20, Format::Webp, 80).unwrap();
        assert!(read(&bytes).unwrap().color().has_alpha());
    }

    #[test]
    fn applies_the_camera_rotation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sideways.jpg");
        image::RgbImage::new(40, 20).save(&path).unwrap();
        let jpeg = std::fs::read(&path).unwrap();
        // EXIF orientation 6: the camera was turned a quarter.
        let mut tiff = b"MM\0*\0\0\0\x08".to_vec();
        tiff.extend([0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
        let mut exif = b"Exif\0\0".to_vec();
        exif.extend(tiff);
        let length = u16::try_from(exif.len() + 2).unwrap().to_be_bytes();
        let mut rotated = jpeg[..2].to_vec();
        rotated.extend([0xFF, 0xE1, length[0], length[1]]);
        rotated.extend(exif);
        rotated.extend(&jpeg[2..]);
        std::fs::write(&path, &rotated).unwrap();

        let image = decode(&path).unwrap();
        assert_eq!((image.width(), image.height()), (20, 40));
        let image = decode_bytes(&rotated).unwrap();
        assert_eq!((image.width(), image.height()), (20, 40));
    }

    #[test]
    fn placeholders_are_tiny_data_uris() {
        let image = DynamicImage::ImageRgb8(image::RgbImage::new(4128, 6192));
        let uri = placeholder(&image).unwrap();
        let encoded = uri.strip_prefix("data:image/webp;base64,").unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let small = read(&bytes).unwrap();
        assert_eq!((small.width(), small.height()), (24, 36));
        assert!(uri.len() < 1_000, "{} bytes", uri.len());
    }
}

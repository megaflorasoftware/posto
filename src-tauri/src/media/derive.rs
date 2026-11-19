//! The smaller copies of an image that a site serves instead of the original:
//! resized sizes uploaded next to it, and a tiny placeholder stored in its
//! library entry. The pixel work is in the `posto-images` crate.

use serde::Deserialize;

pub use posto_images::{decode, decode_bytes, placeholder, read, DynamicImage};
use posto_images::{Format, MAX_DIMENSION};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DerivedFormat {
    Webp,
    Jpeg,
}

impl DerivedFormat {
    pub fn content_type(self) -> &'static str {
        match self {
            Self::Webp => "image/webp",
            Self::Jpeg => "image/jpeg",
        }
    }

    fn format(self) -> Format {
        match self {
            Self::Webp => Format::Webp,
            Self::Jpeg => Format::Jpeg,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedSize {
    pub key: String,
    pub width: u32,
    pub height: u32,
}

/// The sizes to make from one original, all in one format and quality.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedSet {
    pub format: DerivedFormat,
    pub quality: u8,
    pub sizes: Vec<DerivedSize>,
}

impl DerivedSet {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=100).contains(&self.quality) {
            return Err(format!(
                "Image quality {} isn't between 1 and 100",
                self.quality
            ));
        }
        for size in &self.sizes {
            let valid = |side: u32| (1..=MAX_DIMENSION).contains(&side);
            if !valid(size.width) || !valid(size.height) {
                return Err(format!(
                    "{} has an unsupported size, {}×{}",
                    size.key, size.width, size.height
                ));
            }
        }
        Ok(())
    }
}

/// Makes each requested size from an already decoded image.
pub fn render(
    image: &DynamicImage,
    set: &DerivedSet,
    sizes: &[&DerivedSize],
) -> Result<Vec<Vec<u8>>, String> {
    sizes
        .iter()
        .map(|size| {
            posto_images::render(
                image,
                size.width,
                size.height,
                set.format.format(),
                set.quality,
            )
        })
        .collect()
}

/// Whether `candidate` is a size made from the object at `original`. Sizes
/// share the original's name, then add `-<width>w-q<quality>`.
pub fn is_derived_from(original: &str, candidate: &str) -> bool {
    let Some((base, _)) = original.rsplit_once('.') else {
        return false;
    };
    let Some(rest) = candidate
        .strip_prefix(base)
        .and_then(|rest| rest.strip_prefix('-'))
    else {
        return false;
    };
    let Some((name, extension)) = rest.rsplit_once('.') else {
        return false;
    };
    let Some((width, quality)) = name.split_once("w-q") else {
        return false;
    };
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    digits(width) && digits(quality) && matches!(extension, "webp" | "jpg")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn size(key: &str, width: u32, height: u32) -> DerivedSize {
        DerivedSize {
            key: key.to_string(),
            width,
            height,
        }
    }

    #[test]
    fn renders_the_set_in_its_format() {
        let image = DynamicImage::ImageRgb8(posto_images_rgb(80, 40));
        let set = DerivedSet {
            format: DerivedFormat::Jpeg,
            quality: 80,
            sizes: vec![size("a", 20, 10), size("b", 40, 20)],
        };
        let sizes: Vec<_> = set.sizes.iter().collect();
        let rendered = render(&image, &set, &sizes).unwrap();
        assert_eq!(&rendered[0][..2], &[0xFF, 0xD8], "JPEG");
        let second = read(&rendered[1]).unwrap();
        assert_eq!((second.width(), second.height()), (40, 20));
    }

    fn posto_images_rgb(width: u32, height: u32) -> image::RgbImage {
        image::RgbImage::new(width, height)
    }

    #[test]
    fn recognizes_sizes_of_an_original() {
        let original = "photo/R0001-83d51944.jpg";
        assert!(is_derived_from(
            original,
            "photo/R0001-83d51944-1600w-q80.webp"
        ));
        assert!(is_derived_from(
            original,
            "photo/R0001-83d51944-480w-q75.jpg"
        ));
        assert!(!is_derived_from(original, original));
        assert!(!is_derived_from(original, "photo/R0001-83d51944-x.webp"));
        assert!(!is_derived_from(
            original,
            "photo/R0001-83d51944-1600w-q80.png"
        ));
        assert!(!is_derived_from(
            original,
            "photo/R0001-83d51945-1600w-q80.webp"
        ));
        assert!(!is_derived_from(
            original,
            "photo/R0001-83d51944-1600w-q80/a.webp"
        ));
    }

    #[test]
    fn rejects_bad_settings() {
        let mut bad = DerivedSet {
            format: DerivedFormat::Webp,
            quality: 80,
            sizes: vec![size("a", 0, 10)],
        };
        assert!(bad.validate().is_err());
        bad.sizes = vec![size("a", 10, 10)];
        bad.quality = 0;
        assert!(bad.validate().is_err());
        bad.quality = 80;
        assert!(bad.validate().is_ok());
    }
}

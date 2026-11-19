//! Fills in what images published before a source had sizes are missing.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use super::blocking;
use super::derive::{self, DerivedSet};
use super::provider::Provider;
use super::publish::{check_source_key, missing_sizes, put_sizes, validate_derived, PublishSource};
use super::remote;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDeriveRequest {
    pub source: PublishSource,
    /// The original's object key.
    pub key: String,
    /// Where the original can be downloaded.
    pub url: String,
    #[serde(default)]
    pub derived: Option<DerivedSet>,
    #[serde(default)]
    pub placeholder: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDerived {
    pub placeholder: Option<String>,
    /// How many sizes had to be made and uploaded.
    pub uploaded: usize,
}

pub async fn derive_remote(
    request: RemoteDeriveRequest,
    provider: &Provider,
) -> Result<RemoteDerived, String> {
    check_source_key(&request.source, &request.key)?;
    let missing = match &request.derived {
        Some(set) => {
            validate_derived(&request.key, set, |key| {
                check_source_key(&request.source, key)
            })?;
            let listed: HashSet<String> = match provider {
                Provider::Bunny(_) => {
                    let folder = request
                        .key
                        .rsplit_once('/')
                        .map_or("", |(folder, _)| folder);
                    let listing = provider.list(folder).await?;
                    listing
                        .objects
                        .into_iter()
                        .map(|object| object.key)
                        .collect()
                }
                Provider::S3(_) => HashSet::new(),
            };
            missing_sizes(provider, set, |key| listed.contains(key)).await?
        }
        None => Vec::new(),
    };
    if missing.is_empty() && !request.placeholder {
        return Ok(RemoteDerived::default());
    }
    let original = remote::download_image(&request.url).await?;
    let settings = request.derived.clone();
    let wants_placeholder = request.placeholder;
    let (rendered, placeholder) = blocking(move || {
        let image = derive::decode_bytes(&original)?;
        let rendered = match &settings {
            Some(set) if !missing.is_empty() => {
                let sizes: Vec<_> = missing.iter().collect();
                let bytes = derive::render(&image, set, &sizes)?;
                missing.into_iter().zip(bytes).collect()
            }
            _ => Vec::new(),
        };
        let placeholder = wants_placeholder
            .then(|| derive::placeholder(&image))
            .transpose()?;
        Ok((rendered, placeholder))
    })
    .await?;
    if let Some(set) = &request.derived {
        put_sizes(provider, set, &rendered).await?;
    }
    Ok(RemoteDerived {
        placeholder,
        uploaded: rendered.len(),
    })
}

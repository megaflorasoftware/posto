use std::path::PathBuf;

use crate::{Error, Result};

/// The app's own directories. Tauri derives them from the bundle identifier;
/// here the host app supplies them (on iOS, its sandbox containers).
#[derive(Clone, Debug, Default)]
pub struct AppDirs {
    pub data: Option<PathBuf>,
    pub cache: Option<PathBuf>,
    pub config: Option<PathBuf>,
}

/// Resolves the app's directories. One the host left unset resolves to
/// [`Error::UnknownPath`], as an unknown base directory does in Tauri.
#[derive(Clone, Debug)]
pub struct PathResolver {
    dirs: AppDirs,
}

impl PathResolver {
    pub(crate) fn new(dirs: AppDirs) -> Self {
        Self { dirs }
    }

    pub fn app_data_dir(&self) -> Result<PathBuf> {
        self.dirs.data.clone().ok_or(Error::UnknownPath)
    }

    pub fn app_cache_dir(&self) -> Result<PathBuf> {
        self.dirs.cache.clone().ok_or(Error::UnknownPath)
    }

    pub fn app_config_dir(&self) -> Result<PathBuf> {
        self.dirs.config.clone().ok_or(Error::UnknownPath)
    }
}

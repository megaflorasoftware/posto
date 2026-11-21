//! Posto's backend for the native iOS app: the Tauri app's own command
//! modules, compiled unchanged, behind the C ABI in
//! `include/posto_native.h`.

// The modules come straight from src-tauri/src and build against the `tauri`
// stand-in in tauri-shim/. A `#[path]` on this inline module resolves them as
// src-tauri/src/lib.rs does (`auth.rs` finds `auth/storage.rs`); a `#[path]`
// on each file would not, since rustc treats every `#[path]` file as a
// `mod.rs`. The `use`s below put them at the crate root, where their own
// `crate::...` paths look for each other.
//
// Like src-tauri's mobile build, this leaves out browser.rs (Swift opens
// pages itself) and the desktop-only devserver, env, proxy and watch. The
// `desktop` feature builds src-tauri's desktop module set instead, for the
// macOS app.
#[path = "../../../../src-tauri/src"]
#[doc(hidden)]
pub mod backend {
    pub(crate) mod auth;
    #[cfg(desktop)]
    pub(crate) mod devserver;
    #[cfg(desktop)]
    pub(crate) mod env;
    pub(crate) mod fs;
    pub mod git;
    pub mod media;
    #[cfg(desktop)]
    pub(crate) mod proxy;
    #[cfg(mobile)]
    pub(crate) mod repos;
    pub(crate) mod secrets;
    pub(crate) mod settings;
    #[cfg(desktop)]
    pub(crate) mod watch;
    // Its file-change helper is used only by the desktop watcher.
    #[cfg_attr(mobile, allow(dead_code))]
    pub(crate) mod workspace;
}

#[cfg(mobile)]
use backend::repos;
use backend::{auth, fs, secrets, settings, workspace};
#[cfg(desktop)]
use backend::{devserver, env, proxy, watch};
pub use backend::{git, media};

mod abi;
mod commands;

pub use abi::{posto_init, posto_invoke, PostoEventCallback, PostoResponseCallback};
pub use commands::{Command, COMMANDS};

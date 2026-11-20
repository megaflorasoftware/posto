//! Stands in for the `tauri` crate so Posto's backend modules in
//! `src-tauri/src` compile unchanged inside the native iOS app, which has no
//! webview. Only the API those modules use is here, with Tauri's signatures:
//! an [`AppHandle`] whose path resolver returns directories the host app
//! chose, events that go to a host callback instead of a webview, managed
//! [`State`], IPC channels, and Tauri's global async runtime.

pub mod async_runtime;
pub mod ipc;
pub mod path;

use serde::Serialize;
use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::fmt;
use std::ops::Deref;
use std::sync::Arc;

pub use path::{AppDirs, PathResolver};
pub use posto_tauri_shim_macros::command;

pub type Result<T> = std::result::Result<T, Error>;

/// The subset of `tauri::Error` this shim can produce, with Tauri's messages.
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    /// A task on the async runtime panicked or was cancelled.
    JoinError(tokio::task::JoinError),
    /// The host app configured no directory for the requested base path.
    UnknownPath,
    /// An event name with characters Tauri rejects.
    IllegalEventName(String),
    /// A payload failed to serialize.
    Json(serde_json::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::JoinError(error) => error.fmt(f),
            Self::UnknownPath => f.write_str("unknown path"),
            Self::IllegalEventName(name) => write!(
                f,
                "only alphanumeric, '-', '/', ':', '_' permitted for event names: {name:?}"
            ),
            Self::Json(error) => write!(f, "JSON error: {error}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::JoinError(error) => Some(error),
            Self::Json(error) => Some(error),
            Self::UnknownPath | Self::IllegalEventName(_) => None,
        }
    }
}

impl From<tokio::task::JoinError> for Error {
    fn from(error: tokio::task::JoinError) -> Self {
        Self::JoinError(error)
    }
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

type EventSink = dyn Fn(&str, &str) + Send + Sync;
type StateMap = HashMap<TypeId, Box<dyn Any + Send + Sync>>;

/// Builds the one [`AppHandle`] a host app uses. Tauri derives the app's
/// directories from its bundle config and sends events to webviews; here the
/// host supplies both.
#[derive(Default)]
pub struct Builder {
    dirs: AppDirs,
    on_event: Option<Box<EventSink>>,
    states: StateMap,
}

impl Builder {
    /// The directories `app.path()` resolves.
    pub fn dirs(mut self, dirs: AppDirs) -> Self {
        self.dirs = dirs;
        self
    }

    /// Receives every event the app emits: its name and JSON payload, on
    /// whichever thread emitted it.
    pub fn on_event(mut self, on_event: impl Fn(&str, &str) + Send + Sync + 'static) -> Self {
        self.on_event = Some(Box::new(on_event));
        self
    }

    /// Adds a value that commands receive as `State<'_, T>`.
    ///
    /// # Panics
    ///
    /// When a value of the same type is already managed, as in Tauri.
    pub fn manage<T: Send + Sync + 'static>(mut self, state: T) -> Self {
        let previous = self.states.insert(TypeId::of::<T>(), Box::new(state));
        assert!(
            previous.is_none(),
            "state for type '{}' is already being managed",
            std::any::type_name::<T>()
        );
        self
    }

    pub fn build(self) -> AppHandle {
        AppHandle {
            inner: Arc::new(AppInner {
                path: PathResolver::new(self.dirs),
                on_event: self.on_event.unwrap_or_else(|| Box::new(|_, _| {})),
                states: self.states,
            }),
        }
    }
}

struct AppInner {
    path: PathResolver,
    on_event: Box<EventSink>,
    // Fixed at build time, so `State` can borrow from it without a lock.
    states: StateMap,
}

/// A cheap, cloneable reference to the running app.
#[derive(Clone)]
pub struct AppHandle {
    inner: Arc<AppInner>,
}

impl fmt::Debug for AppHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AppHandle")
            .field("path", &self.inner.path)
            .finish_non_exhaustive()
    }
}

impl AppHandle {
    /// Delivers an already-serialized payload.
    pub(crate) fn emit_json(&self, event: &str, payload: &str) -> Result<()> {
        if !event
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '/' | ':' | '_'))
        {
            return Err(Error::IllegalEventName(event.to_string()));
        }
        (self.inner.on_event)(event, payload);
        Ok(())
    }
}

/// Emits events to the host app.
pub trait Emitter {
    /// Serializes `payload` to JSON and hands it, with `event`, to the
    /// host's event callback before returning.
    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) -> Result<()>;
}

impl Emitter for AppHandle {
    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) -> Result<()> {
        self.emit_json(event, &serde_json::to_string(&payload)?)
    }
}

/// App-wide accessors, as on Tauri's `Manager`.
pub trait Manager {
    fn path(&self) -> &PathResolver;

    /// # Panics
    ///
    /// When no value of type `T` is managed, as in Tauri.
    fn state<T: Send + Sync + 'static>(&self) -> State<'_, T> {
        self.try_state().unwrap_or_else(|| {
            panic!(
                "state() called before manage() for {}",
                std::any::type_name::<T>()
            )
        })
    }

    fn try_state<T: Send + Sync + 'static>(&self) -> Option<State<'_, T>>;
}

impl Manager for AppHandle {
    fn path(&self) -> &PathResolver {
        &self.inner.path
    }

    fn try_state<T: Send + Sync + 'static>(&self) -> Option<State<'_, T>> {
        self.inner
            .states
            .get(&TypeId::of::<T>())
            .and_then(|state| state.downcast_ref())
            .map(State)
    }
}

/// A managed value, borrowed from the app.
pub struct State<'r, T: Send + Sync + 'static>(&'r T);

impl<'r, T: Send + Sync + 'static> State<'r, T> {
    pub fn inner(&self) -> &'r T {
        self.0
    }
}

impl<T: Send + Sync + 'static> Deref for State<'_, T> {
    type Target = T;

    fn deref(&self) -> &T {
        self.0
    }
}

impl<T: Send + Sync + 'static> Clone for State<'_, T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T: Send + Sync + 'static> Copy for State<'_, T> {}

impl<T: Send + Sync + 'static + fmt::Debug> fmt::Debug for State<'_, T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("State").field(self.0).finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Counter(Mutex<u32>);

    type Events = Arc<Mutex<Vec<(String, String)>>>;

    fn recording_app() -> (AppHandle, Events) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let app = Builder::default()
            .dirs(AppDirs {
                data: Some("/data".into()),
                ..AppDirs::default()
            })
            .on_event(move |event, payload| {
                sink.lock()
                    .unwrap()
                    .push((event.to_string(), payload.to_string()));
            })
            .manage(Counter::default())
            .build();
        (app, events)
    }

    #[test]
    fn emit_serializes_payloads_for_the_host() {
        let (app, events) = recording_app();
        app.emit("fs-changed", vec!["/repo"]).unwrap();
        app.emit("open-file", ()).unwrap();
        assert_eq!(
            *events.lock().unwrap(),
            [
                ("fs-changed".to_string(), r#"["/repo"]"#.to_string()),
                ("open-file".to_string(), "null".to_string()),
            ]
        );
    }

    #[test]
    fn emit_rejects_names_tauri_rejects() {
        let (app, events) = recording_app();
        let error = app.emit("bad name", ()).unwrap_err();
        assert!(matches!(error, Error::IllegalEventName(_)));
        assert!(events.lock().unwrap().is_empty());
    }

    #[test]
    fn unset_directories_are_unknown_paths() {
        let (app, _) = recording_app();
        assert_eq!(
            app.path().app_data_dir().unwrap(),
            std::path::Path::new("/data")
        );
        assert!(matches!(
            app.path().app_cache_dir(),
            Err(Error::UnknownPath)
        ));
    }

    #[test]
    fn managed_state_is_shared_by_clones() {
        let (app, _) = recording_app();
        let counter: &Counter = &app.state::<Counter>();
        *counter.0.lock().unwrap() += 1;
        let clone = app.clone();
        assert_eq!(*clone.state::<Counter>().inner().0.lock().unwrap(), 1);
        assert!(app.try_state::<String>().is_none());
    }

    #[test]
    #[should_panic(expected = "already being managed")]
    fn managing_a_type_twice_panics() {
        let _ = Builder::default().manage(1u8).manage(2u8);
    }
}

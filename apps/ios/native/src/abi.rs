//! The C ABI declared in `include/posto_native.h`.

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::PathBuf;
use std::sync::OnceLock;

use serde::Deserialize;
use tauri::{AppDirs, AppHandle};

use crate::commands;

pub type PostoResponseCallback =
    extern "C" fn(context: *mut c_void, request_id: u64, response_json: *const c_char);
pub type PostoEventCallback =
    extern "C" fn(context: *mut c_void, event: *const c_char, payload_json: *const c_char);

const INIT_OK: i32 = 0;
const INIT_INVALID_CONFIG: i32 = 1;
const INIT_ALREADY_INITIALIZED: i32 = 2;

static APP: OnceLock<AppHandle> = OnceLock::new();

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    data_dir: Option<PathBuf>,
    cache_dir: Option<PathBuf>,
    config_dir: Option<PathBuf>,
}

/// A host pointer passed back to the host's callbacks untouched. The host
/// owns it and promises its callbacks can run on any thread.
#[derive(Clone, Copy)]
struct HostContext(*mut c_void);

// SAFETY: never dereferenced here, only handed back to the host, which is
// responsible for its thread safety.
unsafe impl Send for HostContext {}
unsafe impl Sync for HostContext {}

impl HostContext {
    fn get(self) -> *mut c_void {
        self.0
    }
}

/// Starts the engine. `config_json` names the app's directories:
/// `{"dataDir": ..., "cacheDir": ..., "configDir": ...}`. Returns 0 on
/// success, 1 for a missing or invalid config, and 2 when already started
/// (the first configuration stays in effect).
///
/// # Safety
///
/// `config_json` must be null or a valid NUL-terminated string. `on_event`
/// is called with `event_context` from any thread for as long as the process
/// runs; both must stay valid that long.
#[no_mangle]
pub unsafe extern "C" fn posto_init(
    config_json: *const c_char,
    on_event: Option<PostoEventCallback>,
    event_context: *mut c_void,
) -> i32 {
    let Some(config) =
        c_str(config_json).and_then(|json| serde_json::from_str::<Config>(json).ok())
    else {
        return INIT_INVALID_CONFIG;
    };
    let context = HostContext(event_context);
    let mut started = false;
    APP.get_or_init(|| {
        started = true;
        let dirs = AppDirs {
            data: config.data_dir,
            cache: config.cache_dir,
            config: config.config_dir,
        };
        commands::build_app(dirs, move |event, payload| {
            let Some(on_event) = on_event else {
                return;
            };
            // Event names are validated and payloads are JSON, which escapes
            // NUL, so neither can contain one.
            let (Ok(event), Ok(payload)) = (CString::new(event), CString::new(payload)) else {
                return;
            };
            on_event(context.get(), event.as_ptr(), payload.as_ptr());
        })
    });
    if started {
        INIT_OK
    } else {
        INIT_ALREADY_INITIALIZED
    }
}

/// Runs a command without blocking the caller. `callback` fires exactly once,
/// on any thread, with `{"ok": <value>}` or `{"error": "<message>"}`; the
/// string is valid only during the callback.
///
/// # Safety
///
/// `command` and `args_json` must be null or valid NUL-terminated strings for
/// the duration of this call. `context` must stay valid until `callback`
/// fires.
#[no_mangle]
pub unsafe extern "C" fn posto_invoke(
    request_id: u64,
    command: *const c_char,
    args_json: *const c_char,
    callback: Option<PostoResponseCallback>,
    context: *mut c_void,
) {
    let responder = Responder {
        request_id,
        callback,
        context: HostContext(context),
        responded: false,
    };
    // The pointers are only valid during this call.
    let command = c_str(command).map(str::to_string);
    let args_json = if args_json.is_null() {
        Some(String::new())
    } else {
        c_str(args_json).map(str::to_string)
    };
    tauri::async_runtime::spawn(async move {
        let response = match (APP.get(), command, args_json) {
            (None, ..) => commands::error_json("posto_init must be called before posto_invoke"),
            (_, None, _) => commands::error_json("command must be a UTF-8 string"),
            (_, _, None) => commands::error_json("args_json must be a UTF-8 string"),
            (Some(app), Some(command), Some(args_json)) => {
                commands::invoke(app.clone(), command, &args_json).await
            }
        };
        responder.respond(&response);
    });
}

/// Delivers one response. Dropping it unanswered (if its task were
/// cancelled) still answers, so the callback fires exactly once.
struct Responder {
    request_id: u64,
    callback: Option<PostoResponseCallback>,
    context: HostContext,
    responded: bool,
}

impl Responder {
    fn respond(mut self, response: &str) {
        self.send(response);
    }

    fn send(&mut self, response: &str) {
        if std::mem::replace(&mut self.responded, true) {
            return;
        }
        let Some(callback) = self.callback else {
            return;
        };
        let response = CString::new(response).unwrap_or_else(|_| {
            CString::new(commands::error_json("response contained a NUL byte")).unwrap()
        });
        callback(self.context.get(), self.request_id, response.as_ptr());
    }
}

impl Drop for Responder {
    fn drop(&mut self) {
        self.send(&commands::error_json("the command was cancelled"));
    }
}

/// # Safety
///
/// `ptr` must be null or a valid NUL-terminated string.
unsafe fn c_str<'a>(ptr: *const c_char) -> Option<&'a str> {
    if ptr.is_null() {
        return None;
    }
    CStr::from_ptr(ptr).to_str().ok()
}

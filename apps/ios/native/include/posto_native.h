// Posto's Rust engine: the Tauri app's backend commands behind a C ABI that
// mirrors Tauri's `invoke(command, args)`. Implemented in
// apps/ios/native/src/abi.rs.

#ifndef POSTO_NATIVE_H
#define POSTO_NATIVE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Receives the result of one posto_invoke call. `response_json` is
// {"ok": <the command's return value>} or {"error": "<message>"}, and is valid
// only during the callback.
typedef void (*PostoResponseCallback)(void *context, uint64_t request_id, const char *response_json);

// Receives every event the engine emits, under the names the app uses today
// ("clone-progress", "auth-device-code", "fs-changed", ...). Channel arguments
// stream as the event "channel" with the payload {"id": <channel id>,
// "message": <message>}. Both strings are valid only during the callback,
// which may run on any thread.
typedef void (*PostoEventCallback)(void *context, const char *event, const char *payload_json);

// Starts the engine. Call once at app start, before any posto_invoke.
//
// config_json: {"dataDir": "...", "cacheDir": "...", "configDir": "..."}, the
// directories Tauri's app.path() would return (app_data_dir, app_cache_dir,
// app_config_dir). An omitted directory makes commands that need it fail;
// unknown keys are rejected.
//
// on_event (may be NULL) is called with event_context from any thread for the
// life of the process.
//
// Returns 0 on success, 1 when config_json is missing or invalid, and 2 when
// the engine was already started (the first configuration stays in effect).
int32_t posto_init(const char *config_json, PostoEventCallback on_event, void *event_context);

// Runs a command without blocking the caller: async commands on a global
// multi-thread runtime, sync ones on its blocking pool.
//
// command: a Tauri command name, e.g. "read_text_file".
// args_json: the object the frontend passes to Tauri's invoke, with camelCase
// keys (e.g. {"path": "/..."}); NULL means {}. Missing optional arguments are
// treated as null. Channel arguments are a numeric channel id (or null).
//
// callback fires exactly once, on any thread, with request_id and context.
// Unknown commands answer {"error": "unknown command: <name>"}. Both strings
// only need to live for the duration of this call.
void posto_invoke(uint64_t request_id, const char *command, const char *args_json, PostoResponseCallback callback, void *context);

#ifdef __cplusplus
}
#endif

#endif

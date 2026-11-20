//! Runs a src-tauri command by name with the JSON arguments the frontend
//! would pass to Tauri's `invoke`, and serializes its result the way Tauri
//! does.

use serde::de::{self, DeserializeOwned, Deserializer, Visitor};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppDirs, AppHandle, Manager};

use crate::{auth, fs, git, media, repos, settings, workspace};

/// The app every command runs against, managing the same state as
/// src-tauri's mobile builder.
pub(crate) fn build_app(
    dirs: AppDirs,
    on_event: impl Fn(&str, &str) + Send + Sync + 'static,
) -> AppHandle {
    tauri::Builder::default()
        .dirs(dirs)
        .on_event(on_event)
        .manage(auth::AuthState::default())
        .build()
}

/// A command `posto_invoke` accepts, as declared in src-tauri.
#[derive(Debug)]
pub struct Command {
    pub module: &'static str,
    pub name: &'static str,
    pub is_async: bool,
    /// The Rust parameter names, in order. `app` and `state` are injected;
    /// every other parameter is read from the arguments object under its
    /// camelCase name.
    pub params: &'static [&'static str],
}

/// Generates [`COMMANDS`] and the dispatcher from one table. Sync commands
/// run on the blocking pool, so no command blocks the caller (Tauri runs
/// them on the main thread instead).
macro_rules! commands {
    ($($kind:tt $module:ident::$name:ident($($param:ident),*);)*) => {
        /// Every command `posto_invoke` accepts: src-tauri's mobile
        /// `generate_handler!` list, minus the in-app browser commands that
        /// Swift handles natively.
        pub const COMMANDS: &[Command] = &[$(Command {
            module: stringify!($module),
            name: stringify!($name),
            is_async: commands!(@is_async $kind),
            params: &[$(stringify!($param)),*],
        }),*];

        async fn dispatch(invoke: Invoke) -> Result<String, String> {
            match invoke.command.as_str() {
                $(stringify!($name) => commands!(@call $kind invoke $module::$name($($param),*)),)*
                command => Err(format!("unknown command: {command}")),
            }
        }
    };
    (@is_async async) => { true };
    (@is_async sync) => { false };
    (@call async $invoke:ident $module:ident::$name:ident($($param:ident),*)) => {{
        $(let $param = param!($invoke, $param);)*
        Output($module::$name($($param),*).await).into_response()
    }};
    (@call sync $invoke:ident $module:ident::$name:ident($($param:ident),*)) => {{
        $(let $param = param!($invoke, $param);)*
        let output = tauri::async_runtime::spawn_blocking(move || $module::$name($($param),*))
            .await
            .map_err(|error| error.to_string())?;
        Output(output).into_response()
    }};
}

/// One argument for a command, by its Rust parameter name.
macro_rules! param {
    ($invoke:ident, app) => {
        $invoke.app.clone()
    };
    ($invoke:ident, state) => {
        $invoke.state("state")?
    };
    ($invoke:ident, $name:ident) => {
        $invoke.arg(stringify!($name))?
    };
}

commands! {
    async auth::auth_status();
    async auth::retry_auth_status();
    async auth::sign_in(app, state);
    async auth::sign_out();
    async auth::github_pages_url(owner, name);
    async auth::list_user_repos();
    async auth::list_workflow_runs(owner, name, branch);
    sync fs::list_files(root);
    sync fs::list_dir_files(dir, extensions);
    sync fs::list_dir_files_optional(dir, extensions);
    sync fs::path_exists(path, kind);
    async fs::image_thumbnail(app, path, max_width, max_height);
    sync fs::list_directories(dir);
    sync fs::list_child_directories(dir);
    sync fs::read_text_file(path);
    sync fs::read_text_file_optional(path);
    sync fs::write_text_file(path, content);
    sync fs::create_text_file(path, content);
    sync fs::rename_file(from, to);
    sync fs::delete_file(path);
    sync fs::delete_media_file(media_root, file_path);
    sync fs::rename_media_file(media_root, file_path, target_file_path);
    sync fs::move_media_file(media_root, file_path, destination_directory);
    sync fs::delete_media_directory(media_root, directory_path);
    sync fs::move_media_directory(media_root, directory_path, destination_directory);
    sync fs::create_image_library_directory(library_root, directory_path);
    sync fs::create_file_media_directory(repository_root, media_root, directory);
    sync fs::create_public_media_directory(repository_root, directory);
    sync fs::delete_image_library_asset(library_root, image_path, metadata_path);
    sync fs::move_image_library_asset(library_root, image_path, metadata_path, destination_directory);
    sync fs::rename_image_library_asset(
        library_root,
        image_path,
        metadata_path,
        target_image_path,
        target_metadata_path,
        serialized_metadata
    );
    sync fs::delete_image_library_directory(library_root, directory_path);
    sync fs::move_image_library_directory(library_root, directory_path, destination_directory);
    sync fs::import_image_library_asset(app, plan);
    sync fs::import_file_media_item(app, request);
    sync fs::import_public_media_file(app, request);
    sync fs::write_temp_image(app, bytes, extension);
    sync fs::read_image_bytes(path);
    sync fs::probe_image_is_heif(path);
    async media::media_credential_exists(source);
    async media::media_credential_save(source, credential, prefix);
    async media::media_credential_delete(source);
    async media::media_list_objects(source, prefix);
    async media::media_inspect_file(path);
    async media::media_placeholder(path);
    async media::media_derive_remote(request);
    async media::media_image_details(path);
    async media::media_remote_image_details(url, needs_date);
    async media::media_publish(request, on_progress);
    async media::media_publish_recover(root);
    async media::media_record_delete(root, intent);
    async media::media_pending_deletes(root);
    sync settings::get_last_root(app);
    sync settings::get_last_selection(app);
    sync settings::get_work_dir(app, root);
    sync settings::get_recent_roots(app);
    sync settings::get_developer_mode(app);
    sync settings::set_developer_mode(app, enabled);
    sync settings::set_last_root(app, root, work_dir);
    async git::changed_files(root);
    async git::changed_files_preview(root, writes, removals);
    async git::ignored_paths(root, paths);
    async git::revert_file(root, path, status);
    async git::fetch_upstream(root);
    async git::pull_upstream(app, root);
    async git::publish(root, message);
    async git::current_branch(root);
    async git::list_branches(root);
    async git::checkout_branch(app, root, name, create, force);
    sync workspace::scan_projects(root);
    async repos::clone_repo(app, url);
    async repos::doctor_repo(app, root, expected_url);
    sync repos::list_repos(app);
    async repos::remove_repo(app, root);
}

/// Runs `command` and returns the response JSON for the host:
/// `{"ok": <return value>}` or `{"error": "<message>"}`.
pub(crate) async fn invoke(app: AppHandle, command: String, args_json: &str) -> String {
    let args = if args_json.trim().is_empty() {
        Value::Object(Default::default())
    } else {
        match serde_json::from_str(args_json) {
            Ok(args) => args,
            Err(error) => return error_json(&format!("invalid args JSON: {error}")),
        }
    };
    // Its own task, so a panicking command fails this request instead of
    // taking the response down with it.
    let name = command.clone();
    match tauri::async_runtime::spawn(dispatch(Invoke { app, command, args })).await {
        Ok(Ok(response)) => response,
        Ok(Err(message)) => error_json(&message),
        Err(error) => error_json(&format!("command {name} failed: {error}")),
    }
}

pub(crate) fn error_json(message: &str) -> String {
    serde_json::json!({ "error": message }).to_string()
}

struct Invoke {
    app: AppHandle,
    command: String,
    args: Value,
}

impl Invoke {
    /// Reads a parameter the way Tauri does: from the camelCase key, where a
    /// missing key is `None` for an `Option` and an error otherwise.
    fn arg<T: DeserializeOwned>(&self, name: &str) -> Result<T, String> {
        let key = camel_case(name);
        let item = ArgItem {
            command: &self.command,
            key: &key,
            args: &self.args,
        };
        tauri::ipc::with_invoke_app(&self.app, || T::deserialize(item)).map_err(|error| {
            format!(
                "invalid args `{key}` for command `{}`: {error}",
                self.command
            )
        })
    }

    fn state<T: Send + Sync + 'static>(&self, name: &str) -> Result<tauri::State<'_, T>, String> {
        self.app.try_state().ok_or_else(|| {
            format!(
                "state not managed for field `{name}` on command `{}`. You must call `.manage()` before using this command",
                self.command
            )
        })
    }
}

/// Tauri's default argument naming (`max_width` → `maxWidth`).
fn camel_case(name: &str) -> String {
    let mut words = name.split('_').filter(|word| !word.is_empty());
    let mut key = words.next().unwrap_or_default().to_string();
    for word in words {
        let mut chars = word.chars();
        if let Some(first) = chars.next() {
            key.extend(first.to_uppercase());
            key.push_str(chars.as_str());
        }
    }
    key
}

/// One argument, looked up in the arguments object only when deserialized,
/// so `Option` parameters can treat a missing key as `None`. Mirrors Tauri's
/// `CommandItem` deserializer.
struct ArgItem<'a> {
    command: &'a str,
    key: &'a str,
    args: &'a Value,
}

impl<'a> ArgItem<'a> {
    fn value(&self) -> Result<&'a Value, serde_json::Error> {
        self.args.get(self.key).ok_or_else(|| {
            de::Error::custom(format!(
                "command {} missing required key {}",
                self.command, self.key
            ))
        })
    }
}

macro_rules! pass {
    ($method:ident $(, $arg:ident: $ty:ty)*) => {
        fn $method<V: Visitor<'a>>(self, $($arg: $ty,)* visitor: V) -> Result<V::Value, Self::Error> {
            self.value()?.$method($($arg,)* visitor)
        }
    };
}

impl<'a> Deserializer<'a> for ArgItem<'a> {
    type Error = serde_json::Error;

    pass!(deserialize_any);
    pass!(deserialize_bool);
    pass!(deserialize_i8);
    pass!(deserialize_i16);
    pass!(deserialize_i32);
    pass!(deserialize_i64);
    pass!(deserialize_u8);
    pass!(deserialize_u16);
    pass!(deserialize_u32);
    pass!(deserialize_u64);
    pass!(deserialize_f32);
    pass!(deserialize_f64);
    pass!(deserialize_char);
    pass!(deserialize_str);
    pass!(deserialize_string);
    pass!(deserialize_bytes);
    pass!(deserialize_byte_buf);
    pass!(deserialize_unit);
    pass!(deserialize_unit_struct, name: &'static str);
    pass!(deserialize_newtype_struct, name: &'static str);
    pass!(deserialize_seq);
    pass!(deserialize_tuple, len: usize);
    pass!(deserialize_tuple_struct, name: &'static str, len: usize);
    pass!(deserialize_map);
    pass!(deserialize_struct, name: &'static str, fields: &'static [&'static str]);
    pass!(deserialize_enum, name: &'static str, variants: &'static [&'static str]);
    pass!(deserialize_identifier);
    pass!(deserialize_ignored_any);

    fn deserialize_option<V: Visitor<'a>>(self, visitor: V) -> Result<V::Value, Self::Error> {
        match self.args.get(self.key) {
            Some(value) => value.deserialize_option(visitor),
            None => visitor.visit_none(),
        }
    }
}

/// A command's return value, turned into the response the way Tauri does:
/// `Ok`/`Err` for a `Result`, and any other value is a success.
struct Output<T>(T);

/// Picked for `Output<Result<..>>`, ahead of [`ValueOutput`] (autoref
/// specialization, as in Tauri's command macro).
trait ResultOutput {
    fn into_response(self) -> Result<String, String>;
}

impl<T: Serialize, E: std::fmt::Display> ResultOutput for Output<Result<T, E>> {
    fn into_response(self) -> Result<String, String> {
        match self.0 {
            Ok(value) => ok_json(&value),
            Err(error) => Err(error.to_string()),
        }
    }
}

trait ValueOutput {
    fn into_response(self) -> Result<String, String>;
}

impl<T: Serialize> ValueOutput for &Output<T> {
    fn into_response(self) -> Result<String, String> {
        ok_json(&self.0)
    }
}

fn ok_json<T: Serialize>(value: &T) -> Result<String, String> {
    let json = serde_json::to_string(value).map_err(|error| error.to_string())?;
    Ok(format!(r#"{{"ok":{json}}}"#))
}

#[cfg(test)]
mod tests {
    use super::camel_case;

    #[test]
    fn argument_keys_are_camel_case() {
        assert_eq!(camel_case("root"), "root");
        assert_eq!(camel_case("max_width"), "maxWidth");
        assert_eq!(camel_case("on_progress"), "onProgress");
        assert_eq!(camel_case("target_metadata_path"), "targetMetadataPath");
    }
}

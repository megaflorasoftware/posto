//! Checks the bridge's command table against src-tauri's sources, so a
//! command added to the mobile handler, or a parameter renamed or reordered,
//! fails here instead of silently reading the wrong JSON key.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use posto_native::COMMANDS;

/// Commands Swift implements natively instead.
const NATIVE_IN_SWIFT: &[&str] = &[
    "browser::open_in_app_browser",
    "browser::close_in_app_browser",
];

fn tauri_src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../src-tauri/src")
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// `module::name` entries of src-tauri's `#[cfg(mobile)]` invoke handler.
fn mobile_handler() -> Vec<String> {
    let lib = read(&tauri_src().join("lib.rs"));
    let mobile = lib
        .find("#[cfg(mobile)]\n    let builder")
        .expect("mobile builder in lib.rs");
    let start =
        mobile + lib[mobile..].find("generate_handler![").unwrap() + "generate_handler![".len();
    let end = start + lib[start..].find(']').unwrap();
    lib[start..end]
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect()
}

/// Splits on commas outside brackets.
fn split_top_level(list: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut start = 0;
    for (index, c) in list.char_indices() {
        match c {
            '<' | '(' | '[' => depth += 1,
            '>' | ')' | ']' => depth -= 1,
            ',' if depth == 0 => {
                parts.push(&list[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    parts.push(&list[start..]);
    parts
        .into_iter()
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect()
}

struct Declared {
    is_async: bool,
    params: Vec<(String, String)>,
}

/// Every `#[tauri::command]` function in a module, by name.
fn declared_commands(module: &str) -> HashMap<String, Declared> {
    let file = tauri_src().join(format!("{module}.rs"));
    let file = if file.exists() {
        file
    } else {
        tauri_src().join(module).join("mod.rs")
    };
    let source = read(&file);
    let mut commands = HashMap::new();
    for (position, _) in source.match_indices("#[tauri::command") {
        let rest = &source[position..];
        let fn_start = rest.find("fn ").unwrap();
        let header = &rest[..fn_start];
        let name_start = fn_start + 3;
        let open = name_start + rest[name_start..].find('(').unwrap();
        let name = rest[name_start..open].trim().to_string();
        let mut depth = 0;
        let mut close = open;
        for (index, c) in rest[open..].char_indices() {
            match c {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        close = open + index;
                        break;
                    }
                }
                _ => {}
            }
        }
        let params = split_top_level(&rest[open + 1..close])
            .into_iter()
            .map(|param| {
                let (name, ty) = param.split_once(':').unwrap();
                (name.trim().to_string(), ty.trim().to_string())
            })
            .collect();
        commands.insert(
            name,
            Declared {
                is_async: header.contains("async "),
                params,
            },
        );
    }
    commands
}

#[test]
fn command_table_matches_the_mobile_handler() {
    let expected: Vec<String> = mobile_handler()
        .into_iter()
        .filter(|entry| !NATIVE_IN_SWIFT.contains(&entry.as_str()))
        .collect();
    let bridged: Vec<String> = COMMANDS
        .iter()
        .map(|command| format!("{}::{}", command.module, command.name))
        .collect();
    assert_eq!(bridged, expected);
}

#[test]
fn command_parameters_match_their_declarations() {
    let mut modules = HashMap::new();
    for command in COMMANDS {
        let declared = modules
            .entry(command.module)
            .or_insert_with(|| declared_commands(command.module));
        let label = format!("{}::{}", command.module, command.name);
        let declared = declared
            .get(command.name)
            .unwrap_or_else(|| panic!("{label} is not a #[tauri::command]"));
        assert_eq!(command.is_async, declared.is_async, "{label} async-ness");
        let names: Vec<&str> = declared
            .params
            .iter()
            .map(|(name, _)| name.as_str())
            .collect();
        assert_eq!(command.params, names, "{label} parameters");
        for (name, ty) in &declared.params {
            let injected = match name.as_str() {
                "app" => ty.ends_with("AppHandle"),
                "state" => ty.contains("State<"),
                _ => !ty.ends_with("AppHandle") && !ty.contains("State<"),
            };
            assert!(
                injected,
                "{label}: parameter `{name}: {ty}` is injected by name"
            );
        }
    }
}

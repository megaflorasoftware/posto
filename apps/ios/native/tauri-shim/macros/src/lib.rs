//! `#[tauri::command]` for the shim. Real Tauri generates IPC glue here; the
//! native bridge dispatches commands itself, so the attribute leaves the
//! function exactly as written and ignores any arguments
//! (`#[tauri::command(async)]`, `rename_all = ...`).

use proc_macro::TokenStream;

#[proc_macro_attribute]
pub fn command(_arguments: TokenStream, item: TokenStream) -> TokenStream {
    item
}

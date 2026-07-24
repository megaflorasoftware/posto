mod auth;
#[cfg(mobile)]
mod browser;
#[cfg(desktop)]
mod devserver;
#[cfg(desktop)]
mod env;
mod fs;
pub mod git;
#[cfg(desktop)]
mod proxy;
#[cfg(any(mobile, test))]
mod repos;
mod settings;
#[cfg(desktop)]
mod watch;
mod workspace;

#[cfg(target_os = "macos")]
const FULLSCREEN_EDITOR_MENU_ID: &str = "fullscreen-editor";
#[cfg(target_os = "macos")]
const OPEN_FILE_MENU_ID: &str = "open-file";
#[cfg(target_os = "macos")]
const OPEN_REPOSITORY_MENU_ID: &str = "open-repository";
#[cfg(target_os = "macos")]
const OPEN_RECENT_MENU_ID: &str = "open-recent";
#[cfg(target_os = "macos")]
const OPEN_SIBLING_PROJECT_MENU_ID: &str = "open-sibling-project";

#[cfg(desktop)]
#[tauri::command]
fn set_repository_menu_items_enabled(
    app: tauri::AppHandle,
    has_recent: bool,
    can_open_sibling: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::menu::MenuItemKind;

        let menu = app
            .menu()
            .ok_or_else(|| "application menu is unavailable".to_string())?;
        for item in menu.items().map_err(|error| error.to_string())? {
            let MenuItemKind::Submenu(submenu) = item else {
                continue;
            };
            if submenu.text().map_err(|error| error.to_string())? != "File" {
                continue;
            }
            let Some(MenuItemKind::MenuItem(recent)) = submenu.get(OPEN_RECENT_MENU_ID) else {
                return Err("open recent menu item is unavailable".to_string());
            };
            let Some(MenuItemKind::MenuItem(sibling)) = submenu.get(OPEN_SIBLING_PROJECT_MENU_ID)
            else {
                return Err("open sibling project menu item is unavailable".to_string());
            };
            recent
                .set_enabled(has_recent)
                .map_err(|error| error.to_string())?;
            return sibling
                .set_enabled(can_open_sibling)
                .map_err(|error| error.to_string());
        }
        Err("File menu is unavailable".to_string())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, has_recent, can_open_sibling);
        Ok(())
    }
}

#[cfg(desktop)]
#[tauri::command]
fn set_open_file_menu_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::menu::MenuItemKind;

        let menu = app
            .menu()
            .ok_or_else(|| "application menu is unavailable".to_string())?;
        for item in menu.items().map_err(|error| error.to_string())? {
            let MenuItemKind::Submenu(submenu) = item else {
                continue;
            };
            if submenu.text().map_err(|error| error.to_string())? != "File" {
                continue;
            }
            if let Some(MenuItemKind::MenuItem(item)) = submenu.get(OPEN_FILE_MENU_ID) {
                return item.set_enabled(enabled).map_err(|error| error.to_string());
            }
        }
        Err("open file menu item is unavailable".to_string())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, enabled);
        Ok(())
    }
}

#[cfg(desktop)]
#[tauri::command]
fn set_fullscreen_editor_menu_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::menu::MenuItemKind;

        let menu = app
            .menu()
            .ok_or_else(|| "application menu is unavailable".to_string())?;
        for item in menu.items().map_err(|error| error.to_string())? {
            let MenuItemKind::Submenu(submenu) = item else {
                continue;
            };
            if submenu.text().map_err(|error| error.to_string())? != "View" {
                continue;
            }
            if let Some(MenuItemKind::MenuItem(item)) = submenu.get(FULLSCREEN_EDITOR_MENU_ID) {
                return item.set_enabled(enabled).map_err(|error| error.to_string());
            }
        }
        Err("fullscreen editor menu item is unavailable".to_string())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, enabled);
        Ok(())
    }
}

#[cfg(desktop)]
fn handle_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    use tauri::Manager;
    if let tauri::RunEvent::Exit = event {
        let server = app
            .state::<devserver::DevServerState>()
            .server
            .lock()
            .unwrap()
            .take();
        if let Some(mut server) = server {
            devserver::kill_server(&mut server);
        }
        if let Some(path) = devserver::pid_file(app) {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(mobile)]
fn handle_run_event(_app: &tauri::AppHandle, _event: tauri::RunEvent) {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Apps launched from Finder get launchd's minimal PATH, so the preview
    // pane's dev server can't find node/npx. Recover the login shell's PATH.
    #[cfg(desktop)]
    if let Err(e) = fix_path_env::fix() {
        eprintln!("failed to fix PATH: {e}");
    }
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(auth::AuthState::default())
        .manage(devserver::DevServerState::default())
        .manage(proxy::ProxyState::default())
        .manage(watch::WatchState::default())
        .setup(|app| {
            // Once per app start: reap a dev server orphaned by a previous
            // instance that exited without its Exit handler running.
            devserver::kill_stale_server(app.handle());
            Ok(())
        });
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(|app| {
            use tauri::menu::{Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem};

            let menu = Menu::default(app)?;
            let open_file = MenuItemBuilder::with_id(OPEN_FILE_MENU_ID, "Open File…")
                .accelerator("Cmd+O")
                .enabled(false)
                .build(app)?;
            let fullscreen_editor =
                MenuItemBuilder::with_id(FULLSCREEN_EDITOR_MENU_ID, "Fullscreen Editor")
                    .accelerator("Cmd+Shift+F")
                    .enabled(false)
                    .build(app)?;
            let open_repository =
                MenuItemBuilder::with_id(OPEN_REPOSITORY_MENU_ID, "Open Repository…").build(app)?;
            let open_recent = MenuItemBuilder::with_id(OPEN_RECENT_MENU_ID, "Open Recent…")
                .accelerator("Cmd+Shift+O")
                .enabled(false)
                .build(app)?;
            let open_sibling =
                MenuItemBuilder::with_id(OPEN_SIBLING_PROJECT_MENU_ID, "Open Sibling Project…")
                    .enabled(false)
                    .build(app)?;
            for item in menu.items()? {
                let MenuItemKind::Submenu(view_menu) = item else {
                    continue;
                };
                if view_menu.text()? == "View" {
                    let separator = PredefinedMenuItem::separator(app)?;
                    view_menu.prepend_items(&[&fullscreen_editor, &separator])?;
                    break;
                }
            }
            for item in menu.items()? {
                let MenuItemKind::Submenu(file_menu) = item else {
                    continue;
                };
                if file_menu.text()? == "File" {
                    let open_file_separator = PredefinedMenuItem::separator(app)?;
                    let repository_separator = PredefinedMenuItem::separator(app)?;
                    file_menu.prepend_items(&[
                        &open_file,
                        &open_file_separator,
                        &open_repository,
                        &open_recent,
                        &open_sibling,
                        &repository_separator,
                    ])?;
                    break;
                }
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            use tauri::Emitter;

            if event.id().as_ref() == OPEN_FILE_MENU_ID {
                let _ = app.emit("open-file", ());
            }
            if event.id().as_ref() == FULLSCREEN_EDITOR_MENU_ID {
                let _ = app.emit("open-fullscreen-editor", ());
            }
            if event.id().as_ref() == OPEN_REPOSITORY_MENU_ID {
                let _ = app.emit("open-repository", ());
            }
            if event.id().as_ref() == OPEN_RECENT_MENU_ID {
                let _ = app.emit("open-recent", ());
            }
            if event.id().as_ref() == OPEN_SIBLING_PROJECT_MENU_ID {
                let _ = app.emit("open-sibling-project", ());
            }
        });
    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        auth::auth_status,
        auth::sign_in,
        auth::sign_out,
        auth::list_workflow_runs,
        git::github_remote,
        fs::list_files,
        fs::list_dir_files,
        fs::list_dir_files_optional,
        fs::path_exists,
        fs::image_thumbnail,
        fs::list_directories,
        fs::list_child_directories,
        fs::read_text_file,
        fs::read_text_file_optional,
        fs::write_text_file,
        fs::create_text_file,
        fs::rename_file,
        fs::delete_file,
        fs::import_image_library_asset,
        fs::write_temp_image,
        fs::read_image_bytes,
        fs::probe_image_is_heif,
        devserver::start_dev_server,
        devserver::stop_dev_server,
        devserver::ping_dev_server,
        devserver::get_dev_server_logs,
        devserver::fetch_page,
        proxy::get_last_route,
        env::needs_install,
        env::install_dependencies,
        env::check_environment,
        env::install_node,
        env::install_package_manager,
        settings::get_last_root,
        settings::get_last_selection,
        settings::get_work_dir,
        settings::get_recent_roots,
        settings::set_last_root,
        git::changed_files,
        git::revert_file,
        git::fetch_upstream,
        git::pull_upstream,
        git::publish,
        workspace::scan_projects,
        watch::watch_root,
        set_open_file_menu_enabled,
        set_repository_menu_items_enabled,
        set_fullscreen_editor_menu_enabled
    ]);
    #[cfg(mobile)]
    let builder =
        builder
            .manage(auth::AuthState::default())
            .invoke_handler(tauri::generate_handler![
                auth::auth_status,
                auth::sign_in,
                auth::sign_out,
                auth::list_user_repos,
                auth::list_workflow_runs,
                browser::open_in_app_browser,
                browser::close_in_app_browser,
                fs::list_files,
                fs::list_dir_files,
                fs::list_dir_files_optional,
                fs::path_exists,
                fs::image_thumbnail,
                fs::list_directories,
                fs::list_child_directories,
                fs::read_text_file,
                fs::read_text_file_optional,
                fs::write_text_file,
                fs::create_text_file,
                fs::rename_file,
                fs::delete_file,
                fs::import_image_library_asset,
                fs::write_temp_image,
                fs::read_image_bytes,
                fs::probe_image_is_heif,
                settings::get_last_root,
                settings::get_last_selection,
                settings::get_work_dir,
                settings::get_recent_roots,
                settings::set_last_root,
                git::changed_files,
                git::revert_file,
                git::fetch_upstream,
                git::pull_upstream,
                git::publish,
                workspace::scan_projects,
                repos::clone_repo,
                repos::doctor_repo,
                repos::list_repos,
                repos::remove_repo
            ]);
    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(handle_run_event);
}

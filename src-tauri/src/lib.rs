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
    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        auth::auth_status,
        auth::sign_in,
        auth::sign_out,
        auth::list_workflow_runs,
        git::github_remote,
        fs::list_files,
        fs::list_dir_files,
        fs::image_thumbnail,
        fs::list_directories,
        fs::read_text_file,
        fs::write_text_file,
        fs::create_text_file,
        fs::rename_file,
        fs::delete_file,
        fs::import_image_library_asset,
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
        settings::get_recent_roots,
        settings::set_last_root,
        git::changed_files,
        git::revert_file,
        git::fetch_upstream,
        git::pull_upstream,
        git::publish,
        watch::watch_root
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
                browser::open_in_app_browser,
                browser::close_in_app_browser,
                fs::list_files,
                fs::list_dir_files,
                fs::image_thumbnail,
                fs::list_directories,
                fs::read_text_file,
                fs::write_text_file,
                fs::create_text_file,
                fs::rename_file,
                fs::delete_file,
                fs::import_image_library_asset,
                settings::get_last_root,
                settings::get_recent_roots,
                settings::set_last_root,
                git::changed_files,
                git::revert_file,
                git::fetch_upstream,
                git::pull_upstream,
                git::publish,
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

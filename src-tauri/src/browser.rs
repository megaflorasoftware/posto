//! In-app browser tab for mobile auth: SFSafariViewController on iOS so the
//! GitHub device-flow page opens over the app instead of bouncing out to
//! Safari. Other mobile platforms fall back to the system browser until they
//! grow an equivalent (Android: Custom Tabs, phase 6).

use tauri::AppHandle;

#[cfg(target_os = "ios")]
mod ios {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    unsafe fn root_view_controller() -> *mut AnyObject {
        let app: *mut AnyObject = msg_send![class!(UIApplication), sharedApplication];
        let mut window: *mut AnyObject = msg_send![app, keyWindow];
        if window.is_null() {
            let windows: *mut AnyObject = msg_send![app, windows];
            window = msg_send![windows, firstObject];
        }
        if window.is_null() {
            return std::ptr::null_mut();
        }
        msg_send![window, rootViewController]
    }

    pub unsafe fn present(url: &str) {
        let url_string = NSString::from_str(url);
        let ns_url: *mut AnyObject = msg_send![class!(NSURL), URLWithString: &*url_string];
        if ns_url.is_null() {
            return;
        }
        let root = root_view_controller();
        if root.is_null() {
            return;
        }
        let safari: *mut AnyObject = msg_send![class!(SFSafariViewController), alloc];
        let safari: *mut AnyObject = msg_send![safari, initWithURL: ns_url];
        let _: () = msg_send![safari, autorelease];
        let nil: *mut AnyObject = std::ptr::null_mut();
        let _: () = msg_send![root, presentViewController: safari, animated: true, completion: nil];
    }

    pub unsafe fn dismiss() {
        let root = root_view_controller();
        if root.is_null() {
            return;
        }
        let presented: *mut AnyObject = msg_send![root, presentedViewController];
        if presented.is_null() {
            return;
        }
        let is_safari: bool = msg_send![presented, isKindOfClass: class!(SFSafariViewController)];
        if !is_safari {
            return;
        }
        let nil: *mut AnyObject = std::ptr::null_mut();
        let _: () = msg_send![root, dismissViewControllerAnimated: true, completion: nil];
    }
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub fn open_in_app_browser(app: AppHandle, url: String) -> Result<(), String> {
    app.run_on_main_thread(move || unsafe { ios::present(&url) })
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub fn close_in_app_browser(app: AppHandle) -> Result<(), String> {
    app.run_on_main_thread(|| unsafe { ios::dismiss() })
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "ios"))]
#[tauri::command]
pub fn open_in_app_browser(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "ios"))]
#[tauri::command]
pub fn close_in_app_browser(_app: AppHandle) -> Result<(), String> {
    Ok(())
}

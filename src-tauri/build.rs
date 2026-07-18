fn main() {
    // SFSafariViewController (browser.rs) lives in SafariServices, which
    // nothing else links.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        println!("cargo:rustc-link-lib=framework=SafariServices");
    }
    tauri_build::build()
}

fn main() {
    // The src-tauri modules this crate compiles gate their platform code
    // paths on `mobile`/`desktop`, which tauri-build sets from the target.
    // This crate is the mobile engine (also when built for the macOS host to
    // run its tests), or with the `desktop` feature the macOS app's engine.
    println!("cargo:rustc-check-cfg=cfg(mobile)");
    println!("cargo:rustc-check-cfg=cfg(desktop)");
    if std::env::var_os("CARGO_FEATURE_DESKTOP").is_some() {
        println!("cargo:rustc-cfg=desktop");
    } else {
        println!("cargo:rustc-cfg=mobile");
    }
}

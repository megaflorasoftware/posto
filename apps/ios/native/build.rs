fn main() {
    // The src-tauri modules this crate compiles gate their mobile code paths
    // on `mobile`/`desktop`, which tauri-build sets from the target. This
    // crate is always the mobile engine, including when it is built for the
    // macOS host to run its tests.
    println!("cargo:rustc-check-cfg=cfg(mobile)");
    println!("cargo:rustc-check-cfg=cfg(desktop)");
    println!("cargo:rustc-cfg=mobile");
}

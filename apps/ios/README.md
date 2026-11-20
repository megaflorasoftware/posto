# Posto for iOS (native prototype)

An exploratory SwiftUI version of the mobile app. Every screen is native;
the logic underneath is the same code the Tauri apps run:

```
SwiftUI views ──► Swift models ──► engine.js in JavaScriptCore ──► Rust bridge
 (Posto/Views)     (Posto/Models)   (engine/, @posto/core+editor)   (native/, src-tauri sources)
```

- **`engine/`** bundles `@posto/core` and the non-React parts of
  `@posto/editor` into one script. It owns repository sessions, the form
  model and autosave queue, git sync and publish, media, and deployments.
  `@posto/ipc` resolves to `engine/src/ipc.ts`, which sends commands to the
  native transport. The browser mock (`@posto/ipc/mock`) doubles as the
  **demo backend**.
- **`native/`** compiles `src-tauri/src` unchanged against a small `tauri`
  shim and exposes the commands through one C function,
  `posto_invoke(command, argsJSON)`, packaged as `PostoNative.xcframework`.
- **`Posto/`** is the app: `Engine/` hosts the script, `Models/` hold
  observable state, and `Views/` hold the screens.

## Building

You need Xcode (26 or later), Rust (via rustup), Node 24 with pnpm, and
XcodeGen (`brew install xcodegen`).

```sh
pnpm install                     # from the repository root
apps/ios/scripts/bootstrap.sh    # engine.js, the Rust xcframework, Posto.xcodeproj
open apps/ios/Posto.xcodeproj
```

Run the **Posto** scheme to sign in with GitHub, or **Posto Demo** for
fixture content with no network or Rust. On the sign-in screen, "Explore a
demo site" switches modes too. A device build needs your team set under
Signing & Capabilities.

## Checks that don't need Xcode

```sh
pnpm --filter ios test             # engine flows against the demo backend
apps/ios/scripts/engine-smoke.sh   # the bundle in JavaScriptCore through the Swift host
apps/ios/scripts/typecheck.sh      # every Swift file, as Mac Catalyst
apps/ios/scripts/catalyst-demo.sh  # run the demo on this Mac (--tour snapshots each screen)
```

## Not ported yet

- Editing an image-library entry's metadata inline in a document; it opens
  in the asset editor instead (long-press or swipe the field).

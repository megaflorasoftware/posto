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

You need Xcode 26 or later with an iOS simulator runtime, Rust (via rustup),
Node 24 with pnpm, and XcodeGen (`brew install xcodegen`).

```sh
apps/ios/scripts/bootstrap.sh          # JS deps, engine.js, the Rust xcframework, Posto.xcodeproj
apps/ios/scripts/run-simulator.sh      # build, install, and launch on an iPhone simulator
apps/ios/scripts/run-simulator.sh --demo
apps/ios/scripts/run-simulator.sh --tour   # demo walkthrough, a snapshot per screen
```

Or open `apps/ios/Posto.xcodeproj` and run the **Posto** scheme to sign in
with GitHub, or **Posto Demo** for fixture content with no network. On the
sign-in screen, "Explore a demo site" switches modes too. Device builds sign
with the Tauri app's team; change it under Signing & Capabilities if needed.

The first Rust build takes several minutes. After editing Rust, rerun
`scripts/build-native.sh`; the engine is rebundled on every Xcode build.

## Checks that don't need Xcode

```sh
pnpm --filter ios test             # engine flows against the demo backend
apps/ios/scripts/engine-smoke.sh   # the bundle in JavaScriptCore through the Swift host
apps/ios/scripts/typecheck.sh      # every Swift file, as Mac Catalyst
apps/ios/scripts/catalyst-demo.sh  # run the demo on this Mac (--tour snapshots each screen)
```

## Differences from the Tauri app

- The body is a markdown editor with live styling and a formatting bar,
  not the TipTap rich-text editor. MDX components insert and edit through
  a props form, and the rest of the JSX stays editable as text.
- An image-library reference's metadata opens in the asset editor (long-press
  or swipe the field) rather than inline under the field.
- iPad gets the file tree and the editor side by side.

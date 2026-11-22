# Handoff: finishing the native iOS app

This branch (`explore-native-ios-app`) holds an exploratory SwiftUI version of
the Posto mobile app. All of it was written on a Mac that couldn't run Xcode:
an Intel Mac on macOS 15 with only the Command Line Tools. Everything that
works without Xcode was run there; the steps below were then finished on a
Mac with Xcode 27 (see "Where things stand").

Read [README.md](README.md) first: it covers the architecture and the scripts.

## Where things stand

**Built and checked on the previous machine:**

- **Engine:** `pnpm --filter ios test` runs 13 engine tests against the demo
  backend, and they pass.
- **Rust bridge:** `cargo test` in `native/` passes all four suites (56, 12, 2
  and 10 tests). A drift test fails if the command table falls out of sync
  with `src-tauri`.
- **JavaScriptCore:** `scripts/engine-smoke.sh` runs the bundled engine through
  the app's Swift host.
- **Real stack on macOS:** `scripts/native-smoke.sh` runs Swift → Rust host
  build → engine against a git copy of `apps/docs`: open, edit, autosave, git
  status, revert.
- **Swift typecheck:** `scripts/typecheck.sh` typechecked all 32 Swift files as
  Mac Catalyst (Swift 6.1, macOS 15.5 SDK).
- **UI previews:** `scripts/catalyst-demo.sh --tour` and
  `scripts/live-preview.sh <repo> <owner/name> --tour` ran the app as Mac
  Catalyst and snapshotted every screen. The first uses the demo fixtures; the
  second uses a real site (henryfellerhoff.com) over the real Rust bridge.
- **Xcode project:** `xcodegen generate` produces a project that lints, with
  both schemes and the iOS 27 scene manifest.

**Done on an Apple Silicon Mac with Xcode 27.2 (steps 0–6 below):**

- **Rust iOS build:** `scripts/build-native.sh` built all three slices on the
  first try, with no cmake or SDK changes.
- **Xcode builds:** both schemes build with no errors or warnings, for the
  iOS 18 and iOS 27.2 simulators and for an iPhone 15 Pro on iOS 27 (team
  `K56D2LK4DS`, wildcard profile). Xcode 27 replaced Simulator.app with
  Device Hub; `run-simulator.sh` opens either.
- **Simulator and device:** the tour and the hand checks in step 3 pass on
  iPhone and iPad.
- **Real backend:** GitHub sign-in, Keychain storage (no entitlement change
  needed), download, edit, publish to a test branch, pull, the branch
  conflict prompt, deployments, Photos import and validation all work.
- **Liquid Glass:** adopted as step 6 describes, through
  `Views/Common/Glass.swift`, except the optional search behavior (item 8).
- **Bugs found and fixed along the way:** bold styling spreading through the
  body, Settings → Branch doing nothing, the Publish sheet stuck on
  "Checking images…" after a revert, and media thumbnails taking taps meant
  for the tab picker.

Steps 0–6 are kept below for reference. Step 7 is still open.

## 0. Prerequisites

- Xcode 26 or later, with an iOS simulator runtime (Xcode → Settings →
  Components).
- Rust via rustup. `native/rust-toolchain.toml` pins 1.97.1, and the build
  adds the iOS targets.
- Node 24 and pnpm 11 (`corepack enable pnpm`).
- XcodeGen: `brew install xcodegen`.
- Possibly cmake (`brew install cmake`). See the notes under step 2.

## 1. Get the branch

```sh
git fetch origin
git switch explore-native-ios-app
```

## 2. Bootstrap

```sh
apps/ios/scripts/bootstrap.sh
```

It checks the prerequisites and installs JS dependencies. Then it bundles
`Posto/Resources/engine.js` and runs `scripts/build-native.sh`. That builds
release static libraries for `aarch64-apple-ios`, `aarch64-apple-ios-sim` and
`x86_64-apple-ios` and packages `native/build/PostoNative.xcframework`.
Finally it generates `apps/ios/Posto.xcodeproj`. The first Rust build takes
several minutes.

**The Rust iOS build is the step most likely to fail.** It compiles these C
dependencies for iOS: libgit2 (vendored), OpenSSL (vendored), aws-lc
(rusty-s3), and libwebp. The Tauri app's iOS build (`pnpm tauri ios build`)
compiles the same crates on Xcode 27, so when something breaks, compare with
that build's settings:

- **aws-lc-sys** may want `cmake` (and possibly `ninja`) for iOS targets.
  Install them and retry.
- **`IPHONEOS_DEPLOYMENT_TARGET`** defaults to 15.0, the Tauri app's minimum.
  The app itself targets iOS 17.
- **Build scripts:** `build-native.sh` unsets `SDKROOT` so host build scripts
  aren't compiled for iOS. If a crate's build script still picks the wrong
  SDK, that's the place to look.
- **`POSTO_GITHUB_CLIENT_ID`** is exported from the repo's
  `.cargo/config.toml`. Without it, sign-in fails with "GitHub sign-in is not
  configured for this build".
- **Intel Mac:** the `x86_64-apple-ios` simulator slice is only there for the
  previous Intel Mac. If it causes trouble on Apple Silicon, drop it from
  `simulator_targets` in `build-native.sh`.

When it succeeds, `native/build/PostoNative.xcframework` exists, and
`Posto.xcodeproj` references it.

## 3. Build and run the demo

```sh
apps/ios/scripts/run-simulator.sh --demo
```

Or open `apps/ios/Posto.xcodeproj` and run the **Posto Demo** scheme. Demo
mode runs on fixture content and needs neither Rust nor the network; the
binary still links the xcframework.

**Compile errors to expect.** The code typechecked as Mac Catalyst with Swift
6.1. The newer compiler and the iOS SDK may surface:

- **Swift 6.2+ diagnostics.** The project uses Swift 5 language mode
  (`SWIFT_VERSION: "5.0"` in `project.yml`); keep it, and fix any errors that
  appear.
- **`Posto/Native/RustBackend.swift`** is the only file that uses the C module.
  If `import PostoNative` fails, check that the xcframework's
  `Headers/PostoNative/module.modulemap` is there.
- **The UIKit files:** `MarkdownTextView.swift` and `SafariView.swift`.

Then run the walkthrough, and compare its snapshots with the earlier Mac
Catalyst ones in `build/tour*`, if you have them:

```sh
apps/ios/scripts/run-simulator.sh --tour   # snapshots land in apps/ios/build/tour-simulator
```

Things to check by hand:

- iPhone: tree → editor push and back.
- iPad: tree and editor side by side.
- The keyboard's formatting bar.
- Photos import.
- The full-screen body editor.

## 4. Run it for real

```sh
apps/ios/scripts/run-simulator.sh
```

1. Tap **Continue with GitHub**. A person has to approve the device code on
   github.com.
2. Download a repository, open a post, edit a field and the body, and publish.
   Publish to a test branch (Settings → Branch → create one), not `main`.
3. Check: a pull when the remote is ahead, a branch switch with uncommitted
   edits (the conflict prompt), deployments, Media import from Photos, and
   validating a library item.

**Keychain.** The GitHub session is stored by `apple-native-keyring-store` in
its "protected" mode, as in the Tauri iOS app. If sign-in fails with
`-34018` (errSecMissingEntitlement), add the Keychain Sharing capability (or
an explicit `keychain-access-groups` entitlement) in `project.yml` and
regenerate.

## 5. Device build

The project signs with team `K56D2LK4DS`, from `src-tauri/tauri.conf.json`,
and bundle ID `net.megaflora.posto`: the app is "Posto" and replaces the Tauri
iOS app, keeping its sign-in and downloaded repositories. (It was
`net.megaflora.posto.native`, "Posto Native", until 2026-11-21; an install
under that identifier is a separate app and can be deleted.) The Tauri iOS
build moved to `net.megaflora.posto.tauri`. Run `pnpm build:ios` from the
repository root, or pick the device in Xcode and run the **Posto** scheme.

## 6. Liquid Glass

Standard SwiftUI components get Liquid Glass automatically when built with the
iOS 26 SDK: navigation bars, toolbars, sheets, menus, search fields, segmented
pickers and the iPad sidebar. Never set `UIDesignRequiresCompatibility`. The
custom pieces below need explicit adoption.

**Gating.** The app's deployment target is iOS 17, so wrap each use in
`if #available(iOS 26.0, *)`. Also wrap it in `#if compiler(>=6.2)` so
`scripts/typecheck.sh` keeps working on Macs with older SDKs. Putting small
helpers in a new `Posto/Views/Common/Glass.swift` (for example
`prominentActionStyle()`, `glassPanel(cornerRadius:)` and a `CloseButton`)
keeps the gating in one place.

### Signatures checked against Apple's documentation

| API                | Declaration                                                                                                                                | Availability         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| Glass background   | `glassEffect(_ glass: Glass = .regular, in shape: some Shape = DefaultGlassEffectShape())`                                                 | iOS 26               |
| Interactive glass  | `Glass.interactive(_ isEnabled: Bool = true) -> Glass`                                                                                     | iOS 26               |
| Glass group        | `GlassEffectContainer`                                                                                                                     | iOS 26               |
| Button styles      | `PrimitiveButtonStyle.glass`, `.glassProminent`                                                                                            | iOS 26               |
| Button roles       | `ButtonRole.close`, `.confirm`; `Button(role:action:)` (system label)                                                                      | iOS 26               |
| Toolbar spacer     | `ToolbarSpacer(_ sizing: SpacerSizing = .flexible, placement: ToolbarItemPlacement = .automatic)`, with `SpacerSizing.fixed` / `.flexible` | iOS 26               |
| Nav subtitle       | `navigationSubtitle(_:)`, taking `some StringProtocol`, `Text` or `LocalizedStringKey`                                                     | iOS 26 (Catalyst 14) |
| Scroll edge effect | `scrollEdgeEffectStyle(_ style: ScrollEdgeEffectStyle?, for edges: Edge.Set)`                                                              | iOS 26               |
| Search behavior    | `searchToolbarBehavior(_ behavior: SearchToolbarBehavior)`                                                                                 | iOS 26               |
| UIKit scroll edges | `UIScrollView.topEdgeEffect` (also `bottom`, `left`, `right`); `UIScrollEdgeEffect.isHidden`                                               | iOS 26               |

### Where to apply them

1. **Publish bar** (`Views/Repo/RepoSidebarView.swift`).
   - Today, `safeAreaInset` puts a `.borderedProminent` button on a `.bar`
     background.
   - On iOS 26, drop the `.bar` background so the button floats, and use
     `.buttonStyle(.glassProminent)`.
   - Add `.scrollEdgeEffectStyle(.soft, for: .bottom)` to the list so rows
     fade under it.
   - The Pull button in the "Updates are available" notice can use `.glass`.
2. **Sheet dismiss buttons.** Replace `Button("Cancel")` / `Button("Done")`
   with `Button(role: .close) { dismiss() }`, keeping their
   cancellation/confirmation placements. They appear in:
   - `EditorView`, `FieldViews` (template and rows sheets), `InsertViews`,
     `MediaFieldViews`
   - `MediaSheets`, `SignInView` (device code "Cancel"), `PublishSheet`
   - `CollectionSettingsView`, `SiteSettingsView`, `AppSettingsView`
   - Keep text labels on actions that do work ("Publish", "Save", "Insert",
     "Import"). The confirmation placement already renders those prominently.
3. **Editor title** (`Views/Editor/EditorView.swift`).
   - Replace the custom `.principal` stack (name plus save state) with
     `.navigationTitle(name)` and `.navigationSubtitle(saveStateText)`.
   - Put a `ToolbarSpacer(.fixed)` between the raw-file toggle and Delete, so
     Delete gets its own glass group.
4. **Media selection bar** (`Views/Media/MediaView.swift`, `manageToolbar`).
   - Replace the `Spacer()` inside the bottom-bar `ToolbarItemGroup` with
     `ToolbarSpacer(.flexible, placement: .bottomBar)`; split the group into
     items if needed.
   - The two floating overlays (validation progress and "Preparing images…")
     use `.background(.regularMaterial, in:)`. Switch them to
     `.glassEffect(in: .rect(cornerRadius: 14))`.
5. **Sign-in** (`Views/Onboarding/SignInView.swift`).
   - "Continue with GitHub" and "Open GitHub" → `.glassProminent`.
   - "Explore a demo site" → `.glass`.
   - The device-code pill (`.background(.quaternary, in:)`) →
     `.glassEffect(.regular.interactive(), in: .rect(cornerRadius: 14))`.
6. **Download sheet buttons** (`Views/Onboarding/RepositoriesView.swift`):
   `.bordered` → `.glass`, `.borderedProminent` → `.glassProminent`.
7. **Inline body editor** (`Views/Editor/MarkdownTextView.swift`).
   - For the non-scrolling text view inside the form (`scrolls == false`), set
     the `topEdgeEffect`, `bottomEdgeEffect`, `leftEdgeEffect` and
     `rightEdgeEffect` to `isHidden = true`.
   - t3code found that a nearby bar's edge effect otherwise draws over the
     typed text: [`T3ComposerEditorView.swift`](https://github.com/pingdotgg/t3code/blob/main/apps/mobile/modules/t3-composer-editor/ios/T3ComposerEditorView.swift),
     around `textView.topEdgeEffect`.
   - Leave the full-screen editor alone; its soft edge under the nav bar is
     wanted.
8. **Repositories search** (optional): `.searchToolbarBehavior(.minimize)` if
   bottom placement of the search field feels heavy on iPhone.

### Checking it

- Run the demo walkthrough on an iOS 26+ simulator in light and dark mode,
  at iPhone and iPad sizes.
- Sheets at the medium detent and the floating Publish bar are the most
  visible changes.
- Keep `scripts/typecheck.sh` passing on older SDKs: that's what the
  `#if compiler(>=6.2)` gates are for.

## 7. Release polish (optional)

- **Engine size:** `engine.js` is about 750 KB unminified. For Release builds,
  set `POSTO_ENGINE_MINIFY=1` in the "Bundle engine" phase (`project.yml` →
  `preBuildScripts`).
- **Debug-only code:** `DemoTour`, `LaunchOptions` and `SocketBackend` compile
  only in Debug, which is intended.

## Reference

- **Debug launch arguments:**
  - `-PostoDemo`: fixture content.
  - `-PostoTour <dir>`: snapshot every screen, then quit. A relative path
    resolves inside the app's Documents folder.
  - `-PostoTourCompact`, `-PostoTourDark`
  - `-PostoOpenRepo <root> -PostoRepo <owner/name> [-PostoBranch <b>]`: open
    a downloaded repository without signing in.
  - `-PostoBackendSocket <path>`: use `Tools/BackendHost` instead of the
    linked bridge (Mac Catalyst previews).
- **Shared code:** the native app reuses `packages/editor`. One commit
  (`move pure editor helpers out of react components`) moved helpers out of
  React components; desktop typechecks and all 223 editor tests pass.
- **Differences from the Tauri app:** see README.md. Briefly, the body is a
  styled markdown editor rather than TipTap, and image-library metadata opens
  in the asset editor.
- **Commits:** this repo uses short, lowercase, imperative subjects (for
  example "add the rust bridge for the native ios app"), with a body explaining
  why. Don't add AI attribution trailers.

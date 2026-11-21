# Posto for macOS (native prototype)

A native SwiftUI version of the desktop app, for comparing how it feels
against the Tauri app. It reuses almost everything from the native iOS app
([../ios](../ios)): the JavaScript engine, the Swift models, and most views
(the editor form and fields, the body editor's cards, media, publish,
branches, deployments). Only the window layout, the preview pane and an
NSTextView body editor are its own.

```
SwiftUI (PostoMac + ../ios/Posto/Views) ─► ../ios/Posto/Models ─► engine.js ─► Rust bridge (desktop build)
```

## Layout

The panes follow the Tauri desktop app:

- **Sidebar:** files or the media library (the segmented switch at its
  top, or ⌘1 and ⌘2). ⌘\ hides and shows it.
- **Editor and preview** side by side, 40/60 to start (as the desktop app
  opens), with a divider to drag.
  - **Editor:** the open file's form and body, with a formatting bar.
    ⌘B, ⌘I and ⌘K work while the body has focus.
  - **Preview:** the site's dev server, started for the project that's
    open. If Node, the package manager or dependencies are missing, it
    shows a checklist and installs them with one click. It follows the
    open file to its page, opening a page in the preview opens its file,
    and switching branches restarts it.
- **Full-screen editor** (⇧⌘F): the editor covers the window in a centered
  760-pt column, as on desktop. Files and Media float over its left and
  right edges on hover, ⌘\ pins both, and Files stays pinned while no file
  is open. The editor and the preview's page survive the switch.

File menu, as on desktop:
- Open File… (⌘O), a palette of the site's files
- Open Folder…
- Open Recent… (⇧⌘O), a palette
- Open Sibling Project… (monorepos)
- Close Folder

Site menu: Publish… (⇧⌘P), Pull, Switch Branch… (⇧⌘B), Deployments, Site
Settings, Restart Preview Server.

Settings (⌘,): developer mode and the GitHub account used for deployments.
Signing out keeps the folder open.

## Building

```sh
../ios/scripts/build-native.sh   # also builds the macos slice (the `desktop` feature)
xcodegen generate
open PostoMac.xcodeproj          # run the PostoMac scheme
```

The app isn't sandboxed: like the Tauri app, it opens any folder and runs
its dev server.

## How it differs from the iOS app's backend

The macOS slice of `PostoNative.xcframework` is src-tauri's **desktop**
build (`cargo build --features desktop`): folders on disk rather than
managed clones, commits with the user's own git identity and credentials,
and the dev server, preview proxy and file watcher. The iOS slices stay the
mobile build.

## Notes

- **GitHub session:** it lives in the login Keychain under the same service
  as the Tauri app's, so the first launch may ask to allow access; after
  that both apps share the sign-in.
- **Changes from other apps:** the engine watches the project with the
  desktop app's ignore rules (Astro's `.astro/` churn included). Edits made
  elsewhere refresh the sidebar and reload the open file, unless an edit
  of yours is still pending.
- **PATH:** like the Tauri app (fix-path-env), it adopts the login shell's
  PATH at launch so node and the package manager resolve.
- **Astro 7** runs `astro dev` in the background when it detects an AI
  agent in the environment. Launched from a terminal an agent controls,
  the preview can't track the server; launch the app from Finder or Xcode.
- **Scripted checks (Debug):** `-PostoOpen <folder>` opens a folder at
  launch; `-PostoRemote <dir>` accepts JSON commands in `<dir>/cmd.json`
  (open, select, sidebar, fullscreen, publish, embed, type, state, views,
  snapshot, …; see `PostoMac/MacDebugRemote.swift`).

## Not here yet (compared with the desktop app)

- Dragging files in from Finder, and media into the body or fields
- The preview's Search/Socials (SEO) tab
- The live deployment ring in the preview header (Deployments is a sheet)
- A delete button on each file row (only the open file can be deleted)

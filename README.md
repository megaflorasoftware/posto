# Posto

A minimal desktop editor for personal websites, built with Tauri 2, SolidJS, and [Web Awesome](https://webawesome.com) components.

## What it does

- Pick a local directory holding your site (JS-based sites with a `dev`/`start` script in `package.json`, or Eleventy sites).
- Browse text files (`.md`, `.html`, `.css`, …) in a sidebar tree and edit them with autosave.
- A live dev-server preview runs in the right pane, on an automatically chosen free port.
- **Publish** commits all local changes as "Site updates" and pushes to `origin`.

## Development

```sh
pnpm install
pnpm tauri dev     # run the app
pnpm tauri build   # build a distributable
```

## How it works

- `src-tauri/src/lib.rs` holds all backend commands: file tree listing (filtered to text files), read/write, dev-server lifecycle (spawn, port ping, kill on exit), and git publish.
- The dev server is detected from the site directory: a `dev` or `start` script runs via the site's package manager (pnpm/yarn/npm by lockfile) with `--port <free port>` and `PORT` set; otherwise an Eleventy config falls back to `npx @11ty/eleventy --serve`.
- `src/App.tsx` is the whole UI: navbar, `wa-tree` sidebar, and a `wa-split-panel` with a textarea editor (debounced autosave) and an iframe preview.

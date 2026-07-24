---
title: Getting started
description: Set up the Posto monorepo and run the app, tests, linting, and formatting locally.
---

Posto is a [pnpm](https://pnpm.io) workspace with a [Tauri](https://tauri.app) backend written in Rust. Frontend apps and shared TypeScript packages live under `apps/` and `packages/`; native code lives in `src-tauri/`.

```
apps/
  desktop/   Tauri desktop app (React + Mantine)
  mobile/    Tauri mobile app
  docs/      This documentation site (Astro Starlight)
packages/
  core/      Framework adapters, parsing, and configuration logic
  editor/    Shared rich-text editor components
  ipc/       Typed wrappers around Tauri commands
src-tauri/   Rust backend
```

## Prerequisites

- **Node 24** (the exact development version is in `.nvmrc`)
- **pnpm 11.8.0** (pinned in `package.json`)
- The **[Rust toolchain](https://www.rust-lang.org/tools/install)** and **[Tauri's system dependencies](https://tauri.app/start/prerequisites/)**

Install workspace dependencies from the repo root:

```sh
pnpm install
```

## Everyday commands

Run these from the repo root:

| Command          | What it does                                                |
| ---------------- | ----------------------------------------------------------- |
| `pnpm dev`       | Run the desktop app in development                          |
| `pnpm build`     | Type-check and build the desktop app                        |
| `pnpm test`      | Run the TypeScript test suites (Vitest) across all packages |
| `pnpm typecheck` | Type-check every package and app (`tsc --noEmit`)           |
| `pnpm check`     | Run formatting, lint, and type-aware Vite+ checks           |
| `pnpm format`    | Format supported files with Vite+                           |
| `pnpm lint`      | Run Vite+ lint checks                                       |

Rust checks run from `src-tauri/`:

```sh
cd src-tauri
cargo fmt          # format
cargo clippy       # lint
cargo test         # test
```

## Testing

TypeScript tests use [Vitest](https://vitest.dev) and live alongside the code they cover (for example, `packages/core/test/`).

```sh
pnpm test                      # run every package's suite once
pnpm --filter @posto/core test:watch   # watch mode for a single package
```

Rust tests run with `cargo test` from `src-tauri/`.

## Linting and formatting with Vite+

Formatting, linting, and type-aware analysis use [Vite+](https://viteplus.dev) (`vp`), which combines Oxfmt, Oxlint, and tsgolint:

```sh
pnpm check          # format, lint, and type-aware checks
pnpm format         # write formatting changes
pnpm lint           # lint without formatting
```

The root `vite.config.ts` defines repository-wide formatting, ignore patterns, and type-aware linting. Each app keeps a separate `vite.config.ts` for development and builds.

:::note[Installing Vite+] Install Vite+ with the official script: `curl -fsSL https://vite.plus | bash`. If `vp` reports that it cannot find a native binding, reinstall it with the same script to restore the platform-specific Oxfmt and Oxlint packages. :::

## Continuous integration

`.github/workflows/check.yml` runs on pull requests and pushes to `main`:

- **TypeScript** — install with the lockfile, type-check, test, verify formatting, and lint with warnings denied
- **Rust** — `cargo fmt --check`, `cargo clippy -- -D warnings`, and `cargo test`

The Rust job always reports a result, but its expensive steps run only when `src-tauri/` or the workflow changes. A documentation-only or frontend-only pull request therefore skips the Rust compile. The Rust version and components are pinned in `src-tauri/rust-toolchain.toml` for both CI and local commands.

A separate `release.yml` builds and publishes the app on tagged releases.

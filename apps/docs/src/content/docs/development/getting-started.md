---
title: Getting Started
description: Set up the Posto monorepo and run the app, tests, linting, and formatting locally.
---

Posto is a [pnpm](https://pnpm.io) workspace wrapped around a [Tauri](https://tauri.app)
(Rust) backend. The frontend apps and shared packages live under `apps/` and
`packages/`; the native backend lives in `src-tauri/`.

```
apps/
  desktop/   Tauri desktop app (React + Mantine)
  mobile/    Tauri mobile app
  docs/      This documentation site (Astro Starlight)
packages/
  core/      Framework-agnostic parsing/config logic (has the test suite)
  editor/    Shared rich-text editor components
  ipc/       Typed wrappers around Tauri commands
src-tauri/   Rust backend
```

## Prerequisites

- **Node 22+** and **pnpm 11+**
- The **[Rust toolchain](https://www.rust-lang.org/tools/install)** and
  **[Tauri's system dependencies](https://tauri.app/start/prerequisites/)**

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
| `pnpm check`     | Format, lint, and type-aware checks via Vite+ (`vp check`)  |

Rust checks run from `src-tauri/`:

```sh
cd src-tauri
cargo fmt          # format
cargo clippy       # lint
cargo test         # test
```

## Testing

TypeScript tests use [Vitest](https://vitest.dev) and live alongside the code
they cover (for example, `packages/core/test/`).

```sh
pnpm test                      # run every package's suite once
pnpm --filter @posto/core test:watch   # watch mode for a single package
```

Rust tests run with `cargo test` from `src-tauri/`.

## Linting & formatting (Vite+)

Formatting, linting, and type-aware analysis go through
[Vite+](https://viteplus.dev) (`vp`), which bundles Oxfmt, Oxlint, and tsgolint
into a single command:

```sh
vp check           # format + lint + type-aware checks
vp check --fix      # auto-fix formatting and lint issues
```

Root configuration lives in `vite.config.ts` (ignore patterns and type-aware
linting); each app keeps its own `vite.config.ts` for dev and build.

:::note[Installing Vite+]
Install Vite+ with the official script: `curl -fsSL https://vite.plus | bash`.
If `vp` fails with "Cannot find native binding", the install is missing its
platform-native Oxfmt/Oxlint bindings — reinstall with the script above.
:::

:::note[First run reports existing differences]
The source predates this tooling, so `vp check` currently reports formatting
differences and a set of type-aware lint warnings. Run `vp check --fix` once (as
its own commit) to normalize formatting, then triage the remaining lint
warnings. Until then the Vite+ step in CI is informational (non-blocking).
:::

## Continuous integration

`.github/workflows/check.yml` runs on every pull request:

- **TypeScript** — `pnpm typecheck` and `pnpm test`
- **Rust** — `cargo fmt --check`, `cargo clippy -- -D warnings`, and `cargo test`

The Rust checks only run when files under `src-tauri/` (or the workflow itself)
change, so a docs- or frontend-only pull request skips the Rust compile while
the check still reports as passing. The Rust version and components are pinned in
`src-tauri/rust-toolchain.toml`, which both CI and local `cargo` pick up
automatically.

A separate `release.yml` builds and publishes the app on tagged releases.

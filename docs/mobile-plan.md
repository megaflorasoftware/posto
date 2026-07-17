# Posto Mobile Plan (iOS + Android)

> **Local working doc — do not commit.** `docs/` stays untracked; keep it out
> of every PR.

Goal: bring Posto's file pane + editor + publish flow to mobile. **No preview,
no dev server, no environment setup on mobile.** Desktop stays fully featured
and releasable at every step.

## Locked decisions

| Decision | Choice |
| --- | --- |
| Mobile data model | On-device git clone into the app sandbox via **git2-rs (libgit2)**. The existing command surface (`list_files`, `read_text_file`, `write_text_file`, `changed_files`, `publish`, `pull_upstream`, …) works unchanged against local paths. |
| Desktop git | **Unify on libgit2 too.** CLI git shelling (`run_git`) and the `install_git`/Xcode-CLT setup step are removed. One git implementation, all platforms. |
| Mobile auth (v1) | **GitHub sign-in only**, via OAuth **device flow** (needs only a public `client_id`, no server, no secret). Token stored in iOS Keychain / Android Keystore; used for HTTPS clone/fetch/push. |
| Frontend structure | **Two entries, shared packages** in a pnpm workspace: `packages/*` for shared logic + editor components, `apps/desktop` and `apps/mobile` as thin shells. One repo, one `src-tauri`. |
| Platform order | **iOS first, Android-ready** (no iOS-only APIs; rustls/vendored TLS; Android bring-up is a later phase). |
| Mobile v1 scope | **Full editing parity minus preview**: file pane, Fields/Body/Raw tabs, new file, delete, revert, publish, pull. Excluded: preview pane, SEO preview, dev-server + setup flow, updater. |
| Workflow | **Incremental PRs to `main`.** The git2 migration ships in a desktop release and soaks before mobile builds on it. |
| Commit convention | All commits authored as **hfellerhoff** (Henry), with **no Claude/AI attribution or co-author trailers**. Messages are **lowercase and brief** (e.g. `release v0.6.0`, `support html in md/mdx`). |

## Why no monorepo split is needed

Tauri v2 builds desktop, iOS, and Android from a **single `src-tauri` project**
(`tauri ios init` / `tauri android init` add `gen/` folders next to it).
Platform-specific config files (`tauri.ios.conf.json`, `tauri.android.conf.json`)
override `build.frontendDist` / `beforeBuildCommand`, so mobile can point at
`apps/mobile/dist` while desktop keeps `apps/desktop/dist`. Frontend sharing is
handled by pnpm workspaces inside this same repo. A separate repo would force
publishing shared packages and syncing the Rust core — pure overhead here.

## Target layout

```
posto/
├── package.json                 # workspace root (scripts only)
├── pnpm-workspace.yaml          # packages/*, apps/*
├── packages/
│   ├── core/                    # pure TS, no Tauri imports
│   │   ├── pagescms/            # (moved from src/pagescms)
│   │   ├── astro/               # (moved from src/astro)
│   │   └── mdx/                 # (moved from src/mdx)
│   ├── ipc/                     # invoke wrapper, shared types, browser mock
│   └── editor/                  # BodyEditor, FieldEditor, FormEditor,
│   │                            # MdxNodes, HtmlNodes, ImagePicker,
│   │                            # ComponentPicker, NewFileModal, shared hooks
├── apps/
│   ├── desktop/                 # current App.tsx shell: preview, SeoPreview,
│   │   │                        # setup flow, updater, split panes
│   │   └── vite.config.ts
│   └── mobile/                  # new shell: onboarding, repo list,
│       │                        # file pane ⇄ editor navigation stack
│       └── vite.config.ts
└── src-tauri/
    ├── tauri.conf.json          # desktop (frontendDist: ../apps/desktop/dist)
    ├── tauri.ios.conf.json      # mobile override (../apps/mobile/dist)
    ├── tauri.android.conf.json
    └── src/
        ├── lib.rs               # builder + handler registration only
        ├── fs.rs                # list/read/write/create/delete, frontmatter titles   [all]
        ├── watch.rs             # notify watcher                                      [desktop]
        ├── git/
        │   ├── mod.rs           # status/revert/fetch/pull/publish via git2           [all]
        │   └── creds.rs         # CredentialProvider trait + impls                    [split]
        ├── repos.rs             # clone + managed-repo registry in app data dir       [mobile]
        ├── auth.rs              # GitHub device flow + secure token storage           [mobile]
        ├── settings.rs          # last_root/recent_roots                              [all]
        ├── devserver.rs         # spawn/ping/logs/stop, detect_dev_command            [desktop]
        ├── proxy.rs             # preview proxy + reporter injection                  [desktop]
        └── env.rs               # node/pm/deps provisioning (install_git deleted)     [desktop]
```

Platform gating rules (the anti-spaghetti contract):

- Rust: gate at **module level** with `#[cfg(desktop)]` / `#[cfg(mobile)]`
  (Tauri defines both). No `cfg` branches inside shared functions; if a shared
  function needs platform behavior, it takes a trait (see `CredentialProvider`).
- TS: `packages/*` never imports platform-specific code and never checks the
  platform. All divergence lives in `apps/desktop` vs `apps/mobile`. The `ipc`
  package exposes the full command surface; mobile simply never calls the
  desktop-only commands.

---

## Phase 0 — Componentize what exists (no behavior change)

Land as 2–3 mechanical PRs. Desktop must be pixel-identical after each.

**0a. ✅ DONE (PR #2, merged)** — Split `src-tauri/src/lib.rs` (1667 lines) into the modules above —
pure code motion. `run_git` stays for now (dies in Phase 1). Add the
`#[cfg(desktop)]` gates to `devserver`/`proxy`/`env`/`watch` so the crate
already compiles under a mobile cfg.

**0b. ✅ DONE (PR #3, merged)** — Decompose `src/App.tsx` (1448 lines) into components + hooks that the
two future shells will share or own:

- Shared (→ `packages/editor` in Phase 2):
  - `Sidebar` / `FileList` (exists), `EditorPane` (Fields/Body/Raw tab host),
    `PublishPanel` (changes list, commit message, `RevertButton`,
    `DeleteFileButton`), `NewFileModal` (exists)
  - Hooks: `useFileGroups(root)`, `useCurrentFile(path)` (load + autosave +
    save-state), `useGitSync(root)` (changed files, fetch/pull polling,
    publish), `useSchemas(root)` (pages config + astro collections)
- Desktop-only (stays in the shell): `PreviewPane`, `SeoPreview`,
  `SetupFlow` (env checks/installs), `DevServerLogs`, split-pane drag,
  updater wiring.

Acceptance: `App.tsx` < ~300 lines of composition; no component both renders
desktop-only UI and owns shared state.

## Phase 1 — Git via libgit2 (the load-bearing migration) ✅ DONE (PR #4, merged; v0.7.0 shipped)

**1a. Add `git2`** with `features = ["vendored-libgit2", "vendored-openssl"]`
(vendoring is required for iOS/Android cross-compilation anyway; keep the
`ssh` feature desktop-relevant — see risks).

**1b. Implement `git::Client`** replacing each `run_git` call site 1:1:

| Current CLI | git2 equivalent |
| --- | --- |
| `status --porcelain` → `changed_files` | `statuses()` with `include_untracked`, map to the same `"M" / "A" / "D" / "??"` codes the frontend expects |
| `revert_file` (checkout HEAD -- path / delete untracked) | `checkout_head` with path filter + force; `std::fs::remove_file` for untracked (same as today) |
| `fetch` + `rev-list --count HEAD..@{u}` | remote fetch with cred callbacks + `graph_ahead_behind` |
| `merge --no-edit -X theirs @{u}` | annotated merge with `MergeOptions::file_favor(FileFavor::Theirs)` + commit |
| `stash push --include-untracked` / `pop` / conflict → keep merged | `stash_save` with `INCLUDE_UNTRACKED` / `stash_pop`; on conflict, resolve index to "ours" stage and drop stash — port the exact choreography in `pull_upstream` (lib.rs:1394-1428) |
| `add -A` + `commit` + `push origin HEAD` → `publish` | index `add_all`, `commit`, `push` with cred callbacks |

**1c. `CredentialProvider` trait** in `git/creds.rs`:

- `DesktopCreds`: git2-rs's `CredentialHelper` (reads git config, runs the
  system credential helpers like `osxkeychain` / `gh`) + `Cred::ssh_key_from_agent`
  for ssh remotes. Commit identity from repo/global git config as today.
- `MobileCreds` (Phase 3): username `x-access-token` / stored OAuth token;
  commit identity from the GitHub profile captured at sign-in
  (name + `<id>+<login>@users.noreply.github.com`).

**1d. Parity tests** (the most important deliverable of the phase): Rust
integration tests with temp repos + a local bare "origin" covering: dirty-tree
pull with non-conflicting upstream changes, conflicting changes (server wins),
untracked-file stash round-trip, publish with nothing to commit, revert of
tracked vs untracked, behind-count detection. These pin the semantics the
desktop app already has.

**1e. Delete** `run_git`, `install_git`, the git branch of `check_environment`
/ the "git" setup step in the frontend. Ship a desktop release (v0.7.0) and
**let it soak** before starting Phase 3.

## Phase 2 — Frontend workspace restructure ✅ DONE

- Add `pnpm-workspace.yaml`; move code per the target layout. `packages/core`
  and `packages/ipc` must have zero React-DOM/Mantine-layout assumptions;
  `packages/editor` may use Mantine but not window-size assumptions.
- `apps/desktop` = today's app, imports from packages. Update
  `tauri.conf.json` `beforeBuildCommand`/`frontendDist` paths and CI.
- Keep the browser mock in `packages/ipc` working (`pnpm --filter desktop dev`
  outside Tauri) — it's also how the mobile shell gets developed quickly.
- Acceptance: desktop build + release pipeline green; no `src/` left at root.

## Phase 3 — Mobile foundation (Rust)

- `pnpm tauri ios init`; confirm the gated crate compiles for
  `aarch64-apple-ios` + simulator (this validates vendored libgit2/openssl —
  do it before writing any mobile UI).
- `repos.rs`: `clone_repo(url) -> root` into
  `app_data_dir/repos/<owner>/<name>` with progress events (git2 transfer
  progress → Tauri events); `list_repos`, `remove_repo`. On mobile,
  "open a site" = pick from this registry instead of the OS directory dialog.
  Consider `--depth`-equivalent shallow clone (libgit2 ≥ 1.7) for large repos —
  optional, note as v1.1.
- `auth.rs`: GitHub **device flow** (`POST /login/device/code`, poll
  `/login/oauth/access_token`; scope `repo`) via `reqwest` (rustls). These
  endpoints have no CORS, so this must live in Rust, not the webview.
  Store token via the `keyring` crate (Keychain/Keystore); expose
  `auth_status` / `sign_in` / `sign_out` commands. Small `list_user_repos`
  command (GitHub API) to power the repo picker.
- Mobile gating fallout:
  - `watch.rs` is desktop-only; on mobile, `repos`/`git` commands emit
    `fs-changed` manually after pull/clone so the frontend refresh path is
    identical.
  - `get_last_root`/recents work as-is (paths are sandbox paths).
  - `convertFileSrc` asset protocol works on mobile — ImagePicker keeps working
    against the cloned repo's media dir.

## Phase 4 — Mobile app shell (React)

- `apps/mobile`: navigation-stack UI (screens, not split panes):
  1. **Onboarding**: sign in with GitHub (show device code + open browser) →
     repo picker → clone with progress.
  2. **Repo home**: file groups (reuse `FileList` data, restyled list),
     pull banner when behind, publish button.
  3. **Editor screen**: Fields/Body/Raw tabs from `packages/editor`;
     autosave via the same `useCurrentFile` hook.
  4. **Publish sheet**: changes list, commit message, revert/delete.
- Touch work: Tiptap on mobile WebKit (selection, toolbar above keyboard),
  safe-area insets, `visualViewport` keyboard handling, pull-to-refresh →
  `fetch_upstream`.
- Sync policy: reuse desktop semantics (poll fetch every 30s while foregrounded,
  pull = server wins) + trigger fetch on app foreground.
- Acceptance: on an iPhone — sign in, clone a real Astro site, edit frontmatter
  + body, publish, see the commit on GitHub; pull a change made elsewhere.

## Phase 5 — iOS distribution polish

Icons/launch screen, bundle id + signing, TestFlight, background/terminate
behavior (autosave flush), App Store notes (no downloaded code — all native,
token in Keychain). The desktop `updater`/`process` plugins stay desktop-only.

## Phase 6 — Android bring-up

`tauri android init`; NDK cross-compile check of vendored libgit2/openssl
(consider `rustls` where possible); Keystore via the same `keyring` API;
back-button navigation; then track iOS feature-for-feature.

---

## Known risks & constraints (tracked, not blocking)

1. **SSH remotes on desktop** after the git2 migration: `ssh_key_from_agent`
   covers the common case; exotic setups (custom `core.sshCommand`, hardware
   keys) may regress vs CLI git. Mitigation: soak period + clear error
   messaging suggesting an HTTPS remote.
2. **Git LFS is not supported by libgit2.** Media-heavy repos using LFS will
   clone pointers, not images. Desktop today (CLI git) has the same gap unless
   the user installed LFS. Document; revisit if it bites.
3. **Schema intelligence on mobile** needs `.astro/collections/*.schema.json`
   committed (no `astro sync` on device). `.pages.yml`-driven forms work
   regardless. Document for site authors; consider a CI snippet that commits
   generated schemas.
4. **Tiptap touch UX** is the main unknown-unknown in Phase 4; timebox a spike
   early (editing a real post on an iPhone) before polishing the rest.
5. **`keyring` on iOS/Android** — verify early in Phase 3; fallback is a small
   Swift/Kotlin Tauri plugin wrapping Keychain/Keystore directly.
6. **Device-flow client_id** ships in the app (that's how device flow works —
   no secret involved). Register the OAuth app under the posto org and enable
   device flow.

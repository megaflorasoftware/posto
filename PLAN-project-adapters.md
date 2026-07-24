# Project adapters: de-coupling Posto from Astro

A phased re-architecture that makes "what kind of site is this?" a first-class, top-level decision. Posto detects **one primary project type** per opened root (Astro, Eleventy, plain Pages CMS, generic markdown, …) and routes every framework-derived behavior — schema discovery, routing, site URL, watch rules, dev-server hints, feature availability — through an adapter for that type, instead of hard-coding Astro conventions across the editor, apps, and backend.

Companion doc: `PLAN-immediate-fixes.md` covers one-off fixes that do not depend on this work. Land those first where they overlap (notably T2's structured file reads and T3's diagnostics channel, both of which this plan builds on).

---

## 1. Where we are

### What is already right

- **`PagesConfig` is the internal lingua franca.** `.pages.yml`, Astro collections, and `.posto` overlays all resolve into one neutral schema model (`packages/core/src/pagescms/config.ts`), and the entire form/editor pipeline consumes only that. This is the foundation the adapter layer stands on — it does not need to be invented.
- **The Rust filesystem layer is framework-agnostic** (`fs.rs` has zero Astro references), and `devserver.rs` already detects `dev`/`start` scripts generically with an Eleventy fallback.
- **Astro parsing is mostly contained** in `packages/core/src/astro/*`.

### Where Astro leaks today (the blocking files)

| File                                      | Leak                                                                                                                                                                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/editor/src/hooks/useSchemas.ts` | Hard-codes the Astro discovery protocol: `.astro/collections/*.schema.json`, `src/content.config.ts`, `src/content/config.ts`; merges Astro config into the effective config inline.                                                            |
| `apps/desktop/src/App.tsx`                | Duplicates those same paths for cache invalidation (`onAfterSave`, `onExternalChanges`, lines ~78-84, 277-296).                                                                                                                                 |
| `apps/desktop/src/routing.ts`             | Astro file-based routing conventions (`src/pages`, content-collection route guessing) living in the desktop app.                                                                                                                                |
| `packages/editor/src/hooks/useSiteUrl.ts` | Astro config filenames + `site:` field regex (with generic CNAME/homepage fallbacks).                                                                                                                                                           |
| `src-tauri/src/watch.rs`                  | Astro-specific ignore rules (`.astro/` except `.astro/collections`).                                                                                                                                                                            |
| `packages/core/src/pagescms/config.ts`    | The _neutral_ type carries Astro members: `astroCollections`, `imageLibraries: AstroImageLibrary[]`, `imageLibraryDiagnostics`, `ContentEntry.astroCustomIds`, reference options `astroId`.                                                     |
| `packages/editor/src/**` (~10 files)      | Direct imports from `@posto/core/astro/*`: `dataEntries.ts`, `useFileGroups.ts` (data documents), `newFile.ts` (`astroEntryId`), the image-library components/hooks, `BodyEditor`/`MdxNodes`/`ComponentPicker` (Astro component props for MDX). |
| `apps/mobile/src/*`                       | Same category of leaks as desktop (RepoHome, Onboarding, MediaLibraryPane reference Astro directly).                                                                                                                                            |

The trend to arrest: every new feature (image libraries, data documents, MDX components) has added _more_ `core/astro` imports into the editor package. The seam gets more expensive every release.

---

## 2. Target architecture

### 2.1 Project type detection

New module `packages/core/src/project/detect.ts`. Given a root and a read-only IO interface, classify the project **once per opened root**. When the opened folder is a monorepo, detection runs on the **working directory** the user picks via the workspace scan and chooser (§2.7) — everything in this section then applies to that directory, not the repo root:

```ts
// "hugo" is reserved as the likely next adapter after Eleventy.
type ProjectType = "astro" | "eleventy" | "hugo" | "generic";

interface ProjectInfo {
  type: ProjectType;
  /** Evidence, for the UI and for diagnostics ("detected Astro via
   *  astro.config.mjs + astro dependency"). */
  signals: string[];
  /** Overlay schema sources present regardless of type. */
  hasPagesYml: boolean;
  hasPostoDir: boolean;
}
```

Detection rules (first match wins; all cheap file existence / package.json checks — no content parsing):

1. **astro** — any `astro.config.{mjs,ts,js,mts,cjs}` present, or `astro` in package.json dependencies, or `.astro/` directory exists.
2. **eleventy** — `.eleventy.js` / `eleventy.config.{js,cjs,mjs}` present, or `@11ty/eleventy` in dependencies.
3. **hugo** — `hugo.{toml,yaml,json}` present, or `config.{toml,yaml,json}` alongside a `content/` or `archetypes/` directory. Reserved now so the type union, detection precedence, and UI labeling don't churn when the adapter lands (likely next after Eleventy); until then it can resolve to the `generic` adapter's behavior.
4. **generic** — no framework detected: plain folder of markdown. Browse/edit works; framework-derived features are off. A `.pages.yml` here still provides full schema-driven editing via the overlay layer — there is deliberately no "pagescms" project type, because `.pages.yml` is not a framework: it is hand-authored schema that can sit on top of _any_ project type, exactly like `.posto/`.

Important semantic decision: **`.pages.yml` and `.posto/` are overlays in the same category, not project-type competitors.** The config resolution order for every project type, highest precedence first:

1. `.posto/` — user presentation preferences (labels, order, sort, templates);
2. `.pages.yml` — hand-authored schema entries;
3. adapter-derived config — whatever the framework adapter recovers (Astro collections today; nothing for `generic`).

This matches today's behavior (`.pages.yml` entries win over Astro-derived ones via `matchEntry`'s first-match ordering; `mergePostoConfig` applies last) — the plan makes the ordering an explicit, documented contract of the new `useSchemas` orchestration rather than an emergent property of merge call order. Only layer 3 comes from the adapter.

Detection result is surfaced in the UI (Setup flow / header badge), so a misdetection is visible and debuggable rather than manifesting as "my forms disappeared".

**Manual override (committed Phase 1 deliverable, not optional).** `.posto/index.json` gains a `project: "<type>"` key that takes precedence over detection unconditionally. Naming a type whose adapter doesn't exist yet (`"hugo"` before Phase 6+) or an unknown string resolves to the `generic` adapter's behavior plus a diagnostic ("project type 'hugo' is not supported by this version; treating as generic") — never an error. `ProjectInfo.signals` records `"overridden via .posto"` so the badge can show it.

**Re-detection while a root is open.** Detection inputs are a handful of marker files (`astro.config.*`, `eleventy.config.*`, `hugo.*`, `package.json`, `.posto/index.json`), and the fs watcher already reports every change. The shared invalidation helper (§2.2) treats a change to any marker path as a **project-type invalidation**: re-run `detectProject` (it's cheap), and if the resolved type differs, re-run the `selectRoot` pipeline for the same root — which already knows how to swap schemas, watch rules, and dev server. This covers the real cases (scaffolding Astro into a `generic` folder, deleting `astro.config.mjs`) without a "reopen the folder" instruction. Until the wiring lands (Phase 3, with the watcher work), the documented interim answer is: the badge and capabilities are fixed at open time; reopen the folder after changing frameworks.

### 2.2 The adapter interface

New module `packages/core/src/project/adapter.ts`. One object per project type, resolved from `ProjectInfo.type` by a registry. Everything the apps and editor currently hard-code becomes a method or capability flag:

```ts
interface ProjectAdapter {
  readonly type: ProjectType;

  /** Framework-derived schema config (the current buildAstroConfig role).
   *  Returns the neutral PagesConfig plus diagnostics; null when the
   *  project offers no derived schemas. IO is injected so core stays pure
   *  and testable. */
  loadDerivedConfig(root: string, io: ProjectIO): Promise<DerivedConfig | null>;

  /** Everything path-change-driven, replacing the duplicated path lists in
   *  App.tsx. Each rule pairs matchers with WHAT goes stale — derived
   *  config is only one scope; component prop schemas, media-library
   *  metadata, and data documents have their own freshness needs and get
   *  their own rules here rather than a second, undocumented mechanism.
   *  Evaluated by one shared helper that fans out to the right refresh. */
  invalidations(root: string): InvalidationRule[];

  /** File → preview route mapping (the current routing.ts role).
   *  { route, certain } | null, same contract as today. */
  routeForFile(root: string, path: string, content: string): FileRoute | null;

  /** Ordered site-URL sources; generic fallbacks (CNAME, package.json
   *  homepage) are applied by the caller after these. */
  siteUrlSources(root: string): SiteUrlSource[];

  /** Watcher ignore rules beyond the shared defaults (node_modules, .git).
   *  Shipped to the backend with watch_root — see §2.5. */
  watchIgnores(): IgnoreRule[];

  /** Feature availability. The editor renders/enables features by asking,
   *  never by checking the project type directly. */
  capabilities: {
    /** Metadata-backed media libraries (today: Astro glob collections). */
    imageLibraries: boolean;
    /** Multi-entry data documents in the sidebar (today: file() loaders). */
    dataDocuments: boolean;
    /** Rich component blocks in the body editor, and the prop-schema
     *  source for them (today: .astro component Props scanning). */
    componentBlocks: ComponentSchemaSource | null;
    /** Entry-id derivation for reference fields (today: astroEntryId). */
    entryIds: EntryIdScheme | null;
  };
}
```

```ts
interface InvalidationRule {
  paths: PathMatcher[];
  refresh:
    | "derivedConfig"
    | "componentSchemas"
    | "mediaLibraries"
    | "dataDocuments"
    | "projectType"
    | "workspaceLayout"; // workspaceLayout: see §2.7
}
```

The `projectType` scope is the re-detection hook from §2.1 (marker files changed → re-detect). The Astro adapter's rules, for concreteness: `.astro/collections/**` + `src/content{,.config}/config.ts` → `derivedConfig`; `src/components/**/*.astro` → `componentSchemas`; each media library's `base` → `mediaLibraries`; each `file()` loader's backing file → `dataDocuments` (the last two are computed from the loaded config, so `invalidations` is re-derived after each `loadDerivedConfig`).

`DerivedConfig` is `PagesConfig` **minus the Astro-specific members**, plus generalized ones (see §2.3), plus `diagnostics` (the generalized channel from immediate-fix T3).

### 2.3 Neutralize `PagesConfig`

Move Astro-specific members to adapter-scoped or generalized homes:

- `astroCollections` → `componentSchemas` / `collectionSchemas`: a generic "named collection → field list" registry the reference-field and MDX UIs consume. The _shape_ is already framework-neutral (`{ name, fields }`); only the name isn't.
- `imageLibraries: AstroImageLibrary[]` → `mediaLibraries: MediaLibrary[]` with the same members (`base`, `patterns`, `metadataExtensions`, `imageFieldPath`, `fields`) — nothing in that type is actually Astro-specific except its name and how it's discovered.
- `imageLibraryDiagnostics` → merged into the general `diagnostics` channel with a `feature: "media-library"` tag.
- `ContentEntry.astroCustomIds` → `ContentEntry.opaqueEntryIds` (semantic: "the editor cannot derive this collection's entry ids").
- Reference option `astroId: true` → `idScheme: "framework"` (vs the Pages CMS path-based scheme).

This is renaming plus type-home moves — behavior-neutral, done under test.

### 2.4 Editor package rule: no `core/astro` imports

After the moves in §2.3, enforce with lint (ESLint `no-restricted-imports` on `@posto/core/astro/*` within `packages/editor` and `apps/*`): the editor consumes `PagesConfig` + `ProjectAdapter` (provided via React context from the app shell), never Astro modules directly. `core/astro` becomes an implementation detail of the Astro adapter.

The MDX body editor is the hard case: `MdxNodes` / `BodyEditor` / `ComponentPicker` need component prop schemas from `.astro` files. That dependency inverts through `capabilities.componentBlocks`: the adapter supplies a `ComponentSchemaSource`, the editor renders whatever it's given. An Eleventy adapter would return `null` and the editor simply doesn't offer component insertion — which is the correct product behavior, not a degradation.

This is the load-bearing type of the whole inversion, so its shape is fixed here rather than discovered mid-refactor (Phase 4 must not start without it). Sketch, derived from what `ComponentPicker`/`MdxNodes`/`newFile` actually consume today:

```ts
interface ComponentRef {
  /** Name used in the document body (JSX tag name today). */
  name: string;
  /** Absolute source path — identity for caching and invalidation. */
  path: string;
}

interface ComponentSchemaSource {
  /** Directories scanned for insertable components; feeds the
   *  `componentSchemas` invalidation rule. */
  componentDirs(root: string): string[];
  /** All insertable components. Async — everything reads via ProjectIO. */
  listComponents(root: string, io: ProjectIO): Promise<ComponentRef[]>;
  /** Prop fields for one component, as neutral `Field[]` (the same type
   *  the form editor already renders), plus per-component diagnostics
   *  ("Props interface not found; all props edit as text"). Never throws:
   *  unparseable → empty fields + diagnostic. */
  componentFields(
    ref: ComponentRef,
    io: ProjectIO,
  ): Promise<{ fields: Field[]; diagnostics: Diagnostic[] }>;
  /** The import/reference statement to insert into a document that uses
   *  the component (today: an MDX ESM import with a relative specifier). */
  importFor(ref: ComponentRef, documentPath: string): string;
}
```

Notable decisions embedded there: async throughout (the Astro implementation reads `.astro` files on demand); props arrive as the existing neutral `Field[]` so `FieldEditor` renders them unchanged; errors are diagnostics, never exceptions; and cache invalidation rides the `componentSchemas` scope from §2.2 keyed by `ComponentRef.path`.

### 2.5 Backend changes (small)

- `watch.rs`: `watch_root` takes an optional list of ignore rules from the frontend (prefix/glob strings) merged with the built-in defaults (`node_modules`, `.git`, dotfiles policy). The Astro-specific `.astro/`-except-`collections` rule moves into the Astro adapter's `watchIgnores()`. With §2.7, it also accepts extra watch paths (workspace manifests outside `workDir`).
- `devserver.rs` needs **no changes** for adapters — it is already generic and simply starts in whatever directory it's given (`workDir` after §2.7). Optionally, the adapter can later supply a preferred script name or readiness probe, but nothing blocks on it. `env.rs`'s dependency-install step does change: workspace installs run from the workspace root (§2.7).
- New `scan_projects(root)` command (§2.7): bounded marker-file inventory; evidence only, no classification.
- `git/mod.rs`: pathspec-scoped publish staging, status, dirtiness, and revert (§2.7); discover-up open already exists.
- `proxy.rs` references Astro only in comments/heuristics; audit during Phase 4 and parameterize only if a concrete second framework needs it.

### 2.6 What stays shared

- `.pages.yml` parsing, `.posto/` overlays, `matchEntry`/precedence, filename templates, autosave/rename pipeline, git sync, deployment ring, SEO preview — all already framework-neutral and untouched.
- `useSchemas` survives but shrinks: it orchestrates the three-layer resolution from §2.1 (`.posto` over `.pages.yml` over `adapter.loadDerivedConfig`) instead of knowing Astro's file layout.

### 2.7 Monorepos: workspace scan and directory choice

Today Posto assumes the opened folder _is_ the site. A monorepo (this very repo: `apps/docs` is an Astro site inside a pnpm workspace) breaks that in two ways: detection at the root finds nothing (or the wrong thing), and `root` silently stops meaning "the git repo root" once the user should really be working in a subdirectory. This section makes the split explicit.

**Two distinct roots.** After this work, the app carries both:

- `repoRoot` — the opened folder; owns git sync, publish, the deployment ring, and managed-repo identity (mobile clones).
- `workDir` — the directory the editor experience runs in: detection (§2.1), schemas, sidebar, dev server, watcher, preview. Single-project repos have `workDir === repoRoot` and behave exactly as today.

**The workspace scan.** On opening a root, before launching the editor:

1. One new backend command, `scan_projects(root)`, walks the tree **bounded** (depth ≤ 3, skipping `node_modules`, `.git`, dotdirs, and anything ignored by the watcher defaults) and returns an inventory of _marker files_ found per directory — the §2.1 marker set plus workspace manifests (`pnpm-workspace.yaml`, package.json `workspaces`, `lerna.json`, `turbo.json`) and `.pages.yml`. It reports evidence only; **classification stays in TS core** (`scanWorkspace(inventory)` reuses `detectProject`'s rules per candidate directory), so the detection logic keeps a single home.
2. `scanWorkspace` produces `ProjectCandidate[]`: `{ dir, type, signals, hasPagesYml }` for every directory that classifies as a framework project or carries a `.pages.yml`.

**Decision rules**, in order:

1. The **root itself classifies as a framework project** → single-project; open directly (`workDir = repoRoot`), even if nested candidates exist (an Astro site with an `examples/` folder is still one site). The chooser stays reachable from the header for the rare exception.
2. Root is `generic` and **exactly one candidate** exists below it → skip the chooser, open that candidate as `workDir`, and show the subpath in the header (with a switcher affordance) so the auto-choice is visible and reversible.
3. Root is `generic` and **two or more candidates** (or a workspace manifest with zero candidates — an empty/unsupported monorepo) → show the **directory choice screen** before the full editor.
4. Root is `generic`, no manifests, no candidates → plain generic single-project, as today.

**The chooser screen** (desktop and mobile, same component in `packages/editor`, shell-specific navigation): a list of candidates showing the relative directory, the detected type badge, its `signals`, and `.pages.yml`/`.posto` presence; plus a "browse for another folder inside this repo" escape hatch. On mobile it slots into the existing repo-open flow (after clone / on selecting a managed repo in `RepoHome`, before the editor panes); on desktop it replaces the empty state between `chooseDirectory` and the editor body. Selecting an entry runs the normal `selectRoot` pipeline with `workDir`.

**Persistence.** The chosen `workDir` is remembered **app-side, keyed by `repoRoot`** (extend `set_last_root`/recents storage in `settings.rs` to store `{ root, workDir }` pairs) — _not_ in the repo's `.posto/`, because the workspace root shouldn't need a Posto config to remember a per-user choice, and different collaborators may work in different packages. Reopening a remembered repo skips the chooser; the header switcher reopens it.

**What must learn the repoRoot/workDir split** (the real cost of this feature):

- **Git** (`git/mod.rs`): `Client::open` **already** uses `Repository::discover` ("the chosen directory is not necessarily the repository root"), so every command mechanically works from a subdirectory today — fetch, pull, `github_remote`, status, revert — and the frontend's repo-relative path handling (`revertChange`'s `endsWith` match) survives unchanged. What must change is **scope**, and the critical one is `publish`: it stages with `add_all(["*"])` + `update_all(["*"])` — repo-wide `git add -A` — so publishing from a monorepo subdirectory would silently commit and push every sibling package's uncommitted changes. `publish`'s staging pathspec, `changed_files`, `is_dirty`, and `revert` all become **pathspec-scoped to `workDir`'s repo-relative subtree** (a `workDir` prefix replaces `"*"`); pull/fetch/behind-upstream stay repo-wide (you can't half-pull). Note the stash-around-pull flow keys off `is_dirty`: scoping it means a dirty _sibling_ package no longer triggers the stash path — correct, since pull's merge only conflicts with what the stash protects, but the repo-wide stash itself still carries sibling changes through safely. Extend `tests/git_parity.rs` with a monorepo fixture asserting scoped publish/status against CLI `git -C <repo> add apps/site && git status apps/site`.
- **Dev server** (`devserver.rs`): starts in `workDir` (its package.json). No change to detection logic — but `env.rs`'s install steps must run installs at the **workspace root** when one exists (pnpm/npm workspaces install from the root), which `scan_projects`' manifest inventory already identifies.
- **Watcher**: watches `workDir` (cheaper than the whole monorepo) **plus** the workspace manifests and `repoRoot` marker files, so §2.1's re-detection and a `workspaceLayout` re-scan both still trigger.
- **Invalidations** (§2.2) gain a sixth scope, `workspaceLayout`: manifest/candidate marker changes re-run the scan; if the current `workDir` disappeared, fall back to the chooser rather than a broken editor.

**Explicitly out of scope**: editing multiple packages in one session, cross-package schema resolution, and running more than one dev server. One `workDir` at a time; switching is cheap (it is `selectRoot`).

---

## 3. Phases

Each phase ships independently; the app behaves identically for Astro projects throughout (until Phase 6 adds behavior for others).

### Phase 0 — Prep (rides on immediate-fix tasks)

The minimal prerequisite subset from `PLAN-immediate-fixes.md` is **T2 + T3 + T5** — the adapter work can start once those three land, without waiting for that doc's full landing order (which sequences T3 sixth for unrelated reasons; pull it forward if this plan starts first).

- T2 structured reads (`read_text_file_optional`) — adapters need not-found-vs-error to detect responsibly.
- T3 diagnostics channel — becomes `DerivedConfig.diagnostics`.
- T5 editor test harness — the refactor's safety net.
- Snapshot tests for the current effective-config output over 2–3 fixture repos (the mock site is one), so every later phase can assert "effective config unchanged".

### Phase 1 — Detection + registry (additive)

- `packages/core/src/project/{detect,adapter,registry}.ts` with the types above and a `detectProject(root, io)` implementation + unit tests over fixture trees.
- Wire detection into `selectRoot` on desktop and repo-open on mobile; store `ProjectInfo` in app state and show the detected type in the UI.
- The `.posto/index.json` `project:` override from §2.1, including the unknown-type-→-generic-plus-diagnostic behavior and its badge signal.
- Nothing consumes the adapter yet.

### Phase 1.5 — Monorepo workspace selection (§2.7)

Builds directly on Phase 1's detection; lands as one unit because the chooser is unusable without the git split (publishing from a subdirectory must not require it to be a repo root):

- `scan_projects` backend command + `scanWorkspace` in core, with fixture-tree tests (this repo's own layout — `apps/docs` inside a pnpm workspace — is fixture one).
- `git/mod.rs`: pathspec-scope `publish` staging (the `add_all(["*"])` → `workDir` prefix change is the load-bearing one), `changed_files`, `is_dirty`, and revert; pull and deployment stay repo-wide; discover-up open already exists. Monorepo fixture in `git_parity.rs`.
- The shared chooser component in `packages/editor`; wire into desktop (`chooseDirectory` → scan → chooser/auto-select → `selectRoot(workDir)`) and mobile (repo-open flow in `RepoHome`/onboarding).
- `{ root, workDir }` persistence in `settings.rs` recents; header subpath display + switcher.
- `env.rs` workspace-root installs; watcher extra-paths for manifests.
- Single-project repos must be pixel-identical to today — the scan short-circuits on decision rule 1 before any UI is shown.

### Phase 2 — Astro adapter wraps existing code; `useSchemas` goes generic

- Implement `astroAdapter` by _delegating to the existing modules_: `loadDerivedConfig` = the current `.astro/collections` + `content.config.ts` logic lifted out of `useSchemas.ts`; `invalidations` = the path lists currently duplicated in `App.tsx`, scoped per §2.2.
- Implement the trivial `generic` adapter (no derived config, no capabilities) — ~20 lines, and it proves the interface isn't Astro-shaped. A `.pages.yml`-only site exercises the full overlay stack on top of it (layers 1–2 with an empty layer 3).
- Rewrite `useSchemas` to consume the adapter (from context); delete the hard-coded Astro paths from both `useSchemas.ts` and `App.tsx` (`onAfterSave` + `onExternalChanges` call a single `invalidateForPaths(paths)` helper driven by the adapter's `invalidations`).
- Assert the Phase-0 snapshots are unchanged.

### Phase 3 — Routing, site URL, watch rules

- Move `apps/desktop/src/routing.ts` into the Astro adapter (`routeForFile`); `usePreview` calls through the adapter. `generic` returns null (preview stays where it is), which is today's behavior for non-matching paths anyway.
- Split `useSiteUrl`: the Astro-config `site:` scan becomes the Astro adapter's `siteUrlSources()`; CNAME + package.json `homepage` stay as shared fallbacks in the hook.
- Backend `watch_root` ignore-rules parameter + move the `.astro` rule into the adapter (§2.5).
- Wire the `projectType` invalidation scope: marker-file changes re-run detection and, on a type change, re-run the `selectRoot` pipeline (§2.1's re-detection story stops being "reopen the folder" here).

### Phase 4 — Neutralize the config type; gate features on capabilities

- The renames/moves from §2.3, mechanical and test-covered.
- Editor call sites switch from "is there an Astro config?" checks (e.g. `hasAstroFallback`, `entrySource === "astro"`) to capability checks and a `derivedSource: ProjectType` label.
- Image-library UI mounts on `capabilities.imageLibraries`; MDX component UI on `capabilities.componentBlocks`; data-document sidebar groups on `capabilities.dataDocuments`.
- Turn on the `no-restricted-imports` lint rule; fix stragglers.

### Phase 5 — Harden the Astro adapter's config scanning

With the seam in place, the hand-rolled `content.config.ts` scanner (`parseLoaderConfig`, `topLevelObjectProp`, `schemaAnalysis.ts`) is now an _adapter-internal_ concern and can be improved without touching anything else. Options, in ascending effort:

1. Keep the scanner, expand the diagnostic coverage (done in T3) and add a corpus test: a directory of real-world `content.config.ts` samples with expected loader maps, so regressions and coverage gaps are measurable.
2. Swap the scanner's tokenization onto a real lexer (`es-module-lexer` for imports/exports + `acorn`/`meriyah` for the `defineCollection` argument objects). Static-literal extraction only — same recoverable facts, far fewer false negatives on comments/strings/helpers.
3. Long-term: ask Astro itself. The dev server Posto already runs can evaluate the config; an integration (e.g. a tiny script run via the detected package manager, or reading richer future `.astro/` artifacts) would replace guessing with ground truth. Track Astro's own manifest output — newer versions may expose loader metadata directly.

Recommendation: do (1) immediately as part of this phase, (2) when the corpus shows the scanner's miss rate matters, (3) opportunistically.

### Phase 6 — Second adapter: Eleventy (proof of the seam)

Deliberately minimal scope — the point is to validate the interface, not to ship full Eleventy parity:

- Detection (already specified), dev server (already works via the `@11ty/eleventy` fallback in `devserver.rs`).
- `loadDerivedConfig`: none at first (Eleventy has no generated schema artifact); `.pages.yml` remains the schema path for Eleventy users via the overlay layer, with no Eleventy-specific work needed. Later: derive collections from directory data files (`*.11tydata.json`).
- `routeForFile`: permalink-free convention mapping (`/posts/foo.md` → `/posts/foo/`), `certain: false`, confirmed against the dev server the same way Astro collection guesses are today.
- Capabilities: all false / null.

If implementing this adapter requires touching any file outside `packages/core/src/project/` + a registry entry, the seam has a leak — fix the seam, not the adapter.

---

## 4. Risks and mitigations

- **Behavior drift during Phase 2/4 moves.** Mitigation: Phase-0 effective- config snapshots + the editor test harness land first; each phase asserts snapshots unchanged.
- **Detection misfires** (sites in subfolders, both Astro and Eleventy deps present). Mitigation: monorepos and subfolder sites are handled head-on by the §2.7 scan + chooser; for the rest, detection surfaces its evidence in the UI, precedence is documented, and the `.posto/` `project:` override (a committed Phase 1 deliverable, §2.1) is the escape hatch.
- **Scan cost on huge repos.** `scan_projects` is depth- and ignore-bounded, runs in Rust, and reports only marker paths; worst case it's a shallow directory walk, and the result is needed once per repo open. If a pathological tree still hurts, cap directory count and emit a "scan truncated" diagnostic with the browse-manually escape hatch.
- **Publish scoping is a behavior change** for anyone already pointing Posto at a monorepo subdirectory-as-root today (their git ops currently fail or hit the wrong repo, so scoping is strictly an improvement — but the pathspec filter means changes outside `workDir` are invisible in the publish modal by design; the modal should say "showing changes in apps/docs" so that's legible).
- **Mobile parity.** Mobile shares `packages/editor`, so Phases 2/4 carry it along; audit `apps/mobile/src/*` for direct Astro references during Phase 4 (RepoHome/Onboarding copy mentions Astro — product decision whether that stays).
- **The IPC mock.** The mock's fixture site is Astro-shaped; after immediate-fix T6 it lives in its own module and gains fixtures per project type as adapters appear (a `generic` fixture is trivial and immediately useful for testing capability-gating).

## 5. Success criteria

- Opening a plain-markdown folder or an Eleventy site shows a correct type badge, working browse/edit/publish, and _no_ Astro-flavored UI or silent Astro path probing.
- Opening this repo itself presents the chooser (or auto-selects `apps/docs` if it's the only candidate), and edit → preview → publish works from that subdirectory with publish scoped to it — on both desktop and mobile.
- `packages/editor` and `apps/*` contain zero imports from `@posto/core/astro/*` (lint-enforced).
- `PagesConfig` contains no Astro-named members.
- Adding the next adapter (Hugo is the expected one — its type and detection rules are already reserved; Jekyll etc. after) requires only: one adapter implementation + fixtures.

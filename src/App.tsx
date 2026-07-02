import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import { invoke, openDirectory } from "./ipc";
import type { FileEntry, FileGroup } from "./ipc";
import { EMPTY_CONFIG, matchEntry, parsePagesConfig, type PagesConfig } from "./pagescms/config";
import { parseFile } from "./pagescms/frontmatter";
import { FormEditor } from "./components/FormEditor";

import "@awesome.me/webawesome/dist/styles/webawesome.css";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/split-panel/split-panel.js";
import "@awesome.me/webawesome/dist/components/details/details.js";
import "@awesome.me/webawesome/dist/components/spinner/spinner.js";
import "@awesome.me/webawesome/dist/components/callout/callout.js";
import "@awesome.me/webawesome/dist/components/tab-group/tab-group.js";
import "@awesome.me/webawesome/dist/components/tab/tab.js";
import "@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js";

import "./App.css";

type ServerStatus =
  | { state: "idle" }
  | { state: "installing" }
  | { state: "starting" }
  | { state: "running"; port: number }
  | { state: "error"; message: string };

const AUTOSAVE_DELAY_MS = 800;
const PING_INTERVAL_MS = 500;
const PING_TIMEOUT_MS = 60_000;

function App() {
  const [root, setRoot] = createSignal<string | null>(null);
  const [groups, setGroups] = createSignal<FileGroup[]>([]);
  const [filePath, setFilePath] = createSignal<string | null>(null);
  const [fileContent, setFileContent] = createSignal("");
  const [saveState, setSaveState] = createSignal<"saved" | "saving" | "error" | "invalid">(
    "saved",
  );
  const [pagesConfig, setPagesConfig] = createSignal<PagesConfig | null>(null);
  const [configError, setConfigError] = createSignal<string | null>(null);
  // "Raw" tab choice sticks for the session; Form is the default when available.
  const [rawPreferred, setRawPreferred] = createSignal(false);
  const [server, setServer] = createSignal<ServerStatus>({ state: "idle" });
  const [publishState, setPublishState] = createSignal<string | null>(null);
  // While the split-panel divider is being dragged, the preview iframe must
  // not receive pointer events or it swallows the drag mid-motion.
  const [dragging, setDragging] = createSignal(false);
  const [previewRoute, setPreviewRoute] = createSignal("/");

  function frontmatterSlug(content: string): string | null {
    const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) return null;
    const line = fm[1].split(/\r?\n/).find((l) => /^slug:/.test(l));
    if (!line) return null;
    const value = line
      .slice("slug:".length)
      .trim()
      .replace(/^["']|["']$/g, "");
    return value || null;
  }

  // File-based routing (Astro-style): a file under src/pages maps to the
  // route its slug implies — src/pages/about.mdx → /about,
  // src/pages/blog/index.astro → /blog. Dynamic segments ([slug]) can't be
  // resolved from the filename, so those keep the current route.
  // Markdown in a content collection (src/<coll>/post.mdx or
  // src/content/<coll>/post.mdx) maps to /<coll>/<slug>, where the slug
  // comes from frontmatter when present, else the filename.
  function routeForFile(path: string, content: string): string | null {
    const marker = "/src/pages/";
    const idx = path.indexOf(marker);
    if (idx !== -1) {
      let rel = path.slice(idx + marker.length).replace(/\.[^/.]+$/, "");
      if (rel.includes("[")) return null;
      if (rel === "index" || rel.endsWith("/index")) rel = rel.slice(0, -"index".length);
      const route = "/" + rel;
      return route.length > 1 && route.endsWith("/") ? route.slice(0, -1) : route;
    }
    const collection = path.match(/\/src\/(?:content\/)?([^/]+)\/([^/]+)\.(?:md|mdx|markdown)$/);
    if (!collection) return null;
    const [, name, file] = collection;
    if (["pages", "components", "layouts", "assets", "styles"].includes(name)) return null;
    return `/${name}/${frontmatterSlug(content) ?? file}`;
  }

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let routeTimer: ReturnType<typeof setInterval> | undefined;
  let previewFrame: HTMLIFrameElement | undefined;
  let lastNavigatedRoute: string | undefined;

  // Navigate the preview imperatively, and only when the target route truly
  // changes. Saves and unrelated re-renders never touch the iframe — content
  // updates are the dev server's job (hot reload).
  createEffect(() => {
    const route = previewRoute();
    const s = server();
    if (s.state !== "running" || !previewFrame) return;
    if (route === lastNavigatedRoute) return;
    lastNavigatedRoute = route;
    previewFrame.src = `http://localhost:${s.port}${route}`;
  });

  // Sidebar labels come from frontmatter titles; keep them in sync when a
  // save changes the title (list_files only runs on directory selection).
  function sidebarTitle(path: string, content: string): string | null {
    if (!/\.(md|mdx|markdown)$/i.test(path)) return null;
    const parsed = parseFile(content);
    if (parsed.error) return null;
    const value = parsed.doc.get("title") ?? parsed.doc.get("name");
    if (typeof value === "string" && value.trim() !== "") return value;
    if (typeof value === "number") return String(value);
    return null;
  }

  function updateSidebarTitle(path: string, content: string) {
    const title = sidebarTitle(path, content);
    setGroups((current) =>
      current.map((group) =>
        group.files.some((file) => file.path === path)
          ? {
              ...group,
              files: group.files.map((file) =>
                file.path === path && file.title !== title ? { ...file, title } : file,
              ),
            }
          : group,
      ),
    );
  }

  async function saveNow(path: string, content: string) {
    setSaveState("saving");
    try {
      await invoke("write_text_file", { path, content });
      setSaveState("saved");
      updateSidebarTitle(path, content);
    } catch {
      setSaveState("error");
    }
  }

  function flushPendingSave() {
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      const path = filePath();
      if (path) void saveNow(path, fileContent());
    }
  }

  // Form edits only reach disk while the form validates; invalid states keep
  // the in-memory content (so Raw shows it) but never save.
  function onFormEdit(content: string, valid: boolean) {
    if (valid) {
      onEdit(content);
    } else {
      setFileContent(content);
      clearTimeout(saveTimer);
      saveTimer = undefined;
      setSaveState("invalid");
    }
  }

  function onEdit(content: string) {
    setFileContent(content);
    setSaveState("saving");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      const path = filePath();
      if (path) void saveNow(path, content);
    }, AUTOSAVE_DELAY_MS);
  }

  async function openFile(path: string, navigatePreview = true) {
    if (path === filePath()) return;
    flushPendingSave();
    try {
      const content = await invoke<string>("read_text_file", { path });
      setFilePath(path);
      setFileContent(content);
      setSaveState("saved");
      if (navigatePreview) {
        const route = routeForFile(path, content);
        if (route) setPreviewRoute(route);
      }
    } catch (e) {
      setPublishState(String(e));
    }
  }

  // Reverse routing: the iframe is cross-origin, so its URL is unreadable —
  // but the dev server logs every page it serves, and the backend tracks the
  // last one. Poll it and react only when the served route *changes*
  // (steady-state values are ignored, so this can't fight with forward
  // navigation or repeat stale routes). Polling, not iframe load events:
  // WebKit doesn't reliably re-fire load for navigations inside the frame.
  function fileForRoute(route: string): string | null {
    for (const group of groups()) {
      for (const file of group.files) {
        if (routeForFile(file.path, "") === route) return file.path;
      }
    }
    return null;
  }

  let lastServedRoute: string | null = null;

  function watchPreviewRoute() {
    clearInterval(routeTimer);
    lastServedRoute = null;
    routeTimer = setInterval(async () => {
      const route = await invoke<string | null>("get_last_route");
      if (route === lastServedRoute) return;
      lastServedRoute = route;
      if (!route || route === previewRoute()) return;
      // The user navigated inside the preview: sync route state without
      // re-navigating the iframe, and select the matching file.
      lastNavigatedRoute = route;
      setPreviewRoute(route);
      const file = fileForRoute(route);
      if (file) void openFile(file, false);
    }, 700);
  }

  function watchServer(port: number) {
    clearInterval(pingTimer);
    const startedAt = Date.now();
    pingTimer = setInterval(async () => {
      try {
        const up = await invoke<boolean>("ping_dev_server");
        if (up) {
          clearInterval(pingTimer);
          // Fresh server → fresh iframe; make the effect issue the initial load.
          lastNavigatedRoute = undefined;
          setServer({ state: "running", port });
          watchPreviewRoute();
        } else if (Date.now() - startedAt > PING_TIMEOUT_MS) {
          clearInterval(pingTimer);
          setServer({ state: "error", message: "Dev server did not start within 60 seconds." });
        }
      } catch (e) {
        clearInterval(pingTimer);
        setServer({ state: "error", message: String(e) });
      }
    }, PING_INTERVAL_MS);
  }

  async function startServer(dir: string) {
    clearInterval(pingTimer);
    clearInterval(routeTimer);
    try {
      if (await invoke<boolean>("needs_install", { root: dir })) {
        setServer({ state: "installing" });
        await invoke("install_dependencies", { root: dir });
      }
      setServer({ state: "starting" });
      const port = await invoke<number>("start_dev_server", { root: dir });
      watchServer(port);
    } catch (e) {
      setServer({ state: "error", message: String(e) });
    }
  }

  async function loadPagesConfig(dir: string) {
    setPagesConfig(null);
    setConfigError(null);
    let source: string;
    try {
      source = await invoke<string>("read_text_file", { path: dir + "/.pages.yml" });
    } catch {
      return; // no config file — form editing simply isn't offered
    }
    try {
      setPagesConfig(parsePagesConfig(source));
    } catch (e) {
      setConfigError(e instanceof Error ? e.message : String(e));
    }
  }

  async function selectRoot(dir: string) {
    flushPendingSave();
    setRoot(dir);
    setFilePath(null);
    setFileContent("");
    setPublishState(null);
    setPreviewRoute("/");
    void loadPagesConfig(dir);
    try {
      setGroups(await invoke<FileGroup[]>("list_files", { root: dir }));
    } catch (e) {
      setGroups([]);
      setPublishState(String(e));
    }
    void startServer(dir);
    void invoke("set_last_root", { root: dir });
  }

  async function chooseDirectory() {
    const dir = await openDirectory();
    if (typeof dir === "string") void selectRoot(dir);
  }

  onMount(async () => {
    const stopDragging = () => setDragging(false);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);
    const last = await invoke<string | null>("get_last_root");
    if (last && !root()) void selectRoot(last);
  });

  async function publish() {
    const dir = root();
    if (!dir) return;
    flushPendingSave();
    setPublishState("Publishing…");
    try {
      setPublishState(await invoke<string>("publish", { root: dir }));
    } catch (e) {
      setPublishState(`Publish failed: ${e}`);
    }
  }

  const rootName = () => root()?.split("/").filter(Boolean).pop() ?? "";
  const fileName = () => filePath()?.split("/").pop() ?? "";

  // Content entry (from .pages.yml) describing the open file's fields, if any.
  const entry = createMemo(() => {
    const dir = root();
    const path = filePath();
    const config = pagesConfig();
    if (!dir || !path || !config) return null;
    return matchEntry(config, dir, path);
  });

  // Markdown files always get a Form tab: schema-driven when a content entry
  // matches, otherwise with fields inferred from the frontmatter's shape.
  const showForm = createMemo(
    () => entry() !== null || /\.(md|mdx|markdown)$/i.test(filePath() ?? ""),
  );

  const FileList = (props: { files: FileEntry[] }) => (
    <For each={props.files}>
      {(file) => (
        <button
          class="file-item"
          classList={{ active: filePath() === file.path }}
          onClick={() => void openFile(file.path)}
          title={file.name}
        >
          {file.title ?? file.name}
        </button>
      )}
    </For>
  );

  return (
    <div class="app">
      <header class="navbar">
        <wa-button size="s" onClick={chooseDirectory}>
          {root() ? rootName() : "Choose directory"}
        </wa-button>
        <span class="navbar-status">{publishState()}</span>
        <wa-button size="s" variant="brand" disabled={!root()} onClick={publish}>
          Publish
        </wa-button>
      </header>

      <Show
        when={root()}
        fallback={
          <div class="empty-state">
            <p>Select the folder that holds your site to get started.</p>
            <wa-button variant="brand" onClick={chooseDirectory}>
              Choose directory
            </wa-button>
          </div>
        }
      >
        <div class="body">
          <aside class="sidebar">
            <For each={groups()}>
              {(group) => (
                <Show when={group.label} fallback={<FileList files={group.files} />}>
                  <wa-details attr:summary={group.label} attr:open={true}>
                    <FileList files={group.files} />
                  </wa-details>
                </Show>
              )}
            </For>
          </aside>

          <wa-split-panel
            class="panes"
            attr:position="33"
            onPointerDown={(e: PointerEvent) => {
              // Pointer-downs on slotted pane content target the slotted
              // elements; only the shadow divider targets the host itself.
              if (e.target === e.currentTarget) setDragging(true);
            }}
          >
            <div slot="start" class="pane editor-pane">
              <Show
                when={filePath()}
                fallback={<div class="pane-placeholder">Select a file to edit</div>}
              >
                <div class="pane-header">
                  <span class="pane-title">{fileName()}</span>
                  <span
                    class="save-state"
                    classList={{ error: saveState() === "error" || saveState() === "invalid" }}
                  >
                    {saveState() === "saved"
                      ? "Saved"
                      : saveState() === "saving"
                        ? "Saving…"
                        : saveState() === "invalid"
                          ? "Not saved — fix errors"
                          : "Save failed"}
                  </span>
                </div>
                <Show when={configError()}>
                  <wa-callout variant="warning" class="config-error">
                    Form editing disabled: .pages.yml is invalid — {configError()}
                  </wa-callout>
                </Show>
                <Show
                  when={showForm()}
                  fallback={
                    <textarea
                      class="editor"
                      spellcheck={false}
                      value={fileContent()}
                      onInput={(e) => onEdit(e.currentTarget.value)}
                    />
                  }
                >
                  <wa-tab-group
                    class="editor-tabs"
                    prop:active={rawPreferred() ? "raw" : "form"}
                    on:wa-tab-show={(e: CustomEvent<{ name: string }>) =>
                      setRawPreferred(e.detail.name === "raw")
                    }
                  >
                    <wa-tab attr:panel="form">Form</wa-tab>
                    <wa-tab attr:panel="raw">Raw</wa-tab>
                    <wa-tab-panel attr:name="form">
                      <FormEditor
                        content={fileContent()}
                        entry={entry()}
                        config={pagesConfig() ?? EMPTY_CONFIG}
                        root={root()!}
                        groups={groups()}
                        onChange={onFormEdit}
                      />
                    </wa-tab-panel>
                    <wa-tab-panel attr:name="raw">
                      <textarea
                        class="editor"
                        spellcheck={false}
                        value={fileContent()}
                        onInput={(e) => onEdit(e.currentTarget.value)}
                      />
                    </wa-tab-panel>
                  </wa-tab-group>
                </Show>
              </Show>
            </div>

            <div slot="end" class="pane preview-pane">
              <Show when={server().state === "starting" || server().state === "installing"}>
                <div class="pane-placeholder">
                  <wa-spinner></wa-spinner>
                  <span>
                    {server().state === "installing"
                      ? "Installing dependencies…"
                      : "Starting dev server…"}
                  </span>
                </div>
              </Show>
              <Show when={server().state === "error"}>
                <div class="pane-placeholder">
                  <wa-callout variant="danger">
                    {(server() as { message: string }).message}
                  </wa-callout>
                  <wa-button size="s" onClick={() => startServer(root()!)}>
                    Retry
                  </wa-button>
                </div>
              </Show>
              <Show when={server().state === "running"}>
                <iframe
                  ref={previewFrame}
                  class="preview"
                  classList={{ "no-pointer": dragging() }}
                  title="Site preview"
                />
              </Show>
            </div>
          </wa-split-panel>
        </div>
      </Show>
    </div>
  );
}

export default App;

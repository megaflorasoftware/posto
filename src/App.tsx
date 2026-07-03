import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Loader, MantineProvider, Modal, Tabs, TextInput } from "@mantine/core";
import { invoke, openDirectory } from "./ipc";
import type { ChangedFile, FileEntry, FileGroup } from "./ipc";
import { EMPTY_CONFIG, matchEntry, parsePagesConfig, type PagesConfig } from "./pagescms/config";
import { parseFile } from "./pagescms/frontmatter";
import { FormEditor } from "./components/FormEditor";
import { SeoPreview } from "./components/SeoPreview";

import "@mantine/core/styles.css";
import "@mantine/tiptap/styles.css";
import "./App.css";

type ServerStatus =
  | { state: "idle" }
  | { state: "installing" }
  | { state: "starting" }
  | { state: "running"; port: number }
  | { state: "error"; message: string };

// Must match the backend's fallback commit message in publish().
const DEFAULT_COMMIT_MESSAGE = "Site updates";

const AUTOSAVE_DELAY_MS = 800;
const PING_INTERVAL_MS = 500;
const PING_TIMEOUT_MS = 60_000;

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
  // "content" as the collection name means the file sits directly in
  // src/content (e.g. src/content/home.md) — data files, not pages.
  if (["pages", "components", "layouts", "assets", "styles", "content"].includes(name)) {
    return null;
  }
  return `/${name}/${frontmatterSlug(content) ?? file}`;
}

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

function statusBadge(status: string): { label: string; color: string } {
  if (status === "??") return { label: "new", color: "green" };
  switch (status[0]) {
    case "M":
      return { label: "modified", color: "yellow" };
    case "A":
      return { label: "added", color: "green" };
    case "D":
      return { label: "deleted", color: "red" };
    case "R":
      return { label: "renamed", color: "blue" };
    default:
      return { label: status, color: "gray" };
  }
}

function FileList(props: {
  files: FileEntry[];
  activePath: string | null;
  onOpen: (path: string) => void;
}) {
  return (
    <>
      {props.files.map((file) => (
        <button
          key={file.path}
          className={`file-item${props.activePath === file.path ? " active" : ""}`}
          onClick={() => props.onOpen(file.path)}
          title={file.name}
        >
          {file.title ?? file.name}
        </button>
      ))}
    </>
  );
}

function App() {
  const [root, setRoot] = useState<string | null>(null);
  const [groups, setGroups] = useState<FileGroup[]>([]);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error" | "invalid">("saved");
  const [pagesConfig, setPagesConfig] = useState<PagesConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  // Editor tab choice sticks for the session; Fields is the default when available.
  const [editorTab, setEditorTab] = useState<"fields" | "body" | "raw">("fields");
  const [server, setServer] = useState<ServerStatus>({ state: "idle" });
  const [publishState, setPublishState] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  // null while the modal is loading the change list.
  const [changes, setChanges] = useState<ChangedFile[] | null>(null);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState(DEFAULT_COMMIT_MESSAGE);
  // While the split divider is being dragged, the preview iframe must not
  // receive pointer events or it swallows the drag mid-motion.
  const [dragging, setDragging] = useState(false);
  const [split, setSplit] = useState(33);
  const [previewRoute, setPreviewRoute] = useState("/");
  // Bumped after each successful save so the SEO preview refetches the page.
  const [saveTick, setSaveTick] = useState(0);

  // Latest values for callbacks that outlive the render they were created in
  // (autosave timer, server/route polling intervals, awaited file opens).
  const rootRef = useRef(root);
  rootRef.current = root;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;
  const fileContentRef = useRef(fileContent);
  fileContentRef.current = fileContent;
  const previewRouteRef = useRef(previewRoute);
  previewRouteRef.current = previewRoute;
  const serverRef = useRef(server);
  serverRef.current = server;

  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pingTimer = useRef<ReturnType<typeof setInterval>>(undefined);
  const routeTimer = useRef<ReturnType<typeof setInterval>>(undefined);
  const previewFrame = useRef<HTMLIFrameElement | null>(null);
  const lastNavigatedRoute = useRef<string | undefined>(undefined);
  const lastServedRoute = useRef<string | null>(null);
  const panesEl = useRef<HTMLDivElement | null>(null);

  // Navigate the preview imperatively, and only when the target route truly
  // changes. Saves and unrelated re-renders never touch the iframe — content
  // updates are the dev server's job (hot reload).
  useEffect(() => {
    if (server.state !== "running" || !previewFrame.current) return;
    if (previewRoute === lastNavigatedRoute.current) return;
    lastNavigatedRoute.current = previewRoute;
    previewFrame.current.src = `http://localhost:${server.port}${previewRoute}`;
  }, [server, previewRoute]);

  // Collection markdown doesn't necessarily have its own page (e.g. works
  // rendered only inside gallery pages), so a derived route is just a guess —
  // confirm the dev server actually serves it before pointing the preview at
  // it. Unverifiable (server not up yet) counts as servable.
  async function routeIsServable(route: string): Promise<boolean> {
    if (serverRef.current.state !== "running") return true;
    try {
      await invoke("fetch_page", { route });
      return true;
    } catch {
      return false;
    }
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
      setSaveTick((t) => t + 1);
    } catch {
      setSaveState("error");
    }
  }

  function flushPendingSave() {
    if (saveTimer.current !== undefined) {
      clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
      const path = filePathRef.current;
      if (path) void saveNow(path, fileContentRef.current);
    }
  }

  // Form edits only reach disk while the form validates; invalid states keep
  // the in-memory content (so Raw shows it) but never save.
  function onFormEdit(content: string, valid: boolean) {
    if (valid) {
      onEdit(content);
    } else {
      setFileContent(content);
      clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
      setSaveState("invalid");
    }
  }

  function onEdit(content: string) {
    setFileContent(content);
    setSaveState("saving");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = undefined;
      const path = filePathRef.current;
      if (path) void saveNow(path, content);
    }, AUTOSAVE_DELAY_MS);
  }

  async function openFile(path: string, navigatePreview = true) {
    if (path === filePathRef.current) return;
    flushPendingSave();
    try {
      const content = await invoke<string>("read_text_file", { path });
      setFilePath(path);
      filePathRef.current = path;
      setFileContent(content);
      fileContentRef.current = content;
      setSaveState("saved");
      if (navigatePreview) {
        const route = routeForFile(path, content);
        if (route && route !== previewRouteRef.current && (await routeIsServable(route))) {
          // Bail if the user already opened another file during the check.
          if (filePathRef.current === path) setPreviewRoute(route);
        }
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
    for (const group of groupsRef.current) {
      for (const file of group.files) {
        if (routeForFile(file.path, "") === route) return file.path;
      }
    }
    return null;
  }

  function watchPreviewRoute() {
    clearInterval(routeTimer.current);
    lastServedRoute.current = null;
    routeTimer.current = setInterval(async () => {
      const route = await invoke<string | null>("get_last_route");
      if (route === lastServedRoute.current) return;
      lastServedRoute.current = route;
      if (!route || route === previewRouteRef.current) return;
      // The user navigated inside the preview: sync route state without
      // re-navigating the iframe, and select the matching file.
      lastNavigatedRoute.current = route;
      setPreviewRoute(route);
      const file = fileForRoute(route);
      if (file) void openFile(file, false);
    }, 700);
  }

  function watchServer(port: number) {
    clearInterval(pingTimer.current);
    const startedAt = Date.now();
    pingTimer.current = setInterval(async () => {
      try {
        const up = await invoke<boolean>("ping_dev_server");
        if (up) {
          clearInterval(pingTimer.current);
          // Fresh server → fresh iframe; make the effect issue the initial load.
          lastNavigatedRoute.current = undefined;
          setServer({ state: "running", port });
          watchPreviewRoute();
        } else if (Date.now() - startedAt > PING_TIMEOUT_MS) {
          clearInterval(pingTimer.current);
          setServer({ state: "error", message: "Dev server did not start within 60 seconds." });
        }
      } catch (e) {
        clearInterval(pingTimer.current);
        setServer({ state: "error", message: String(e) });
      }
    }, PING_INTERVAL_MS);
  }

  async function startServer(dir: string) {
    clearInterval(pingTimer.current);
    clearInterval(routeTimer.current);
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
    filePathRef.current = null;
    setFileContent("");
    setPublishState(null);
    setPreviewRoute("/");
    void loadPagesConfig(dir);
    try {
      const listed = await invoke<FileGroup[]>("list_files", { root: dir });
      setGroups(listed);
      groupsRef.current = listed;
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

  useEffect(() => {
    const stopDragging = () => setDragging(false);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);
    void (async () => {
      const last = await invoke<string | null>("get_last_root");
      if (last && !rootRef.current) void selectRoot(last);
    })();
    return () => {
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
      clearTimeout(saveTimer.current);
      clearInterval(pingTimer.current);
      clearInterval(routeTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openPublishModal() {
    const dir = rootRef.current;
    if (!dir) return;
    // Pending edits must hit disk before git status, or they won't show.
    flushPendingSave();
    setChanges(null);
    setChangesError(null);
    setCommitMessage(DEFAULT_COMMIT_MESSAGE);
    setPublishOpen(true);
    try {
      setChanges(await invoke<ChangedFile[]>("changed_files", { root: dir }));
    } catch (e) {
      setChangesError(String(e));
    }
  }

  async function publish(message: string) {
    const dir = rootRef.current;
    if (!dir) return;
    flushPendingSave();
    setPublishState("Publishing…");
    try {
      setPublishState(await invoke<string>("publish", { root: dir, message }));
    } catch (e) {
      setPublishState(`Publish failed: ${e}`);
    }
  }

  function onDividerPointerMove(e: React.PointerEvent) {
    if (!dragging || !panesEl.current) return;
    const rect = panesEl.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setSplit(Math.min(85, Math.max(15, pct)));
  }

  const rootName = root?.split("/").filter(Boolean).pop() ?? "";
  const fileName = filePath?.split("/").pop() ?? "";

  // Content entry (from .pages.yml) describing the open file's fields, if any.
  const entry = useMemo(() => {
    if (!root || !filePath || !pagesConfig) return null;
    return matchEntry(pagesConfig, root, filePath);
  }, [root, filePath, pagesConfig]);

  // Markdown files always get a Form tab: schema-driven when a content entry
  // matches, otherwise with fields inferred from the frontmatter's shape.
  const showForm = entry !== null || /\.(md|mdx|markdown)$/i.test(filePath ?? "");

  const rawEditor = (
    <textarea
      className="editor"
      spellCheck={false}
      value={fileContent}
      onChange={(e) => onEdit(e.currentTarget.value)}
    />
  );

  return (
    <MantineProvider defaultColorScheme="auto">
      <div className="app">
        <header className="navbar">
          <Button size="xs" variant="default" onClick={() => void chooseDirectory()}>
            {root ? rootName : "Choose directory"}
          </Button>
          <span className="navbar-status">{publishState}</span>
          <Button size="xs" disabled={!root} onClick={() => void openPublishModal()}>
            Publish…
          </Button>
        </header>

        <Modal
          opened={publishOpen}
          onClose={() => setPublishOpen(false)}
          title="Publish changes"
        >
          {changesError !== null ? (
            <Alert color="red">Could not read changes: {changesError}</Alert>
          ) : changes === null ? (
            <div className="publish-loading">
              <Loader size="sm" />
            </div>
          ) : changes.length === 0 ? (
            <div className="publish-empty">No changes to publish.</div>
          ) : (
            <div className="publish-list">
              {changes.map((file) => {
                const badge = statusBadge(file.status);
                return (
                  <div key={file.path} className="publish-item">
                    <Badge size="sm" variant="light" color={badge.color}>
                      {badge.label}
                    </Badge>
                    <span className="publish-path" title={file.path}>
                      {file.path}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <TextInput
            mt="md"
            size="xs"
            label="Commit message"
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.currentTarget.value)}
          />
          <Button
            fullWidth
            mt="md"
            disabled={changes === null || changes.length === 0 || commitMessage.trim() === ""}
            onClick={() => {
              setPublishOpen(false);
              void publish(commitMessage.trim());
            }}
          >
            Publish
          </Button>
        </Modal>

        {!root ? (
          <div className="empty-state">
            <p>Select the folder that holds your site to get started.</p>
            <Button onClick={() => void chooseDirectory()}>Choose directory</Button>
          </div>
        ) : (
          <div className="body">
            <aside className="sidebar">
              {groups.map((group) =>
                group.label ? (
                  <details key={group.path} open>
                    <summary>{group.label}</summary>
                    <FileList
                      files={group.files}
                      activePath={filePath}
                      onOpen={(path) => void openFile(path)}
                    />
                  </details>
                ) : (
                  <FileList
                    key={group.path}
                    files={group.files}
                    activePath={filePath}
                    onOpen={(path) => void openFile(path)}
                  />
                ),
              )}
            </aside>

            <div className="panes" ref={panesEl}>
              <div className="pane editor-pane" style={{ flexBasis: `${split}%` }}>
                {!filePath ? (
                  <div className="pane-placeholder">Select a file to edit</div>
                ) : (
                  <>
                    <div className="pane-header">
                      <span className="pane-title">{fileName}</span>
                      <span
                        className={`save-state${
                          saveState === "error" || saveState === "invalid" ? " error" : ""
                        }`}
                      >
                        {saveState === "saved"
                          ? "Saved"
                          : saveState === "saving"
                            ? "Saving…"
                            : saveState === "invalid"
                              ? "Not saved — fix errors"
                              : "Save failed"}
                      </span>
                    </div>
                    {configError && (
                      <Alert color="yellow" className="config-error">
                        Form editing disabled: .pages.yml is invalid — {configError}
                      </Alert>
                    )}
                    {!showForm ? (
                      rawEditor
                    ) : (
                      <Tabs
                        className="pane-tabs"
                        value={editorTab}
                        onChange={(value) => setEditorTab(value as typeof editorTab)}
                      >
                        <Tabs.List>
                          <Tabs.Tab value="fields">Fields</Tabs.Tab>
                          <Tabs.Tab value="body">Body</Tabs.Tab>
                          <Tabs.Tab value="raw">Raw</Tabs.Tab>
                        </Tabs.List>
                        {editorTab === "raw" ? (
                          rawEditor
                        ) : (
                          // One FormEditor spans the Fields and Body tabs so the
                          // parsed document survives switching between them.
                          <FormEditor
                            key={filePath}
                            path={filePath}
                            view={editorTab}
                            content={fileContent}
                            entry={entry}
                            config={pagesConfig ?? EMPTY_CONFIG}
                            root={root}
                            groups={groups}
                            onChange={onFormEdit}
                          />
                        )}
                      </Tabs>
                    )}
                  </>
                )}
              </div>

              <div
                className="pane-divider"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDragging(true);
                }}
                onPointerMove={onDividerPointerMove}
              />

              <div className="pane preview-pane">
                <Tabs className="pane-tabs" defaultValue="site">
                  <Tabs.List>
                    <Tabs.Tab value="site">Preview</Tabs.Tab>
                    <Tabs.Tab value="seo">Search/Socials</Tabs.Tab>
                  </Tabs.List>
                  <Tabs.Panel value="site">
                    {(server.state === "starting" || server.state === "installing") && (
                      <div className="pane-placeholder">
                        <Loader size="sm" />
                        <span>
                          {server.state === "installing"
                            ? "Installing dependencies…"
                            : "Starting dev server…"}
                        </span>
                      </div>
                    )}
                    {server.state === "error" && (
                      <div className="pane-placeholder">
                        <Alert color="red">{server.message}</Alert>
                        <Button size="xs" variant="default" onClick={() => void startServer(root)}>
                          Retry
                        </Button>
                      </div>
                    )}
                    {server.state === "running" && (
                      <iframe
                        ref={previewFrame}
                        className={`preview${dragging ? " no-pointer" : ""}`}
                        title="Site preview"
                      />
                    )}
                  </Tabs.Panel>
                  <Tabs.Panel value="seo">
                    {server.state === "running" ? (
                      <SeoPreview route={previewRoute} port={server.port} refreshKey={saveTick} />
                    ) : (
                      <div className="pane-placeholder">
                        Search/social previews need the dev server running.
                      </div>
                    )}
                  </Tabs.Panel>
                </Tabs>
              </div>
            </div>
          </div>
        )}
      </div>
    </MantineProvider>
  );
}

export default App;

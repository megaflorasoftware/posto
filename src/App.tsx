import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Loader,
  MantineProvider,
  Menu,
  Modal,
  Tabs,
  TextInput,
} from "@mantine/core";
import { Check, ChevronDown, Plus, Undo2, X } from "lucide-react";
import { invoke, onFsChanged, openDirectory } from "./ipc";
import { checkForAppUpdate } from "./updater";
import type { ChangedFile, FileEntry, FileGroup } from "./ipc";
import {
  EMPTY_CONFIG,
  matchCollectionForDir,
  matchEntry,
  parsePagesConfig,
  type Field,
  type PagesConfig,
} from "./pagescms/config";
import {
  buildAstroConfig,
  parseCollectionSchema,
  parseLoaderConfig,
  type LoaderInfo,
} from "./astro/collections";
import { parseFile, type ParsedFile } from "./pagescms/frontmatter";
import { FormEditor } from "./components/FormEditor";
import { NewFileModal } from "./components/NewFileModal";
import { SeoPreview } from "./components/SeoPreview";

import "@mantine/core/styles.css";
import "@mantine/tiptap/styles.css";
import "@mantine/spotlight/styles.css";
import "./App.css";

type SetupStepId = "git" | "node" | "pm" | "deps" | "server";

type SetupStep = {
  id: SetupStepId;
  label: string;
  status: "pending" | "active" | "done" | "error";
  detail?: string;
};

/** Result of the backend's `check_environment` command. */
type EnvCheck = {
  git_version: string | null;
  node_version: string | null;
  package_manager: string;
  package_manager_version: string | null;
  needs_node_modules: boolean;
};

type ServerStatus =
  | { state: "idle" }
  // Environment checks/installs running (or awaiting the Install click)
  // before the dev server is up; `steps` drives the numbered checklist.
  | { state: "setup"; steps: SetupStep[]; awaitingInstall: boolean }
  | { state: "running"; port: number }
  | { state: "error"; message: string };

// Must match the backend's fallback commit message in publish().
const DEFAULT_COMMIT_MESSAGE = "Site updates";

const AUTOSAVE_DELAY_MS = 800;
const FETCH_INTERVAL_MS = 30_000;
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

// Whether the Fields tab would have anything to show: a matched schema entry,
// or existing frontmatter to infer fields from. A broken frontmatter block
// still counts — FormEditor's YAML-error alert explains it.
function contentHasFields(entry: unknown, parsed: ParsedFile): boolean {
  if (entry !== null) return true;
  if (parsed.hadFrontmatter && parsed.error) return true;
  const values: unknown = parsed.doc.toJS();
  return !!values && typeof values === "object" && Object.keys(values).length > 0;
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

/** Undo control for one changed file; deleting a new file confirms first. */
function RevertButton(props: { file: ChangedFile; onRevert: (file: ChangedFile) => void }) {
  const [confirming, setConfirming] = useState(false);
  const isNew = props.file.status === "??";
  if (isNew && confirming) {
    return (
      <Button
        size="compact-xs"
        color="red"
        variant="light"
        onClick={() => props.onRevert(props.file)}
        onBlur={() => setConfirming(false)}
      >
        Delete file?
      </Button>
    );
  }
  const label = isNew ? "Delete new file" : "Revert changes";
  return (
    <ActionIcon
      size="sm"
      variant="subtle"
      color="gray"
      title={label}
      aria-label={label}
      onClick={() => (isNew ? setConfirming(true) : props.onRevert(props.file))}
    >
      <Undo2 size={14} />
    </ActionIcon>
  );
}

/** Hover-revealed delete control for a sidebar file; confirms before deleting. */
function DeleteFileButton(props: { file: FileEntry; onDelete: (file: FileEntry) => void }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <button
        type="button"
        className="file-delete-confirm"
        // The pointer is already over this button (it replaces the ×);
        // leaving it without clicking cancels.
        onMouseLeave={() => setConfirming(false)}
        onClick={() => props.onDelete(props.file)}
      >
        Delete?
      </button>
    );
  }
  return (
    <button
      type="button"
      className="file-delete"
      title={`Delete ${props.file.name}`}
      aria-label={`Delete ${props.file.name}`}
      onClick={() => setConfirming(true)}
    >
      <X size={12} />
    </button>
  );
}

function FileList(props: {
  files: FileEntry[];
  activePath: string | null;
  onOpen: (path: string) => void;
  onDelete: (file: FileEntry) => void;
}) {
  return (
    <>
      {props.files.map((file) => (
        <div
          key={file.path}
          className={`file-item${props.activePath === file.path ? " active" : ""}`}
        >
          <button
            className="file-item-name"
            onClick={() => props.onOpen(file.path)}
            title={file.name}
          >
            {file.title ?? file.name}
          </button>
          <DeleteFileButton file={file} onDelete={props.onDelete} />
        </div>
      ))}
    </>
  );
}

function App() {
  const [root, setRoot] = useState<string | null>(null);
  // Recently-opened site roots, newest first (backend caps at 10).
  const [recentRoots, setRecentRoots] = useState<string[]>([]);
  const [groups, setGroups] = useState<FileGroup[]>([]);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error" | "invalid">("saved");
  const [pagesConfig, setPagesConfig] = useState<PagesConfig | null>(null);
  // Fallback schemas derived from Astro content collections; `.pages.yml`
  // entries take precedence when both describe a folder.
  const [astroConfig, setAstroConfig] = useState<PagesConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  // Editor tab choice sticks for the session; Fields is the default when available.
  const [editorTab, setEditorTab] = useState<"fields" | "body" | "raw">("fields");
  const [server, setServer] = useState<ServerStatus>({ state: "idle" });
  const [publishState, setPublishState] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  // Whether the upstream branch has commits we don't (kept fresh by the
  // 30-second fetch poll); the header offers "Fetch Changes" instead of
  // Publish while true.
  const [behindUpstream, setBehindUpstream] = useState(false);
  const [pulling, setPulling] = useState(false);
  // Whether git reports uncommitted local changes; the header's Publish
  // button is disabled while false. Kept fresh by refreshGroups (which runs
  // on saves via the fs watcher, deletes, reverts, pulls, …) and publish.
  const [hasLocalChanges, setHasLocalChanges] = useState(false);
  // null while the modal is loading the change list.
  const [changes, setChanges] = useState<ChangedFile[] | null>(null);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState(DEFAULT_COMMIT_MESSAGE);
  // Directory the "new file" dialog is creating into, when open.
  const [newFileGroup, setNewFileGroup] = useState<FileGroup | null>(null);
  // While the split divider is being dragged, the preview iframe must not
  // receive pointer events or it swallows the drag mid-motion.
  const [dragging, setDragging] = useState(false);
  const [split, setSplit] = useState(33);
  const [previewRoute, setPreviewRoute] = useState("/");
  // The route the dev server actually served last (from get_last_route), as
  // opposed to previewRoute, which is a forward guess from the open file.
  const [servedRoute, setServedRoute] = useState<string | null>(null);
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
  const previewFrame = useRef<HTMLIFrameElement | null>(null);
  const lastNavigatedRoute = useRef<string | undefined>(undefined);
  const lastServedRoute = useRef<string | null>(null);
  const panesEl = useRef<HTMLDivElement | null>(null);

  // One update check per app launch, once the UI is up.
  useEffect(() => {
    void checkForAppUpdate();
  }, []);

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
      // Editing the schema itself must re-parse it, or forms keep the old one.
      const dir = rootRef.current;
      if (dir && path === dir + "/.pages.yml") void loadPagesConfig(dir);
      if (dir && (path === dir + "/src/content.config.ts" || path === dir + "/src/content/config.ts")) {
        void loadAstroConfig(dir);
      }
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
      // On opening a markdown file, keep the last selected tab when it has
      // content to show, otherwise fall over to the tab that does: no fields
      // → Body; empty body but fields present → Fields. Raw stays sticky.
      if (/\.(md|mdx|markdown)$/i.test(path)) {
        const dir = rootRef.current;
        const cfg = configRef.current;
        const openedEntry = dir && cfg ? matchEntry(cfg, dir, path) : null;
        const parsed = parseFile(content);
        const hasFields = contentHasFields(openedEntry, parsed);
        const hasBody = parsed.body.trim() !== "";
        setEditorTab((last) => {
          if (last === "fields" && !hasFields) return "body";
          if (last === "body" && !hasBody && hasFields) return "fields";
          return last;
        });
      }
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

  // Reverse-route polling lives in an effect (not an imperative helper) so
  // each dev-server start gets a fresh interval running current code, cleaned
  // up automatically when the server changes or the app unmounts.
  useEffect(() => {
    if (server.state !== "running") return;
    lastServedRoute.current = null;
    setServedRoute(null);
    const timer = setInterval(async () => {
      const route = await invoke<string | null>("get_last_route");
      if (route === lastServedRoute.current) return;
      lastServedRoute.current = route;
      if (route) setServedRoute(route);
      if (!route || route === previewRouteRef.current) return;
      // The user navigated inside the preview: sync route state without
      // re-navigating the iframe, and select the matching file.
      lastNavigatedRoute.current = route;
      setPreviewRoute(route);
      const file = fileForRoute(route);
      if (file) void openFile(file, false);
    }, 700);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server]);

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
        } else if (Date.now() - startedAt > PING_TIMEOUT_MS) {
          clearInterval(pingTimer.current);
          updateStep("server", {
            status: "error",
            detail: "Dev server did not start within 60 seconds.",
          });
        }
      } catch (e) {
        clearInterval(pingTimer.current);
        updateStep("server", { status: "error", detail: String(e) });
      }
    }, PING_INTERVAL_MS);
  }

  function updateStep(id: SetupStepId, patch: Partial<SetupStep>) {
    setServer((s) =>
      s.state === "setup"
        ? { ...s, steps: s.steps.map((st) => (st.id === id ? { ...st, ...patch } : st)) }
        : s,
    );
  }

  async function startServer(dir: string) {
    clearInterval(pingTimer.current);
    setServer({
      state: "setup",
      steps: [
        { id: "git", label: "Git", status: "active", detail: "Checking…" },
        { id: "node", label: "Node.js", status: "active", detail: "Checking…" },
        { id: "pm", label: "Package manager", status: "active", detail: "Checking…" },
        { id: "deps", label: "Project dependencies", status: "pending" },
        { id: "server", label: "Dev server", status: "pending" },
      ],
      awaitingInstall: false,
    });
    let env: EnvCheck;
    try {
      env = await invoke<EnvCheck>("check_environment", { root: dir });
    } catch (e) {
      setServer({ state: "error", message: String(e) });
      return;
    }
    const gitOk = env.git_version !== null;
    const nodeOk = env.node_version !== null;
    const pmOk = env.package_manager_version !== null;
    const depsOk = !env.needs_node_modules;
    const steps: SetupStep[] = [
      {
        id: "git",
        label: "Git",
        status: gitOk ? "done" : "pending",
        detail: gitOk ? env.git_version! : "Not found — will be installed",
      },
      {
        id: "node",
        label: "Node.js",
        status: nodeOk ? "done" : "pending",
        detail: nodeOk ? env.node_version! : "Not found — will be installed",
      },
      {
        id: "pm",
        label: `Package manager (${env.package_manager})`,
        status: pmOk ? "done" : "pending",
        detail: pmOk ? env.package_manager_version! : "Not found — will be installed",
      },
      {
        id: "deps",
        label: "Project dependencies",
        status: depsOk ? "done" : "pending",
        detail: depsOk ? undefined : "Will be installed",
      },
      { id: "server", label: "Dev server", status: "pending" },
    ];
    // Anything that would install waits for one explicit Install click;
    // when everything is already in place, go straight to the server.
    const needsInstall = !gitOk || !nodeOk || !pmOk || !depsOk;
    setServer({ state: "setup", steps, awaitingInstall: needsInstall });
    if (!needsInstall) void runSetup(dir, steps);
  }

  /** Runs the pending steps in order, then starts the dev server. */
  async function runSetup(dir: string, steps: SetupStep[]) {
    setServer({ state: "setup", steps, awaitingInstall: false });
    const pending = new Set(steps.filter((s) => s.status === "pending").map((s) => s.id));
    let current: SetupStepId = "git";
    try {
      if (pending.has("git")) {
        // On macOS this opens Apple's Command Line Tools dialog; the backend
        // waits for the user to finish it.
        updateStep("git", { status: "active", detail: "Installing… follow any system prompt" });
        const version = await invoke<string>("install_git");
        updateStep("git", { status: "done", detail: version });
      }
      if (pending.has("node")) {
        current = "node";
        updateStep("node", { status: "active", detail: "Installing…" });
        const version = await invoke<string>("install_node");
        updateStep("node", { status: "done", detail: version });
      }
      if (pending.has("pm")) {
        current = "pm";
        updateStep("pm", { status: "active", detail: "Installing…" });
        const version = await invoke<string>("install_package_manager", { root: dir });
        updateStep("pm", { status: "done", detail: version });
      }
      if (pending.has("deps")) {
        current = "deps";
        updateStep("deps", { status: "active", detail: "Installing…" });
        await invoke("install_dependencies", { root: dir });
        updateStep("deps", { status: "done", detail: undefined });
      }
      current = "server";
      updateStep("server", { status: "active", detail: "Starting…" });
      const port = await invoke<number>("start_dev_server", { root: dir });
      watchServer(port);
    } catch (e) {
      updateStep(current, { status: "error", detail: String(e) });
    }
  }

  async function restartServer(dir: string) {
    try {
      await invoke("stop_dev_server");
    } catch {
      // Best effort — an already-dead server shouldn't block the restart.
    }
    void startServer(dir);
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

  // Astro projects generate a JSON Schema per content collection under
  // `.astro/collections/` (kept fresh by the dev server posto runs). Those
  // become fallback form schemas for folders `.pages.yml` doesn't cover.
  async function loadAstroConfig(dir: string) {
    setAstroConfig(null);
    let listed: { name: string; path: string }[];
    try {
      listed = await invoke<{ name: string; path: string }[]>("list_dir_files", {
        dir: dir + "/.astro/collections",
        extensions: ["json"],
      });
    } catch {
      return; // not an Astro project, or `astro sync` hasn't run yet
    }
    const collections: { name: string; fields: Field[] }[] = [];
    for (const file of listed) {
      if (!file.name.endsWith(".schema.json")) continue;
      const name = file.name.slice(0, -".schema.json".length);
      try {
        const fields = parseCollectionSchema(name, await invoke<string>("read_text_file", { path: file.path }));
        if (fields && fields.length > 0) collections.push({ name, fields });
      } catch {
        // One unreadable schema shouldn't take down the rest.
      }
    }
    if (collections.length === 0) return;
    let loaders = new Map<string, LoaderInfo>();
    for (const configPath of ["/src/content.config.ts", "/src/content/config.ts"]) {
      try {
        loaders = parseLoaderConfig(await invoke<string>("read_text_file", { path: dir + configPath }));
        break;
      } catch {
        // Missing config file — the src/content/<name> convention applies.
      }
    }
    setAstroConfig(buildAstroConfig(collections, loaders));
  }

  async function refreshGroups(dir: string) {
    // Every event that can change git status also refreshes the sidebar, so
    // this keeps the header's Publish button state current too.
    void refreshLocalChanges(dir);
    try {
      const listed = await invoke<FileGroup[]>("list_files", { root: dir });
      setGroups(listed);
      groupsRef.current = listed;
    } catch (e) {
      setGroups([]);
      setPublishState(String(e));
    }
  }

  async function refreshLocalChanges(dir: string) {
    try {
      const changed = await invoke<ChangedFile[]>("changed_files", { root: dir });
      if (rootRef.current === dir) setHasLocalChanges(changed.length > 0);
    } catch {
      // Status unavailable (e.g. not a git repo) — leave the button enabled
      // so publishing surfaces the real error instead of silently locking.
      if (rootRef.current === dir) setHasLocalChanges(true);
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
    void loadAstroConfig(dir);
    await refreshGroups(dir);
    void startServer(dir);
    void invoke("set_last_root", { root: dir }).then(() => refreshRecentRoots());
    void invoke("watch_root", { root: dir });
  }

  async function refreshRecentRoots() {
    try {
      setRecentRoots(await invoke<string[]>("get_recent_roots"));
    } catch {
      setRecentRoots([]);
    }
  }

  async function onFileCreated(path: string) {
    setNewFileGroup(null);
    const dir = rootRef.current;
    if (dir) await refreshGroups(dir);
    // A new markdown file with a schema should land on its form, not on
    // whichever tab was last active (an empty file's Body/Raw view is blank).
    if (/\.(md|mdx)$/i.test(path) && dir && config && matchEntry(config, dir, path) !== null) {
      setEditorTab("fields");
    }
    void openFile(path);
  }

  async function chooseDirectory() {
    const dir = await openDirectory();
    if (typeof dir === "string") void selectRoot(dir);
  }

  // Files changed outside the app (other editors, git, `astro sync`, …):
  // refresh whatever the paths affect. Our own saves also echo through here,
  // but resolve to no-ops (content already matches).
  function onExternalChanges(paths: string[]) {
    const dir = rootRef.current;
    if (!dir) return;
    void refreshGroups(dir);
    if (paths.includes(dir + "/.pages.yml")) void loadPagesConfig(dir);
    if (
      paths.some(
        (p) =>
          p.startsWith(dir + "/.astro/collections") ||
          p === dir + "/src/content.config.ts" ||
          p === dir + "/src/content/config.ts",
      )
    ) {
      void loadAstroConfig(dir);
    }
    const open = filePathRef.current;
    // Reload the open file only while no local edit is pending — the user's
    // in-progress changes must never be clobbered by an external write.
    if (open && paths.includes(open) && saveTimer.current === undefined) {
      void (async () => {
        let content: string;
        try {
          content = await invoke<string>("read_text_file", { path: open });
        } catch {
          return; // deleted externally; the refreshed sidebar reflects it
        }
        if (
          filePathRef.current === open &&
          saveTimer.current === undefined &&
          content !== fileContentRef.current
        ) {
          setFileContent(content);
          fileContentRef.current = content;
          setSaveState("saved");
        }
      })();
    }
  }

  useEffect(() => {
    const stopDragging = () => setDragging(false);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);
    const unlistenFs = onFsChanged(onExternalChanges);
    void refreshRecentRoots();
    void (async () => {
      const last = await invoke<string | null>("get_last_root");
      if (last && !rootRef.current) void selectRoot(last);
    })();
    return () => {
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
      unlistenFs();
      clearTimeout(saveTimer.current);
      clearInterval(pingTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll the remote so the header can offer "Fetch Changes" soon after
  // someone publishes elsewhere. Errors (no remote/upstream, offline) just
  // mean there is nothing to fetch.
  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    const check = async () => {
      try {
        const behind = await invoke<boolean>("fetch_upstream", { root });
        if (!cancelled) setBehindUpstream(behind);
      } catch {
        if (!cancelled) setBehindUpstream(false);
      }
    };
    void check();
    const timer = setInterval(() => void check(), FETCH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [root]);

  async function fetchChanges() {
    const dir = rootRef.current;
    if (!dir) return;
    // Local edits must be on disk so the pull can stash-carry them.
    flushPendingSave();
    setPulling(true);
    setPublishState("Fetching changes…");
    try {
      setPublishState(await invoke<string>("pull_upstream", { root: dir }));
      setBehindUpstream(false);
    } catch (e) {
      setPublishState(`Fetch failed: ${e}`);
    } finally {
      setPulling(false);
    }
    // The fs watcher also reacts to git's writes, but refresh explicitly so
    // the sidebar and open file update even when watching hiccups.
    void refreshGroups(dir);
    const open = filePathRef.current;
    if (open && saveTimer.current === undefined) {
      try {
        const content = await invoke<string>("read_text_file", { path: open });
        if (filePathRef.current === open && content !== fileContentRef.current) {
          setFileContent(content);
          fileContentRef.current = content;
          setSaveState("saved");
        }
      } catch {
        // Pulled changes deleted the open file; the sidebar refresh shows it.
      }
    }
  }

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

  async function deleteFile(file: FileEntry) {
    const dir = rootRef.current;
    if (!dir) return;
    const isOpen = filePathRef.current === file.path;
    if (isOpen) {
      // A pending autosave would recreate the file right after the delete.
      clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
    }
    try {
      await invoke("delete_file", { path: file.path });
    } catch (e) {
      setPublishState(String(e));
      return;
    }
    if (isOpen) {
      setFilePath(null);
      filePathRef.current = null;
      setFileContent("");
      fileContentRef.current = "";
      setSaveState("saved");
    }
    if (file.path === dir + "/.pages.yml") void loadPagesConfig(dir);
    void refreshGroups(dir);
  }

  async function revertChange(file: ChangedFile) {
    const dir = rootRef.current;
    if (!dir) return;
    // `file.path` is repo-relative; the open file's absolute path ends with it.
    const open = filePathRef.current;
    const revertingOpenFile = open !== null && open.endsWith("/" + file.path);
    if (revertingOpenFile) {
      // A pending autosave would immediately re-write the reverted content.
      clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
    }
    try {
      await invoke("revert_file", { root: dir, path: file.path });
    } catch (e) {
      setChangesError(String(e));
      return;
    }
    try {
      setChanges(await invoke<ChangedFile[]>("changed_files", { root: dir }));
    } catch (e) {
      setChangesError(String(e));
    }
    void refreshGroups(dir);
    if (revertingOpenFile && open) {
      if (file.status === "??") {
        // The file was deleted; nothing left to show.
        setFilePath(null);
        filePathRef.current = null;
        setFileContent("");
        fileContentRef.current = "";
        setSaveState("saved");
      } else {
        try {
          const content = await invoke<string>("read_text_file", { path: open });
          setFileContent(content);
          fileContentRef.current = content;
          setSaveState("saved");
        } catch {
          // Deleted-then-reverted edge cases: fall back to no selection.
          setFilePath(null);
          filePathRef.current = null;
          setFileContent("");
          fileContentRef.current = "";
        }
      }
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
    // Committing doesn't touch watched files, so refresh the flag directly.
    void refreshLocalChanges(dir);
  }

  function onDividerPointerMove(e: React.PointerEvent) {
    if (!dragging || !panesEl.current) return;
    const rect = panesEl.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setSplit(Math.min(85, Math.max(15, pct)));
  }

  const rootName = root?.split("/").filter(Boolean).pop() ?? "";
  // Dropdown entries for the header's recent-sites menu; the open site would
  // be a no-op, so it's left out.
  const recentOptions = recentRoots.filter((dir) => dir !== root).slice(0, 10);
  const fileName = filePath?.split("/").pop() ?? "";

  // Effective schema config: `.pages.yml` entries first (higher resolution —
  // labels, media, widget types), Astro collection schemas after them as a
  // fallback. matchEntry's first-match-wins ordering makes the precedence.
  const config = useMemo<PagesConfig | null>(() => {
    if (!pagesConfig && !astroConfig) return null;
    return {
      media: pagesConfig?.media.length ? pagesConfig.media : (astroConfig?.media ?? []),
      content: [...(pagesConfig?.content ?? []), ...(astroConfig?.content ?? [])],
    };
  }, [pagesConfig, astroConfig]);
  const configRef = useRef(config);
  configRef.current = config;

  // Content entry describing the open file's fields, if any.
  const entry = useMemo(() => {
    if (!root || !filePath || !config) return null;
    return matchEntry(config, root, filePath);
  }, [root, filePath, config]);

  // Which source the matched entry came from, for the header badge.
  const entrySource =
    entry === null ? null : astroConfig?.content.includes(entry) ? "astro" : "pages";

  // Sidebar groups: loose root files stay at the very top, then groups whose
  // directory belongs to a defined collection — taking that collection's
  // label and sorting alphabetically regardless of schema source — and plain
  // directory groups follow in backend order.
  const displayGroups = useMemo(() => {
    if (!root || !config) return groups;
    return groups
      .map((group, original) => {
        if (group.kind === "styles") {
          return { group, tier: 3, collectionLabel: "", exact: false, original };
        }
        const collection = group.label ? matchCollectionForDir(config, root, group.path) : null;
        const exact = collection !== null && group.path === root + "/" + collection.path;
        return {
          // Subfolder groups of a collection sort with it but keep their
          // directory label, so nested dirs stay distinguishable.
          group: exact ? { ...group, label: collection.label ?? collection.name } : group,
          tier: !group.label ? 0 : collection ? 1 : 2,
          collectionLabel: collection ? (collection.label ?? collection.name) : "",
          exact,
          original,
        };
      })
      .sort(
        (a, b) =>
          a.tier - b.tier ||
          a.collectionLabel.localeCompare(b.collectionLabel, undefined, {
            sensitivity: "base",
          }) ||
          Number(b.exact) - Number(a.exact) ||
          a.original - b.original,
      )
      .map((d) => d.group);
  }, [groups, config, root]);

  // Markdown files always get a Form tab: schema-driven when a content entry
  // matches, otherwise with fields inferred from the frontmatter's shape.
  const showForm = entry !== null || /\.(md|mdx|markdown)$/i.test(filePath ?? "");

  // Whether the Fields tab has anything to show. README-style files (no
  // schema, no frontmatter) hide the tab and land on Body instead.
  const hasFields = useMemo(() => {
    if (entry !== null) return true;
    if (!showForm) return false;
    return contentHasFields(null, parseFile(fileContent));
  }, [entry, showForm, fileContent]);

  // The sticky tab choice, remapped while Fields is hidden; the state keeps
  // "fields" so schema-backed files still open on their form.
  const activeTab = !hasFields && editorTab === "fields" ? "body" : editorTab;

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
          <Button.Group>
            <Button size="xs" variant="default" onClick={() => void chooseDirectory()}>
              {root ? rootName : "Choose directory"}
            </Button>
            <Menu position="bottom-start" width={220}>
              <Menu.Target>
                <Button
                  size="xs"
                  variant="default"
                  px={6}
                  aria-label="Recent sites"
                  disabled={recentOptions.length === 0}
                >
                  <ChevronDown size={14} />
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>Recent sites</Menu.Label>
                {recentOptions.map((dir) => (
                  <Menu.Item key={dir} title={dir} onClick={() => void selectRoot(dir)}>
                    {dir.split("/").filter(Boolean).pop()}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
          </Button.Group>
          <span className="navbar-status">{publishState}</span>
          {behindUpstream ? (
            <Button size="xs" color="teal" loading={pulling} onClick={() => void fetchChanges()}>
              Fetch Changes
            </Button>
          ) : (
            <Button
              size="xs"
              disabled={!root || !hasLocalChanges}
              onClick={() => void openPublishModal()}
            >
              Publish…
            </Button>
          )}
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
                    <RevertButton file={file} onRevert={(f) => void revertChange(f)} />
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

        {root && newFileGroup && (
          <NewFileModal
            root={root}
            group={newFileGroup}
            config={config ?? EMPTY_CONFIG}
            astroContent={astroConfig?.content ?? []}
            onClose={() => setNewFileGroup(null)}
            onCreated={(path) => void onFileCreated(path)}
          />
        )}

        {!root ? (
          <div className="empty-state">
            <p>Select the folder that holds your site to get started.</p>
            <Button onClick={() => void chooseDirectory()}>Choose directory</Button>
          </div>
        ) : (
          <div className="body">
            <aside className="sidebar">
              {displayGroups.map((group) =>
                group.label ? (
                  // The synthetic Styles group shares its path with the root
                  // group, so the key needs the kind to stay unique.
                  <details key={`${group.kind ?? ""}:${group.path}`} open>
                    <summary>
                      <span className="group-label" title={group.label}>
                        {group.label}
                      </span>
                      {group.kind !== "styles" && (
                        <button
                          type="button"
                          className="group-action"
                          title="New file"
                          aria-label={`New file in ${group.label}`}
                          onClick={(e) => {
                            // A click inside <summary> would also toggle the group.
                            e.preventDefault();
                            e.stopPropagation();
                            setNewFileGroup(group);
                          }}
                        >
                          <Plus size={14} />
                        </button>
                      )}
                      <ChevronDown size={14} className="group-chevron" />
                    </summary>
                    <FileList
                      files={group.files}
                      activePath={filePath}
                      onOpen={(path) => void openFile(path)}
                      onDelete={(file) => void deleteFile(file)}
                    />
                  </details>
                ) : (
                  <FileList
                    key={group.path}
                    files={group.files}
                    activePath={filePath}
                    onOpen={(path) => void openFile(path)}
                    onDelete={(file) => void deleteFile(file)}
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
                      {entry && (
                        <Badge
                          size="sm"
                          variant="light"
                          color={entrySource === "astro" ? "grape" : "blue"}
                          title={
                            entrySource === "astro"
                              ? "Schema from Astro content collections"
                              : "Schema from .pages.yml"
                          }
                        >
                          {entrySource === "astro" ? "Astro" : ".pages.yml"}
                        </Badge>
                      )}
                    </div>
                    {configError && (
                      <Alert color="yellow" className="config-error">
                        {astroConfig
                          ? `.pages.yml is invalid (falling back to Astro collection schemas) — ${configError}`
                          : `Form editing disabled: .pages.yml is invalid — ${configError}`}
                      </Alert>
                    )}
                    {!showForm ? (
                      rawEditor
                    ) : (
                      <Tabs
                        className="pane-tabs"
                        value={activeTab}
                        onChange={(value) => setEditorTab(value as typeof editorTab)}
                      >
                        <Tabs.List>
                          {hasFields && <Tabs.Tab value="fields">Fields</Tabs.Tab>}
                          <Tabs.Tab value="body">Body</Tabs.Tab>
                          <Tabs.Tab value="raw">Raw</Tabs.Tab>
                        </Tabs.List>
                        {activeTab === "raw" ? (
                          rawEditor
                        ) : (
                          // One FormEditor spans the Fields and Body tabs so the
                          // parsed document survives switching between them.
                          <FormEditor
                            key={filePath}
                            path={filePath}
                            view={activeTab}
                            content={fileContent}
                            entry={entry}
                            config={config ?? EMPTY_CONFIG}
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
                <div className="pane-header">
                  <span className="pane-title">{servedRoute ?? previewRoute}</span>
                  <Button
                    size="xs"
                    variant="default"
                    disabled={server.state === "setup"}
                    onClick={() => void restartServer(root)}
                  >
                    Restart Preview
                  </Button>
                </div>
                <Tabs className="pane-tabs" defaultValue="site">
                  <Tabs.List>
                    <Tabs.Tab value="site">Preview</Tabs.Tab>
                    <Tabs.Tab value="seo">Search/Socials</Tabs.Tab>
                  </Tabs.List>
                  <Tabs.Panel value="site">
                    {server.state === "setup" && (
                      <div className="pane-placeholder">
                        <ol className="setup-steps">
                          {server.steps.map((step) => (
                            <li key={step.id} className={`setup-step setup-step-${step.status}`}>
                              <span className="setup-step-icon">
                                {step.status === "active" ? (
                                  <Loader size={14} />
                                ) : step.status === "done" ? (
                                  <Check size={15} />
                                ) : step.status === "error" ? (
                                  <X size={15} />
                                ) : null}
                              </span>
                              <span className="setup-step-label">{step.label}</span>
                              {step.detail && (
                                <span className="setup-step-detail">{step.detail}</span>
                              )}
                            </li>
                          ))}
                        </ol>
                        {server.awaitingInstall && (
                          <Button size="xs" onClick={() => void runSetup(root, server.steps)}>
                            Install
                          </Button>
                        )}
                        {server.steps.some((s) => s.status === "error") && (
                          <Button
                            size="xs"
                            variant="default"
                            onClick={() => void startServer(root)}
                          >
                            Retry
                          </Button>
                        )}
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
                      <SeoPreview
                        route={previewRoute}
                        root={root}
                        media={config?.media[0] ?? null}
                        port={server.port}
                        refreshKey={saveTick}
                      />
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

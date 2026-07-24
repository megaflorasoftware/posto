import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionIcon, Button, MantineProvider, Modal, Switch } from "@mantine/core";
import { Notifications, notifications } from "@mantine/notifications";
import {
  invoke,
  onFsChanged,
  onOpenFile,
  onOpenFullscreenEditor,
  onOpenRecent,
  onOpenRepository,
  onOpenSettings,
  onOpenSiblingProject,
  onToggleSidebar,
  openDirectory,
  setOpenFileMenuEnabled,
  setFullscreenEditorMenuEnabled,
  setRepositoryMenuItemsEnabled,
} from "@posto/ipc";
import { checkForAppUpdate } from "./updater";
import type { ChangedFile, FileEntry, FileGroup } from "@posto/ipc";
import { EMPTY_CONFIG, matchEntry, renamedFilename } from "@posto/core/pagescms/config";
import { parseFile } from "@posto/core/pagescms/frontmatter";
import {
  type ProjectCandidate,
  type ProjectInventory,
  workspaceLayoutChanged,
  workspaceProjects,
} from "@posto/core/project/workspace";
import {
  EditorPane,
  ImageLibraryDropImport,
  MediaDragDropProvider,
  OpenFileSpotlight,
  PublishModal,
  Sidebar,
  buildNewFile,
  createDataDocumentEntry,
  deleteDataDocumentEntry,
  renameTargetForContent,
  useCurrentFile,
  useFileGroups,
  useGitSync,
  useSchemas,
  useProjectSession,
  ipcProjectIO,
  useSiteUrl,
  WorkspaceChooser,
  type EditorTab,
} from "@posto/editor";
import { useDevServer } from "./hooks/useDevServer";
import { usePreview } from "./hooks/usePreview";
import { useDeployment } from "./hooks/useDeployment";
import { DeploymentDrawer } from "./components/DeploymentDrawer";
import { MediaSidebar } from "./components/MediaSidebar";
import { PreviewPane } from "./components/PreviewPane";
import { RecentProjectsSpotlight } from "./components/RecentProjectsSpotlight";
import {
  ChevronLeft,
  Columns3,
  Files,
  Image as ImageIcon,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";

import "@mantine/core/styles.css";
import "@mantine/tiptap/styles.css";
import "@mantine/spotlight/styles.css";
import "@mantine/notifications/styles.css";
import "@posto/editor/styles.css";
import "./App.css";

function App() {
  const [root, setRoot] = useState<string | null>(null);
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const [workspaceCandidates, setWorkspaceCandidates] = useState<ProjectCandidate[] | null>(null);
  const projectSession = useProjectSession({
    io: ipcProjectIO,
    scanProjects: (repository) => invoke<ProjectInventory[]>("scan_projects", { root: repository }),
    getRememberedWorkDir: (repository) =>
      invoke<string | null>("get_work_dir", { root: repository }),
  });
  const { projectInfo, adapter } = projectSession;
  // Recently-opened site roots, newest first (backend caps at 10).
  const [recentRoots, setRecentRoots] = useState<string[]>([]);
  // Raw source is a developer-only alternate view of the continuous editor.
  const [editorTab, setEditorTab] = useState<EditorTab>("content");
  const [publishOpen, setPublishOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const [sidebarView, setSidebarView] = useState<"files" | "media">("files");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [fullscreenEditorOpen, setFullscreenEditorOpen] = useState(false);
  const [fullscreenSidebarOpen, setFullscreenSidebarOpen] = useState(false);
  const [openFileSpotlightOpen, setOpenFileSpotlightOpen] = useState(false);
  const [recentProjectsSpotlightOpen, setRecentProjectsSpotlightOpen] = useState(false);
  // Bumped after each successful save so the SEO preview refetches the page.
  const [saveTick, setSaveTick] = useState(0);
  const [componentSchemaVersion, setComponentSchemaVersion] = useState(0);
  const [siteUrlVersion, setSiteUrlVersion] = useState(0);

  // Latest values for callbacks that outlive the render they were created in.
  const rootRef = useRef(root);
  rootRef.current = root;
  const fullscreenEditorOpenRef = useRef(fullscreenEditorOpen);
  fullscreenEditorOpenRef.current = fullscreenEditorOpen;
  const selectionGenerationRef = useRef(0);

  const schemas = useSchemas(adapter, ipcProjectIO);
  const notify = useCallback((message: string, severity: "progress" | "success" | "error") => {
    notifications.show({
      message,
      color: severity === "error" ? "red" : severity === "success" ? "green" : "blue",
      autoClose: severity === "error" ? false : severity === "success" ? 5000 : 3000,
      withCloseButton: true,
    });
  }, []);
  const notifyError = useCallback((message: string) => notify(message, "error"), [notify]);

  const files = useFileGroups(notifyError, adapter.capabilities.dataDocuments);
  const devServer = useDevServer();
  const deployment = useDeployment(repoRoot);
  const siteUrl = useSiteUrl(root, adapter, siteUrlVersion);

  const currentFile = useCurrentFile({
    onAfterSave(path, content) {
      files.updateSidebarTitle(path, content);
      const dir = rootRef.current;
      if (
        dir &&
        schemas.configRef.current?.content.some(
          (entry) => entry.dataFile && `${dir}/${entry.dataFile.path}` === path,
        )
      ) {
        void files.refreshDataGroups(dir, schemas.configRef.current);
      }
      setSaveTick((t) => t + 1);
      // Editing the schema itself must re-parse it, or forms keep the old one.
      if (dir && path === dir + "/.pages.yml") void schemas.loadPagesConfig(dir);
      if (dir) void invalidateAdapterPaths([path]);
      // Frontmatter drives template-derived filenames; each (already
      // debounced) save is the moment to bring the name back in line.
      void renameForTemplate(path, content);
    },
    onOpened(path, content, file) {
      if (file?.dataEntry) {
        setEditorTab("content");
        return;
      }
      if (!/\.(md|mdx|markdown)$/i.test(path)) setEditorTab("raw");
      if (navigatePreviewRef.current) void preview.navigateForFile(path, content);
    },
    onOpenError(message) {
      notify(message, "error");
    },
  });

  // openFile normally moves the preview along; reverse routing (the preview
  // moved first) must not, or the two would fight. The flag rides a ref
  // because onOpened runs from the hook, outside this call stack's scope.
  const navigatePreviewRef = useRef(true);
  function openFile(target: string | FileEntry, navigatePreview = true) {
    navigatePreviewRef.current = navigatePreview;
    void currentFile.openFile(target);
  }

  const preview = usePreview({
    server: devServer.server,
    serverRef: devServer.serverRef,
    groupsRef: files.groupsRef,
    filePathRef: currentFile.filePathRef,
    onRouteOpened: (path) => openFile(path, false),
    adapter,
    root,
  });

  const git = useGitSync(root, {
    onStatus: notify,
    onPublishError: notifyError,
    beforeSync: () => currentFile.flushPendingSave(),
    afterPull: refreshAfterPull,
  });

  // Every event that can change git status also refreshes the sidebar, so
  // this keeps the header's Publish button state current too.
  async function refreshGroups(dir: string) {
    void git.refreshLocalChanges(dir);
    await files.refreshGroups(dir);
    await files.refreshDataGroups(dir, schemas.configRef.current);
  }

  async function recoverMissingWorkDir(repository: string, dir: string): Promise<boolean> {
    if (await ipcProjectIO.pathExists(dir, "directory")) return false;
    const scan = await projectSession.scanRepository(repository);
    ++selectionGenerationRef.current;
    currentFile.clearPendingSave();
    currentFile.closeFile();
    projectSession.clear();
    setRoot(null);
    setRepoRoot(repository);
    setWorkspaceCandidates([{ dir: repository, ...scan.root }, ...scan.candidates]);
    preview.resetRoute();
    void invoke("stop_dev_server");
    notify(
      "The selected project directory moved or was removed. Choose a project to continue.",
      "error",
    );
    return true;
  }

  async function refreshAfterPull(dir: string) {
    const repository = repoRoot ?? dir;
    try {
      if (await recoverMissingWorkDir(repository, dir)) return;
      const scan = await projectSession.scanRepository(repository);
      setWorkspaceCandidates((current) =>
        current ? [{ dir: repository, ...scan.root }, ...scan.candidates] : current,
      );
      await refreshGroups(dir);
      await currentFile.reloadFromDisk();
    } catch (error) {
      notify(
        `Could not refresh workspace: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  async function selectRoot(repository: string, dir: string, requestedGeneration?: number) {
    const generation = requestedGeneration ?? ++selectionGenerationRef.current;
    let activation;
    try {
      activation = await projectSession.prepare(dir);
    } catch (error) {
      if (generation !== selectionGenerationRef.current) return;
      notify(
        `Could not inspect project: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }
    if (generation !== selectionGenerationRef.current) return;
    projectSession.commit(activation);
    const selectedAdapter = activation.adapter;
    void currentFile.flushPendingSave();
    setRoot(dir);
    setRepoRoot(repository);
    setWorkspaceCandidates(null);
    currentFile.closeFile();
    preview.resetRoute();
    await schemas.loadSchemas(dir, selectedAdapter);
    if (generation !== selectionGenerationRef.current) return;
    await refreshGroups(dir);
    if (generation !== selectionGenerationRef.current) return;
    void devServer.startServer(dir);
    void invoke("set_last_root", { root: repository, workDir: dir }).then(() =>
      refreshRecentRoots(),
    );
    const extraPaths =
      repository === dir
        ? []
        : ["package.json", "pnpm-workspace.yaml", "lerna.json", "turbo.json"].map(
            (path) => `${repository}/${path}`,
          );
    void invoke("watch_root", {
      root: dir,
      ignoreRules: selectedAdapter.watchIgnores(),
      extraPaths,
      workspaceRoot: repository,
    });
  }

  async function selectRepository(repository: string) {
    const generation = ++selectionGenerationRef.current;
    try {
      const decision = await projectSession.resolveRepository(repository);
      if (generation !== selectionGenerationRef.current) return;
      if (decision.kind === "choose") {
        setRepoRoot(repository);
        setRoot(null);
        projectSession.clear();
        setWorkspaceCandidates(decision.candidates);
        return;
      }
      await selectRoot(repository, decision.workDir, generation);
    } catch (error) {
      if (generation !== selectionGenerationRef.current) return;
      notify(
        `Could not inspect project: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  async function chooseProjectInRepository() {
    if (!repoRoot) return;
    try {
      const scan = await projectSession.scanRepository(repoRoot);
      setWorkspaceCandidates(workspaceProjects(repoRoot, scan));
    } catch (error) {
      notify(
        `Could not inspect project: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  async function browseWithinRepository() {
    if (!repoRoot) return;
    const dir = await openDirectory(repoRoot);
    if (typeof dir !== "string") return;
    if (dir !== repoRoot && !dir.startsWith(`${repoRoot}/`)) {
      notify("Choose a folder inside the current repository.", "error");
      return;
    }
    await selectRoot(repoRoot, dir);
  }

  async function refreshRecentRoots() {
    try {
      setRecentRoots(await invoke<string[]>("get_recent_roots"));
    } catch {
      setRecentRoots([]);
    }
  }

  async function chooseDirectory() {
    const dir = await openDirectory();
    if (typeof dir === "string") void selectRepository(dir);
  }

  function schemaSources() {
    return { config: schemas.configRef.current ?? EMPTY_CONFIG };
  }

  // "New file" creates immediately — an "Untitled" entry with the
  // collection's defaults — and opens it; no dialog. The filename follows
  // the title (or whatever fields the template names) as the user edits.
  async function createNewFile(group: FileGroup) {
    const dir = rootRef.current;
    if (!dir) return;
    if (group.dataCollection) {
      const collection = schemas.configRef.current?.content.find(
        (entry) => entry.name === group.dataCollection,
      );
      if (!collection) return;
      try {
        const id = await createDataDocumentEntry(group, collection);
        await files.refreshDataGroups(dir, schemas.configRef.current);
        const created = files.groupsRef.current
          .find((candidate) => candidate.dataCollection === group.dataCollection)
          ?.files.find((file) => file.dataEntry?.id === id);
        if (created) openFile(created);
      } catch (e) {
        notify(String(e), "error");
      }
      return;
    }
    const { path, content } = buildNewFile(dir, group, schemaSources());
    try {
      await invoke("create_text_file", { path, content });
    } catch (e) {
      notify(String(e), "error");
      return;
    }
    await refreshGroups(dir);
    // A new markdown file with a schema should land in the visual editor.
    const cfg = schemas.configRef.current;
    if (/\.(md|mdx)$/i.test(path) && cfg && matchEntry(cfg, dir, path) !== null) {
      setEditorTab("content");
    }
    openFile(path);
  }

  // Keeps a template-derived filename in step with the frontmatter it's
  // derived from, riding the (debounced) autosave: rename on disk, retarget
  // the editor, refresh the sidebar, and move the preview to the new route.
  async function renameForTemplate(path: string, content: string) {
    const dir = rootRef.current;
    if (!dir || currentFile.filePathRef.current !== path) return;
    const target = renameTargetForContent(dir, path, content, schemaSources());
    if (!target) return;
    // Another entry already owns the name; keep ours until the fields change.
    if (files.groupsRef.current.some((g) => g.files.some((f) => f.path === target))) {
      notify(`A file named ${target.slice(target.lastIndexOf("/") + 1)} already exists.`, "error");
      return;
    }
    if (!(await currentFile.renameOpenFile(path, target))) return;
    void refreshGroups(dir);
    void preview.navigateForFile(target, content);
  }

  async function renameOpenFilename(filename: string): Promise<boolean> {
    const dir = rootRef.current;
    const from = currentFile.filePathRef.current;
    if (!dir || !from || filename.includes("/")) return false;
    const target = from.slice(0, from.lastIndexOf("/") + 1) + filename;
    if (target === from) return true;
    if (files.groupsRef.current.some((group) => group.files.some((file) => file.path === target))) {
      notify(`A file named ${filename} already exists.`, "error");
      return false;
    }
    if (!(await currentFile.renameOpenFile(from, target))) {
      notify(`Could not rename the file to ${filename}.`, "error");
      return false;
    }
    void refreshGroups(dir);
    void preview.navigateForFile(target, currentFile.fileContentRef.current);
    return true;
  }

  function refreshFilenameTemplate(template: string) {
    const path = currentFile.filePathRef.current;
    if (!path || !entry) return;
    const parsed = parseFile(currentFile.fileContentRef.current);
    const raw = parsed.doc.toJSON() as unknown;
    if (parsed.error || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      notify("Fix the file's frontmatter before refreshing its filename.", "error");
      return;
    }
    const currentName = path.slice(path.lastIndexOf("/") + 1);
    const next = renamedFilename(template, entry, raw as Record<string, unknown>, currentName);
    if (next) void renameOpenFilename(next);
  }

  // Files changed outside the app (other editors, git, `astro sync`, …):
  // refresh whatever the paths affect. Our own saves also echo through here,
  // but resolve to no-ops (content already matches).
  function onExternalChanges(paths: string[]) {
    const dir = rootRef.current;
    if (!dir) return;
    void refreshGroups(dir);
    if (paths.includes(dir + "/.pages.yml")) void schemas.loadPagesConfig(dir);
    if (paths.some((p) => p.startsWith(dir + "/.posto/"))) void schemas.loadPostoConfig(dir);
    void invalidateAdapterPaths(paths);
    if (paths.includes(currentFile.filePathRef.current ?? "")) {
      void currentFile.reloadFromDisk();
    }
  }

  async function invalidateAdapterPaths(paths: string[]) {
    const dir = rootRef.current;
    if (!dir) return;
    if (repoRoot && (await recoverMissingWorkDir(repoRoot, dir))) return;
    if (repoRoot && workspaceLayoutChanged(repoRoot, dir, paths)) {
      const scan = await projectSession.scanRepository(repoRoot);
      setWorkspaceCandidates((current) =>
        current ? [{ dir: repoRoot, ...scan.root }, ...scan.candidates] : current,
      );
    }
    const scopes = projectSession.invalidations(dir, paths, schemas.configRef.current);
    if (scopes.has("projectType")) {
      const detected = await projectSession.inspect(dir);
      if (detected.type !== projectInfo?.type) {
        await selectRoot(repoRoot ?? dir, dir);
        return;
      }
      projectSession.setProjectInfo(detected);
    }
    if (scopes.has("derivedConfig")) void schemas.loadDerivedConfig(dir, adapter);
    if (scopes.has("componentSchemas")) setComponentSchemaVersion((version) => version + 1);
    if (scopes.has("siteUrl")) setSiteUrlVersion((version) => version + 1);
    if (scopes.has("dataDocuments")) {
      void files.refreshDataGroups(dir, schemas.configRef.current);
    }
    if (scopes.has("mediaLibraries")) void refreshGroups(dir);
  }

  const externalChangesRef = useRef(onExternalChanges);
  externalChangesRef.current = onExternalChanges;
  const chooseDirectoryRef = useRef(chooseDirectory);
  chooseDirectoryRef.current = chooseDirectory;
  const chooseProjectInRepositoryRef = useRef(chooseProjectInRepository);
  chooseProjectInRepositoryRef.current = chooseProjectInRepository;

  useEffect(() => {
    const unlistenFs = onFsChanged((paths) => externalChangesRef.current(paths));
    const unlistenSettings = onOpenSettings(() => setSettingsOpen(true));
    const unlistenOpenFile = onOpenFile(() => {
      if (rootRef.current) setOpenFileSpotlightOpen(true);
    });
    const unlistenOpenRepository = onOpenRepository(() => {
      void chooseDirectoryRef.current();
    });
    const unlistenOpenRecent = onOpenRecent(() => setRecentProjectsSpotlightOpen(true));
    const unlistenOpenSiblingProject = onOpenSiblingProject(() => {
      void chooseProjectInRepositoryRef.current();
    });
    const unlistenFullscreenEditor = onOpenFullscreenEditor(() => {
      if (rootRef.current) setFullscreenEditorOpen((open) => !open);
    });
    const unlistenToggleSidebar = onToggleSidebar(() => {
      if (fullscreenEditorOpenRef.current) {
        setFullscreenSidebarOpen((open) => !open);
      } else {
        setSidebarOpen((open) => !open);
      }
    });
    // One update check per app launch, once the UI is up.
    void checkForAppUpdate();
    void refreshRecentRoots();
    void invoke<boolean>("get_developer_mode").then(setDeveloperMode).catch(notifyError);
    void (async () => {
      const last = await invoke<{ root: string; workDir: string | null } | null>(
        "get_last_selection",
      );
      if (last && !rootRef.current) {
        if (last.workDir) void selectRoot(last.root, last.workDir);
        else void selectRepository(last.root);
      }
    })();
    return () => {
      unlistenFs();
      unlistenSettings();
      unlistenOpenFile();
      unlistenOpenRepository();
      unlistenOpenRecent();
      unlistenOpenSiblingProject();
      unlistenFullscreenEditor();
      unlistenToggleSidebar();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openPublishModal() {
    const dir = rootRef.current;
    if (!dir) return;
    // Pending edits must hit disk before git status, or they won't show.
    await currentFile.flushPendingSave();
    setPublishOpen(true);
    void git.loadChanges(dir);
  }

  async function deleteFile(file: FileEntry) {
    const dir = rootRef.current;
    if (!dir) return;
    const isOpen = currentFile.activeKey === (file.key ?? file.path);
    const sharesOpenDocument = !!file.dataEntry && currentFile.filePathRef.current === file.path;
    if (isOpen) {
      // A pending autosave would recreate the file right after the delete.
      currentFile.clearPendingSave();
    }
    try {
      if (file.dataEntry) await deleteDataDocumentEntry(file);
      else await invoke("delete_file", { path: file.path });
    } catch (e) {
      notify(String(e), "error");
      return;
    }
    if (isOpen) currentFile.closeFile();
    else if (sharesOpenDocument) void currentFile.reloadFromDisk();
    if (file.path === dir + "/.pages.yml") void schemas.loadPagesConfig(dir);
    if (file.dataEntry) void files.refreshDataGroups(dir, schemas.configRef.current);
    else void refreshGroups(dir);
  }

  async function revertChange(file: ChangedFile) {
    const dir = rootRef.current;
    if (!dir) return;
    // `file.path` is repo-relative; the open file's absolute path ends with it.
    const open = currentFile.filePathRef.current;
    const revertingOpenFile = open !== null && open.endsWith("/" + file.path);
    if (revertingOpenFile) {
      // A pending autosave would immediately re-write the reverted content.
      currentFile.clearPendingSave();
    }
    if (!(await git.revertChange(dir, file))) return;
    void refreshGroups(dir);
    if (revertingOpenFile && open) {
      if (file.status === "??") {
        // The file was deleted; nothing left to show.
        currentFile.closeFile();
      } else {
        try {
          currentFile.setContentFromDisk(await invoke<string>("read_text_file", { path: open }));
        } catch {
          // Deleted-then-reverted edge cases: fall back to no selection.
          currentFile.closeFile();
        }
      }
    }
  }

  const config = schemas.config;

  useEffect(() => {
    if (root) void files.refreshDataGroups(root, config);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, config]);

  // Content entry describing the open file's fields, if any.
  const entry = useMemo(() => {
    if (!root || !currentFile.filePath || !config) return null;
    if (currentFile.dataEntry) {
      return (
        config.content.find((candidate) => candidate.name === currentFile.dataEntry?.collection) ??
        null
      );
    }
    return matchEntry(config, root, currentFile.filePath);
  }, [root, currentFile.filePath, currentFile.dataEntry, config]);

  // Which source the matched entry came from, for the header badge. Matched
  // by name+path because the `.posto` overlay clones entries it touches;
  // `.pages.yml` wins ties, matching the config's precedence order.
  const entrySource =
    entry === null
      ? null
      : schemas.pagesConfig?.content.some((e) => e.name === entry.name && e.path === entry.path)
        ? "pages"
        : schemas.derivedConfig?.content.some((e) => e.name === entry.name && e.path === entry.path)
          ? (projectInfo?.type ?? null)
          : null;

  // The native View menu owns these accelerators in Tauri. Keep the Vite/browser
  // development experience equivalent without firing twice in the desktop shell.
  useEffect(() => {
    if ("__TAURI_INTERNALS__" in window) return;
    const handleViewShortcut = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (event.key === "\\" && command && !event.altKey) {
        event.preventDefault();
        if (fullscreenEditorOpenRef.current) {
          setFullscreenSidebarOpen((open) => !open);
        } else {
          setSidebarOpen((open) => !open);
        }
      }
      if (event.key.toLowerCase() === "f" && command && event.shiftKey && !event.altKey) {
        event.preventDefault();
        if (rootRef.current) setFullscreenEditorOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", handleViewShortcut);
    return () => window.removeEventListener("keydown", handleViewShortcut);
  }, []);

  useEffect(() => {
    if (!root) setOpenFileSpotlightOpen(false);
    void setOpenFileMenuEnabled(root !== null).catch(notifyError);
  }, [root, notifyError]);

  useEffect(() => {
    const hasRecent = recentRoots.some((repository) => repository !== repoRoot);
    void setRepositoryMenuItemsEnabled(hasRecent, projectSession.hasMultipleProjects).catch(
      notifyError,
    );
  }, [recentRoots, repoRoot, projectSession.hasMultipleProjects, notifyError]);

  useEffect(() => {
    void setFullscreenEditorMenuEnabled(root !== null).catch(notifyError);
  }, [root, notifyError]);

  const renderFullscreenExit = () => (
    <ActionIcon
      size={26}
      variant="subtle"
      color="gray"
      title="Exit fullscreen editor"
      aria-label="Exit fullscreen editor"
      onClick={() => setFullscreenEditorOpen(false)}
    >
      <ChevronLeft size={16} />
    </ActionIcon>
  );
  const renderFullscreenSidebarToggle = () => (
    <ActionIcon
      className="fullscreen-sidebar-toggle"
      size={26}
      variant="subtle"
      color="gray"
      title={`${fullscreenSidebarOpen ? "Hide" : "Show"} sidebars (Cmd/Ctrl + \\)`}
      aria-label={`${fullscreenSidebarOpen ? "Hide" : "Show"} sidebars`}
      aria-pressed={fullscreenSidebarOpen}
      onClick={(event) => {
        event.currentTarget.blur();
        setFullscreenSidebarOpen((open) => !open);
      }}
    >
      <Columns3 size={16} />
    </ActionIcon>
  );

  const renderFileSidebar = () =>
    root ? (
      <Sidebar
        root={root}
        groups={files.groups}
        config={config}
        activeKey={currentFile.activeKey}
        onOpen={(file) => openFile(file)}
        onDelete={(file) => void deleteFile(file)}
        onNewFile={(group) => void createNewFile(group)}
        developerMode={developerMode}
        onPostoSaved={() => void schemas.loadPostoConfig(root)}
      />
    ) : null;

  const renderMediaSidebar = () =>
    root && config ? (
      <MediaSidebar
        root={root}
        config={config}
        groups={files.groups}
        libraries={config.mediaLibraries ?? []}
        onBeforeChange={currentFile.flushPendingSave}
        onChanged={(options) => {
          if (!options?.silent) {
            notify("Media updated. Publish when you are ready.", "success");
          }
          void refreshGroups(root);
          void currentFile.reloadFromDisk();
        }}
      />
    ) : null;

  const renderEditorPane = (withFullscreenButton = false, fullscreen = false) =>
    root ? (
      <EditorPane
        root={root}
        projectIO={ipcProjectIO}
        filePath={currentFile.filePath}
        fileContent={currentFile.fileContent}
        saveState={currentFile.saveState}
        entry={entry}
        dataEntry={currentFile.dataEntry}
        entrySource={entrySource}
        config={config}
        configError={schemas.configError}
        hasDerivedFallback={schemas.derivedConfig !== null}
        componentBlocks={adapter.capabilities.componentBlocks}
        entryIds={adapter.capabilities.entryIds}
        componentSchemaVersion={componentSchemaVersion}
        groups={files.groups}
        editorTab={editorTab}
        onTabChange={setEditorTab}
        onEdit={currentFile.onEdit}
        onFormEdit={currentFile.onFormEdit}
        onRenameFile={renameOpenFilename}
        onRefreshFilename={refreshFilenameTemplate}
        onPostoSaved={() => void schemas.loadPostoConfig(root)}
        onBeforeMediaChange={currentFile.flushPendingSave}
        onMediaChanged={(options) => {
          if (!options?.silent) {
            notify("Media updated. Publish when you are ready.", "success");
          }
          void refreshGroups(root);
          void currentFile.reloadFromDisk();
        }}
        developerMode={developerMode}
        onFullscreen={withFullscreenButton ? () => setFullscreenEditorOpen(true) : undefined}
        headerLeading={fullscreen ? renderFullscreenExit() : undefined}
        headerTrailing={fullscreen ? renderFullscreenSidebarToggle() : undefined}
      />
    ) : null;

  const renderPreviewPane = () =>
    root ? (
      <PreviewPane
        root={root}
        server={devServer.server}
        previewRoute={preview.previewRoute}
        servedRoute={preview.servedRoute}
        previewFrame={preview.previewFrame}
        dragging={preview.dragging}
        media={config?.media[0] ?? null}
        saveTick={saveTick}
        onRestart={() => void devServer.restartServer(root)}
        onRetry={() => void devServer.startServer(root)}
        onInstall={(steps) => void devServer.runSetup(root, steps)}
        onHome={preview.goHome}
        deployment={deployment}
        behindUpstream={git.behindUpstream}
        pulling={git.pulling}
        publishing={git.publishing}
        hasLocalChanges={git.hasLocalChanges}
        onFetchChanges={() => void git.fetchChanges()}
        onOpenPublish={() => void openPublishModal()}
      />
    ) : null;

  return (
    <MantineProvider defaultColorScheme="auto">
      <MediaDragDropProvider>
        <Notifications position="bottom-right" />
        <div className="app">
          {openFileSpotlightOpen && root && (
            <OpenFileSpotlight
              root={root}
              groups={files.groups}
              config={config}
              onClose={() => setOpenFileSpotlightOpen(false)}
              onOpen={(file) => {
                setOpenFileSpotlightOpen(false);
                openFile(file);
              }}
            />
          )}
          {recentProjectsSpotlightOpen && (
            <RecentProjectsSpotlight
              roots={recentRoots}
              currentRoot={repoRoot}
              onClose={() => setRecentProjectsSpotlightOpen(false)}
              onOpen={(repository) => {
                setRecentProjectsSpotlightOpen(false);
                void selectRepository(repository);
              }}
            />
          )}

          <DeploymentDrawer deployment={deployment} siteUrl={siteUrl} />

          <PublishModal
            opened={publishOpen}
            changes={git.changes}
            error={git.changesError}
            scopeLabel={
              repoRoot && root && repoRoot !== root ? root.slice(repoRoot.length + 1) : undefined
            }
            onClose={() => setPublishOpen(false)}
            onRevert={(file) => void revertChange(file)}
            onPublish={(message) => {
              setPublishOpen(false);
              const sinceRunId = deployment.latestRun?.id ?? null;
              void git.publish(message).then((published) => {
                if (published) deployment.expectNewRun(sinceRunId);
              });
            }}
          />

          <Modal opened={settingsOpen} onClose={() => setSettingsOpen(false)} title="Settings">
            <Switch
              label="Enable developer mode"
              checked={developerMode}
              onChange={(event) => {
                const enabled = event.currentTarget.checked;
                setDeveloperMode(enabled);
                void invoke("set_developer_mode", { enabled }).catch((error) => {
                  setDeveloperMode(!enabled);
                  notify(`Could not save settings: ${String(error)}`, "error");
                });
              }}
            />
          </Modal>

          {root && config && (
            <ImageLibraryDropImport
              root={root}
              config={config}
              groups={files.groups}
              onImported={() => void refreshGroups(root)}
              onError={notifyError}
            />
          )}

          {workspaceCandidates && repoRoot ? (
            <div className="empty-state">
              <WorkspaceChooser
                repoRoot={repoRoot}
                candidates={workspaceCandidates}
                onChoose={(candidate) => void selectRoot(repoRoot, candidate.dir)}
                onBrowse={() => void browseWithinRepository()}
              />
            </div>
          ) : !root ? (
            <div className="empty-state">
              <p>Open a repository from the File menu to get started.</p>
              <Button onClick={() => void chooseDirectory()}>Choose directory</Button>
            </div>
          ) : (
            <div className="body" ref={preview.bodyEl}>
              {!fullscreenEditorOpen &&
                (sidebarOpen ? (
                  <>
                    <div className="sidebar-pane" style={{ flexBasis: `${preview.sidebarSplit}%` }}>
                      <div className="sidebar-header" data-tauri-drag-region>
                        <ActionIcon
                          size={26}
                          variant={sidebarView === "files" ? "light" : "subtle"}
                          color={sidebarView === "files" ? "blue" : "gray"}
                          title="Show files"
                          aria-label="Show files"
                          onClick={() => setSidebarView("files")}
                        >
                          <Files size={16} />
                        </ActionIcon>
                        <ActionIcon
                          size={26}
                          variant={sidebarView === "media" ? "light" : "subtle"}
                          color={sidebarView === "media" ? "blue" : "gray"}
                          title="Show media library"
                          aria-label="Show media library"
                          disabled={!config}
                          onClick={() => setSidebarView("media")}
                        >
                          <ImageIcon size={16} />
                        </ActionIcon>
                        <span className="sidebar-header-spacer" />
                        <ActionIcon
                          size={26}
                          variant="subtle"
                          color="gray"
                          title="Hide sidebar"
                          aria-label="Hide sidebar"
                          onClick={() => setSidebarOpen(false)}
                        >
                          <PanelLeftClose size={16} />
                        </ActionIcon>
                      </div>
                      <div className="sidebar-content">
                        {sidebarView === "files" ? renderFileSidebar() : renderMediaSidebar()}
                      </div>
                    </div>

                    <div
                      className="pane-divider"
                      onPointerDown={(e) => {
                        e.currentTarget.setPointerCapture(e.pointerId);
                        preview.setSidebarDragging(true);
                      }}
                      onPointerMove={preview.onSidebarDividerPointerMove}
                    />
                  </>
                ) : (
                  <ActionIcon
                    className="sidebar-reopen"
                    size={26}
                    variant="subtle"
                    color="gray"
                    title="Show sidebar"
                    aria-label="Show sidebar"
                    onClick={() => setSidebarOpen(true)}
                  >
                    <PanelLeftOpen size={16} />
                  </ActionIcon>
                ))}

              <div
                className={`panes${sidebarOpen ? "" : " sidebar-collapsed"}`}
                ref={preview.panesEl}
              >
                <div
                  className={`pane editor-pane${
                    fullscreenEditorOpen
                      ? ` fullscreen-workspace fullscreen-editor-pane${
                          fullscreenSidebarOpen ? " fullscreen-sidebars-open" : ""
                        }${currentFile.filePath ? "" : " fullscreen-no-file"}`
                      : ""
                  }`}
                  style={{ flexBasis: `${preview.split}%` }}
                >
                  {renderEditorPane(!fullscreenEditorOpen, fullscreenEditorOpen)}
                  {fullscreenEditorOpen && (
                    <>
                      <div className="fullscreen-sidebar-rail fullscreen-sidebar-rail-left">
                        <div
                          className="fullscreen-floating-sidebar"
                          role="complementary"
                          aria-label="Files sidebar"
                        >
                          <div className="fullscreen-floating-sidebar-header">
                            <Files size={16} />
                            <span>Files</span>
                          </div>
                          <div className="fullscreen-floating-sidebar-content">
                            {renderFileSidebar()}
                          </div>
                        </div>
                      </div>
                      {config && (
                        <div className="fullscreen-sidebar-rail fullscreen-sidebar-rail-right">
                          <div
                            className="fullscreen-floating-sidebar"
                            role="complementary"
                            aria-label="Media sidebar"
                          >
                            <div className="fullscreen-floating-sidebar-header">
                              <ImageIcon size={16} />
                              <span>Media</span>
                            </div>
                            <div className="fullscreen-floating-sidebar-content">
                              {renderMediaSidebar()}
                            </div>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>

                <div
                  className="pane-divider"
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    preview.setDragging(true);
                  }}
                  onPointerMove={preview.onDividerPointerMove}
                />

                {renderPreviewPane()}
              </div>
            </div>
          )}
        </div>
      </MediaDragDropProvider>
    </MantineProvider>
  );
}

export default App;

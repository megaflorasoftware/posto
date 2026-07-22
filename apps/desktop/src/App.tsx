import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, MantineProvider } from "@mantine/core";
import { Notifications, notifications } from "@mantine/notifications";
import { invoke, onFsChanged, openDirectory } from "@posto/ipc";
import { checkForAppUpdate } from "./updater";
import type { ChangedFile, FileEntry, FileGroup } from "@posto/ipc";
import { EMPTY_CONFIG, matchEntry, renamedFilename } from "@posto/core/pagescms/config";
import { parseFile } from "@posto/core/pagescms/frontmatter";
import { detectProject, type ProjectInfo } from "@posto/core/project/detect";
import { projectAdapter } from "@posto/core/project/registry";
import { invalidationScopesForPaths } from "@posto/core/project/adapter";
import {
  decideWorkspace,
  scanWorkspace,
  type ProjectCandidate,
  type ProjectInventory,
  workspaceLayoutChanged,
} from "@posto/core/project/workspace";
import {
  EditorPane,
  ImageLibraryDropImport,
  PublishModal,
  Sidebar,
  buildNewFile,
  createDataDocumentEntry,
  deleteDataDocumentEntry,
  contentHasFields,
  renameTargetForContent,
  useCurrentFile,
  useFileGroups,
  useGitSync,
  useSchemas,
  ipcProjectIO,
  useSiteUrl,
  WorkspaceChooser,
  type EditorTab,
} from "@posto/editor";
import { useDevServer } from "./hooks/useDevServer";
import { usePreview } from "./hooks/usePreview";
import { useDeployment } from "./hooks/useDeployment";
import { AppHeader } from "./components/AppHeader";
import { DeploymentDrawer } from "./components/DeploymentDrawer";
import { MediaDrawer } from "./components/MediaDrawer";
import { PreviewPane } from "./components/PreviewPane";

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
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const adapter = useMemo(() => projectAdapter(projectInfo?.type ?? "generic"), [projectInfo]);
  // Recently-opened site roots, newest first (backend caps at 10).
  const [recentRoots, setRecentRoots] = useState<string[]>([]);
  // Editor tab choice sticks for the session; Fields is the default when available.
  const [editorTab, setEditorTab] = useState<EditorTab>("fields");
  const [publishOpen, setPublishOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  // Bumped after each successful save so the SEO preview refetches the page.
  const [saveTick, setSaveTick] = useState(0);

  // Latest values for callbacks that outlive the render they were created in.
  const rootRef = useRef(root);
  rootRef.current = root;

  const schemas = useSchemas(adapter);
  const notify = useCallback((message: string, severity: "progress" | "success" | "error") => {
    notifications.show({
      message,
      color: severity === "error" ? "red" : severity === "success" ? "green" : "blue",
      autoClose: severity === "error" ? false : severity === "success" ? 5000 : 3000,
      withCloseButton: true,
    });
  }, []);
  const notifyError = useCallback((message: string) => notify(message, "error"), [notify]);

  const files = useFileGroups(notifyError);
  const devServer = useDevServer();
  const deployment = useDeployment(repoRoot);
  const siteUrl = useSiteUrl(root, adapter);

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
        setEditorTab("fields");
        return;
      }
      // On opening a markdown file, keep the last selected tab when it has
      // content to show, otherwise fall over to the tab that does: no fields
      // → Body; empty body but fields present → Fields. Raw stays sticky.
      if (/\.(md|mdx|markdown)$/i.test(path)) {
        const dir = rootRef.current;
        const cfg = schemas.configRef.current;
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
    afterPull(dir) {
      // The fs watcher also reacts to git's writes, but refresh explicitly so
      // the sidebar and open file update even when watching hiccups.
      void refreshGroups(dir);
      void currentFile.reloadFromDisk();
    },
  });

  // Every event that can change git status also refreshes the sidebar, so
  // this keeps the header's Publish button state current too.
  async function refreshGroups(dir: string) {
    void git.refreshLocalChanges(dir);
    await files.refreshGroups(dir);
    await files.refreshDataGroups(dir, schemas.configRef.current);
  }

  async function selectRoot(repository: string, dir: string) {
    let detected: ProjectInfo;
    try {
      detected = await detectProject(dir, ipcProjectIO);
    } catch (error) {
      notify(
        `Could not inspect project: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }
    const selectedAdapter = projectAdapter(detected.type);
    void currentFile.flushPendingSave();
    setRoot(dir);
    setRepoRoot(repository);
    setWorkspaceCandidates(null);
    setProjectInfo(detected);
    currentFile.closeFile();
    preview.resetRoute();
    void schemas.loadPagesConfig(dir);
    void schemas.loadDerivedConfig(dir, selectedAdapter);
    void schemas.loadPostoConfig(dir);
    await refreshGroups(dir);
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
    });
  }

  async function selectRepository(repository: string) {
    try {
      const remembered = await invoke<string | null>("get_work_dir", { root: repository });
      if (remembered) {
        await selectRoot(repository, remembered);
        return;
      }
      const inventory = await invoke<ProjectInventory[]>("scan_projects", { root: repository });
      const scan = await scanWorkspace(repository, inventory);
      const decision = decideWorkspace(repository, scan);
      if (decision.kind === "choose") {
        setRepoRoot(repository);
        setRoot(null);
        setProjectInfo(null);
        setWorkspaceCandidates(decision.candidates);
        return;
      }
      await selectRoot(repository, decision.workDir);
    } catch (error) {
      notify(
        `Could not inspect project: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  async function chooseProjectInRepository() {
    if (!repoRoot) return;
    try {
      const inventory = await invoke<ProjectInventory[]>("scan_projects", { root: repoRoot });
      const scan = await scanWorkspace(repoRoot, inventory);
      setWorkspaceCandidates([{ dir: repoRoot, ...scan.root }, ...scan.candidates]);
    } catch (error) {
      notify(
        `Could not inspect project: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  async function browseWithinRepository() {
    if (!repoRoot) return;
    const dir = await openDirectory();
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
    return {
      config: schemas.configRef.current ?? EMPTY_CONFIG,
      pagesContent: schemas.pagesConfig?.content ?? [],
      derivedContent: schemas.derivedConfig?.content ?? [],
    };
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
    // A new markdown file with a schema should land on its form, not on
    // whichever tab was last active (an empty file's Body/Raw view is blank).
    const cfg = schemas.configRef.current;
    if (/\.(md|mdx)$/i.test(path) && cfg && matchEntry(cfg, dir, path) !== null) {
      setEditorTab("fields");
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
    if (files.groupsRef.current.some((g) => g.files.some((f) => f.path === target))) return;
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
    if (repoRoot && workspaceLayoutChanged(repoRoot, dir, paths)) {
      // A manifest edit can add/remove sibling candidates, but the active
      // project remains valid until its directory disappears. Do not tear
      // down the open file, preview, or dev server merely to re-decide the
      // same workDir.
      if (!(await ipcProjectIO.pathExists(dir, "directory"))) {
        await selectRepository(repoRoot);
        return;
      }
    }
    const scopes = invalidationScopesForPaths(adapter, dir, paths, schemas.configRef.current);
    if (scopes.has("projectType")) {
      const detected = await detectProject(dir, ipcProjectIO);
      if (detected.type !== projectInfo?.type) {
        await selectRoot(repoRoot ?? dir, dir);
        return;
      }
      setProjectInfo(detected);
    }
    if (scopes.has("derivedConfig")) void schemas.loadDerivedConfig(dir, adapter);
    if (scopes.has("dataDocuments")) {
      void files.refreshDataGroups(dir, schemas.configRef.current);
    }
    if (scopes.has("mediaLibraries")) void refreshGroups(dir);
  }

  useEffect(() => {
    const unlistenFs = onFsChanged(onExternalChanges);
    // One update check per app launch, once the UI is up.
    void checkForAppUpdate();
    void refreshRecentRoots();
    void (async () => {
      const last = await invoke<{ root: string; workDir: string } | null>("get_last_selection");
      if (last && !rootRef.current) void selectRoot(last.root, last.workDir);
    })();
    return () => {
      unlistenFs();
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

  return (
    <MantineProvider defaultColorScheme="auto">
      <Notifications position="bottom-right" />
      <div className="app">
        <AppHeader
          root={root}
          repoRoot={repoRoot}
          projectInfo={projectInfo}
          recentRoots={recentRoots}
          behindUpstream={git.behindUpstream}
          pulling={git.pulling}
          hasLocalChanges={git.hasLocalChanges}
          onChooseDirectory={() => void chooseDirectory()}
          onSelectRoot={(dir) => void selectRepository(dir)}
          onSwitchProject={() => void chooseProjectInRepository()}
          deployment={deployment}
          canOpenMedia={adapter.capabilities.mediaLibraries && !!config?.mediaLibraries?.length}
          onOpenMedia={() => setMediaOpen(true)}
          onFetchChanges={() => void git.fetchChanges()}
          onOpenPublish={() => void openPublishModal()}
        />

        <DeploymentDrawer deployment={deployment} siteUrl={siteUrl} />

        {root && config && (
          <MediaDrawer
            opened={mediaOpen}
            onClose={() => setMediaOpen(false)}
            root={root}
            config={config}
            groups={files.groups}
            onImported={() => {
              notify("Image imported. Publish when you are ready.", "success");
              void refreshGroups(root);
            }}
          />
        )}

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
            <p>Select the folder that holds your site to get started.</p>
            <Button onClick={() => void chooseDirectory()}>Choose directory</Button>
          </div>
        ) : (
          <div className="body">
            <Sidebar
              root={root}
              groups={files.groups}
              config={config}
              activeKey={currentFile.activeKey}
              onOpen={(file) => openFile(file)}
              onDelete={(file) => void deleteFile(file)}
              onNewFile={(group) => void createNewFile(group)}
              onPostoSaved={() => void schemas.loadPostoConfig(root)}
            />

            <div className="panes" ref={preview.panesEl}>
              <div className="pane editor-pane" style={{ flexBasis: `${preview.split}%` }}>
                <EditorPane
                  root={root}
                  filePath={currentFile.filePath}
                  fileContent={currentFile.fileContent}
                  saveState={currentFile.saveState}
                  entry={entry}
                  dataEntry={currentFile.dataEntry}
                  entrySource={entrySource}
                  config={config}
                  configError={schemas.configError}
                  hasDerivedFallback={schemas.derivedConfig !== null}
                  componentBlocksEnabled={adapter.capabilities.componentBlocks !== null}
                  groups={files.groups}
                  editorTab={editorTab}
                  onTabChange={setEditorTab}
                  onEdit={currentFile.onEdit}
                  onFormEdit={currentFile.onFormEdit}
                  onRenameFile={renameOpenFilename}
                  onRefreshFilename={refreshFilenameTemplate}
                  onPostoSaved={() => void schemas.loadPostoConfig(root)}
                />
              </div>

              <div
                className="pane-divider"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  preview.setDragging(true);
                }}
                onPointerMove={preview.onDividerPointerMove}
              />

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
              />
            </div>
          </div>
        )}
      </div>
    </MantineProvider>
  );
}

export default App;

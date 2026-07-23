import {
  ActionIcon,
  Alert,
  Button,
  Center,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core";
import {
  CollectionOrderDialog,
  CollectionSettingsDialog,
  Dialog,
  DirectoryBrowser,
  EditorPane,
  ImageLibraryImportDialog,
  ImageLibraryList,
  PublishModal,
  buildNewFile,
  createDataDocumentEntry,
  deleteDataDocumentEntry,
  contentHasFields,
  editorTabsForFile,
  renameTargetForContent,
  orderableCollections,
  refreshImageLibraryAssets,
  resolveEditorTab,
  SchemaDiagnostics,
  sidebarDisplayGroups,
  useCurrentFile,
  useFileGroups,
  useGitSync,
  useProjectSession,
  useSchemas,
  ipcProjectIO,
  WorkspaceChooser,
  type EditorTab,
} from "@posto/editor";
import {
  EMPTY_CONFIG,
  matchEntry,
  renamedFilename,
  type MediaLibrary,
  type ContentEntry,
} from "@posto/core/pagescms/config";
import { parseFile } from "@posto/core/pagescms/frontmatter";
import type { ProjectAdapter } from "@posto/core/project/adapter";
import { type ProjectCandidate, type ProjectInventory } from "@posto/core/project/workspace";
import { invoke } from "@posto/ipc";
import type { ChangedFile, FileEntry, FileGroup, GitHubRepo } from "@posto/ipc";
import {
  CloudDownload,
  ChevronDown,
  GitCommitHorizontal,
  Pin,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  TriangleAlert,
} from "lucide-react";
import { DeploymentStatus } from "./DeploymentStatus";
import { MediaLibraryPane } from "./MediaLibraryPane";
import { RepoHeader } from "./components/RepoHeader";
import { RepoSettings } from "./components/RepoSettings";
import { usePullRefresh } from "./hooks/usePullRefresh";
import { useEffect, useMemo, useState } from "react";

const TRANSIENT_NOTICE_MS = 5_000;

type Props = {
  root: string;
  repo: GitHubRepo | null;
  onChangeRepo: () => void;
  onRedownloadRepo: () => Promise<void>;
  onRemoveRepo: () => Promise<void>;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function RepoHome({
  root: repoRoot,
  repo,
  onChangeRepo,
  onRedownloadRepo,
  onRemoveRepo,
}: Props) {
  const [root, setWorkDir] = useState(repoRoot);
  const [workspaceCandidates, setWorkspaceCandidates] = useState<ProjectCandidate[] | null>(null);
  const [workspaceChooserFromSettings, setWorkspaceChooserFromSettings] = useState(false);
  const [browsingWorkspace, setBrowsingWorkspace] = useState(false);
  const [loading, setLoading] = useState(true);
  const projectSession = useProjectSession({
    io: ipcProjectIO,
    scanProjects: (repository) => invoke<ProjectInventory[]>("scan_projects", { root: repository }),
    getRememberedWorkDir: (repository) =>
      invoke<string | null>("get_work_dir", { root: repository }),
  });
  const { projectInfo, adapter } = projectSession;
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [redownloading, setRedownloading] = useState(false);
  const [confirmingRemoveRepo, setConfirmingRemoveRepo] = useState(false);
  const [removingRepo, setRemovingRepo] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showDeployments, setShowDeployments] = useState(false);
  const [showMedia, setShowMedia] = useState(false);
  const [checkingChanges, setCheckingChanges] = useState(false);
  // `.posto` settings dialogs: one per collection, one for workspace order.
  const [settingsFor, setSettingsFor] = useState<{
    collection: ContentEntry;
    files: FileEntry[];
  } | null>(null);
  const [orderOpen, setOrderOpen] = useState(false);
  const [mediaImportOpen, setMediaImportOpen] = useState(false);
  const [componentSchemaVersion, setComponentSchemaVersion] = useState(0);
  const [importLibrary, setImportLibrary] = useState<MediaLibrary | null>(null);
  const [editorTab, setEditorTab] = useState<EditorTab>("fields");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const schemas = useSchemas(adapter, ipcProjectIO);
  const files = useFileGroups(setError, adapter.capabilities.dataDocuments);

  async function refreshRepositoryContent(dir: string, selectedAdapter?: ProjectAdapter) {
    const [, config] = await Promise.all([
      files.refreshGroups(dir),
      schemas.loadSchemas(dir, selectedAdapter),
    ]);
    await files.refreshDataGroups(
      dir,
      config,
      (selectedAdapter ?? adapter).capabilities.dataDocuments,
    );
  }

  async function redetectProject(dir: string) {
    try {
      const { adapter: selectedAdapter } = await projectSession.activate(dir);
      await refreshRepositoryContent(dir, selectedAdapter);
    } catch (detectionError) {
      setError(`Could not inspect project: ${message(detectionError)}`);
    }
  }

  async function refreshAfterPull(dir: string) {
    try {
      const scan = await projectSession.scanRepository(repoRoot);
      const candidates = [{ dir: repoRoot, ...scan.root }, ...scan.candidates];
      if (!(await ipcProjectIO.pathExists(dir, "directory"))) {
        currentFile.clearPendingSave();
        currentFile.closeFile();
        projectSession.clear();
        setShowEditor(false);
        setWorkspaceChooserFromSettings(false);
        setBrowsingWorkspace(false);
        setWorkspaceCandidates(candidates);
        return;
      }
      setWorkspaceCandidates((current) => (current ? candidates : current));
      await redetectProject(dir);
    } catch (refreshError) {
      setError(`Could not refresh workspace: ${message(refreshError)}`);
    }
  }

  const currentFile = useCurrentFile({
    onAfterSave(path, content) {
      files.updateSidebarTitle(path, content);
      if (
        schemas.configRef.current?.content.some(
          (entry) => entry.dataFile && `${root}/${entry.dataFile.path}` === path,
        )
      ) {
        void files.refreshDataGroups(root, schemas.configRef.current);
      }
      if (path === root + "/.pages.yml") void schemas.loadPagesConfig(root);
      const scopes = projectSession.invalidations(root, [path], schemas.configRef.current);
      if (scopes.has("projectType")) {
        void redetectProject(root);
      } else {
        if (scopes.has("derivedConfig")) void schemas.loadDerivedConfig(root, adapter);
        if (scopes.has("componentSchemas")) setComponentSchemaVersion((version) => version + 1);
        if (scopes.has("dataDocuments")) {
          void files.refreshDataGroups(root, schemas.configRef.current);
        }
      }
      // Frontmatter drives template-derived filenames; each (already
      // debounced) save is the moment to bring the name back in line.
      void renameForTemplate(path, content);
    },
    onOpened(path, content, file) {
      if (file?.dataEntry) {
        setEditorTab("fields");
        return;
      }
      if (!/\.(md|mdx|markdown)$/i.test(path)) return;
      const entry = schemas.configRef.current
        ? matchEntry(schemas.configRef.current, root, path)
        : null;
      const parsed = parseFile(content);
      const hasFields = contentHasFields(entry, parsed);
      const hasBody = parsed.body.trim() !== "";
      setEditorTab((last) => {
        if (last === "fields" && !hasFields) return "body";
        if (last === "body" && !hasBody && hasFields) return "fields";
        return last;
      });
    },
    onOpenError: setError,
  });
  const git = useGitSync(root, {
    onStatus: (message) => setStatus(message),
    beforeSync: () => currentFile.flushPendingSave(),
    afterPull: refreshAfterPull,
    // Publish progress lives on the Publish button; only failures surface.
    onPublishError: setStatus,
  });

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setRepairError(null);
    void (async () => {
      if (repo) {
        try {
          await invoke<string>("doctor_repo", { root: repoRoot, expectedUrl: repo.clone_url });
        } catch (checkError) {
          if (active) setRepairError(message(checkError));
          if (active) setLoading(false);
          return;
        }
      }
      try {
        const decision = await projectSession.resolveRepository(repoRoot);
        if (decision.kind === "choose") {
          if (active) {
            setWorkspaceChooserFromSettings(false);
            setWorkspaceCandidates(decision.candidates);
          }
          return;
        }
        const selectedRoot = decision.workDir;
        const { adapter: selectedAdapter } = await projectSession.activate(selectedRoot);
        if (active) {
          setWorkDir(selectedRoot);
          await refreshRepositoryContent(selectedRoot, selectedAdapter);
          void git.refreshLocalChanges(selectedRoot);
        }
      } catch (checkError) {
        if (active) setError(`Could not inspect project: ${message(checkError)}`);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
    // The selected root is the only value that should restart initial loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRoot]);

  async function chooseWorkspace(candidate: Pick<ProjectCandidate, "dir"> | null) {
    try {
      const selectedRoot = candidate?.dir ?? repoRoot;
      const { adapter: selectedAdapter } = await projectSession.activate(selectedRoot);
      setWorkDir(selectedRoot);
      setWorkspaceCandidates(null);
      setWorkspaceChooserFromSettings(false);
      setBrowsingWorkspace(false);
      void invoke("set_last_root", { root: repoRoot, workDir: selectedRoot });
      await refreshRepositoryContent(selectedRoot, selectedAdapter);
      void git.refreshLocalChanges(selectedRoot);
    } catch (chooseError) {
      setError(`Could not inspect project: ${message(chooseError)}`);
    }
  }

  async function openWorkspaceChooser() {
    try {
      const scan = await projectSession.scanRepository(repoRoot);
      setWorkspaceChooserFromSettings(true);
      setWorkspaceCandidates([{ dir: repoRoot, ...scan.root }, ...scan.candidates]);
      setShowSettings(false);
    } catch (workspaceError) {
      setError(`Could not inspect project: ${message(workspaceError)}`);
    }
  }

  async function browseWorkspace() {
    setBrowsingWorkspace(true);
  }

  async function chooseBrowsedWorkspace(dir: string) {
    try {
      await chooseWorkspace({ dir });
    } catch (workspaceError) {
      setError(`Could not inspect project: ${message(workspaceError)}`);
    }
  }

  const fileCount = useMemo(
    () => files.groups.reduce((total, group) => total + group.files.length, 0),
    [files.groups],
  );

  // Same ordering, labels, and `.posto` collection preferences as the
  // desktop sidebar.
  const displayGroups = useMemo(
    () => sidebarDisplayGroups(files.groups, schemas.config, root),
    [files.groups, schemas.config, root],
  );

  useEffect(() => {
    void files.refreshDataGroups(root, schemas.config);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, schemas.config]);

  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(null), TRANSIENT_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [status]);

  async function openPublish() {
    await currentFile.flushPendingSave();
    setPublishOpen(true);
    await git.loadChanges(root);
  }

  async function revert(file: ChangedFile) {
    if (!(await git.revertChange(root, file))) return;
    void refreshRepositoryContent(root);
  }

  async function redownloadRepository() {
    setRedownloading(true);
    try {
      await onRedownloadRepo();
    } catch (removeError) {
      setRepairError(`Could not remove the damaged repository: ${message(removeError)}`);
      setRedownloading(false);
    }
  }

  async function removeRepository() {
    setRemovingRepo(true);
    try {
      currentFile.clearPendingSave();
      currentFile.closeFile();
      await onRemoveRepo();
    } catch (removeError) {
      setStatus(`Could not remove the repository: ${message(removeError)}`);
      setRemovingRepo(false);
      setConfirmingRemoveRepo(false);
    }
  }

  async function openFile(file: string | FileEntry) {
    setConfirmingDelete(false);
    await currentFile.openFile(file);
    const path = typeof file === "string" ? file : file.path;
    if (currentFile.filePathRef.current === path) setShowEditor(true);
  }

  function schemaSources() {
    return { config: schemas.configRef.current ?? EMPTY_CONFIG };
  }

  // "New file" creates immediately — an "Untitled" entry with the
  // collection's defaults — and opens it; no dialog. The filename follows
  // the title (or whatever fields the template names) as the user edits.
  async function createNewFile(group: FileGroup) {
    if (group.dataCollection) {
      const collection = schemas.configRef.current?.content.find(
        (entry) => entry.name === group.dataCollection,
      );
      if (!collection) return;
      try {
        const id = await createDataDocumentEntry(group, collection);
        await files.refreshDataGroups(root, schemas.configRef.current);
        const created = files.groupsRef.current
          .find((candidate) => candidate.dataCollection === group.dataCollection)
          ?.files.find((file) => file.dataEntry?.id === id);
        if (created) await openFile(created);
      } catch (createError) {
        setStatus(`Create failed: ${message(createError)}`);
      }
      return;
    }
    const { path, content } = buildNewFile(root, group, schemaSources());
    try {
      await invoke("create_text_file", { path, content });
    } catch (createError) {
      setStatus(`Create failed: ${message(createError)}`);
      return;
    }
    await files.refreshGroups(root);
    await openFile(path);
  }

  // Keeps a template-derived filename in step with the frontmatter it's
  // derived from, riding the (debounced) autosave: rename on disk, retarget
  // the editor, refresh the file list.
  async function renameForTemplate(path: string, content: string) {
    if (currentFile.filePathRef.current !== path) return;
    const target = renameTargetForContent(root, path, content, schemaSources());
    if (!target) return;
    // Another entry already owns the name; keep ours until the fields change.
    if (files.groupsRef.current.some((g) => g.files.some((f) => f.path === target))) return;
    if (!(await currentFile.renameOpenFile(path, target))) return;
    void files.refreshGroups(root);
    void git.refreshLocalChanges(root);
  }

  async function renameOpenFilename(filename: string): Promise<boolean> {
    const from = currentFile.filePathRef.current;
    if (!from || filename.includes("/")) return false;
    const target = from.slice(0, from.lastIndexOf("/") + 1) + filename;
    if (target === from) return true;
    if (files.groupsRef.current.some((group) => group.files.some((file) => file.path === target))) {
      setStatus(`A file named ${filename} already exists.`);
      return false;
    }
    if (!(await currentFile.renameOpenFile(from, target))) {
      setStatus(`Could not rename the file to ${filename}.`);
      return false;
    }
    void files.refreshGroups(root);
    void git.refreshLocalChanges(root);
    return true;
  }

  function refreshFilenameTemplate(template: string) {
    const path = currentFile.filePathRef.current;
    if (!path || !entry) return;
    const parsed = parseFile(currentFile.fileContentRef.current);
    const raw = parsed.doc.toJSON() as unknown;
    if (parsed.error || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      setStatus("Fix the file's frontmatter before refreshing its filename.");
      return;
    }
    const currentName = path.slice(path.lastIndexOf("/") + 1);
    const next = renamedFilename(template, entry, raw as Record<string, unknown>, currentName);
    if (next) void renameOpenFilename(next);
  }

  // The armed "Delete?" confirm disarms on its own after a moment, the touch
  // equivalent of desktop's cancel-on-mouse-leave.
  useEffect(() => {
    if (!confirmingDelete) return;
    const timer = setTimeout(() => setConfirmingDelete(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmingDelete]);

  useEffect(() => {
    if (!confirmingRemoveRepo) return;
    const timer = setTimeout(() => setConfirmingRemoveRepo(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmingRemoveRepo]);

  async function deleteOpenFile() {
    const path = currentFile.filePathRef.current;
    if (!path) return;
    setConfirmingDelete(false);
    // A pending autosave would recreate the file right after the delete.
    currentFile.clearPendingSave();
    try {
      const selected = files.groupsRef.current
        .flatMap((group) => group.files)
        .find((file) => (file.key ?? file.path) === currentFile.activeKey);
      if (selected?.dataEntry) await deleteDataDocumentEntry(selected);
      else await invoke("delete_file", { path });
    } catch (deleteError) {
      // The repo home screen is the only surface that shows status messages.
      setStatus(`Delete failed: ${message(deleteError)}`);
      setShowEditor(false);
      return;
    }
    currentFile.closeFile();
    setShowEditor(false);
    if (path === root + "/.pages.yml") void schemas.loadPagesConfig(root);
    void files.refreshGroups(root);
    void files.refreshDataGroups(root, schemas.configRef.current);
    void git.refreshLocalChanges(root);
  }

  const pullRefresh = usePullRefresh(async () => {
    await Promise.all([
      git.checkUpstream(),
      git.refreshLocalChanges(root),
      refreshRepositoryContent(root),
    ]);
  });

  function closeEditor() {
    const pendingSave = currentFile.flushPendingSave();
    setShowEditor(false);
    setConfirmingDelete(false);
    currentFile.closeFile();
    setCheckingChanges(true);
    void pendingSave
      .then(() => git.refreshLocalChanges(root))
      .finally(() => setCheckingChanges(false));
  }

  function closeSecondaryView() {
    // Deployments and Media are pages reached from Settings, so back returns there.
    if (showDeployments) setShowDeployments(false);
    else if (showMedia) setShowMedia(false);
    else if (showEditor) closeEditor();
    else {
      setConfirmingRemoveRepo(false);
      setShowSettings(false);
    }
  }

  function leaveRepository() {
    void currentFile.flushPendingSave();
    currentFile.closeFile();
    setShowDeployments(false);
    setShowMedia(false);
    setShowSettings(false);
    onChangeRepo();
  }

  function navigateBack() {
    if (workspaceCandidates && browsingWorkspace) {
      setBrowsingWorkspace(false);
    } else if (workspaceCandidates && workspaceChooserFromSettings) {
      setWorkspaceCandidates(null);
      setWorkspaceChooserFromSettings(false);
      setShowSettings(true);
    } else if (showEditor || showSettings || showDeployments || showMedia) {
      closeSecondaryView();
    } else {
      leaveRepository();
    }
  }

  function closeMediaImport() {
    setMediaImportOpen(false);
    setImportLibrary(null);
  }

  function importIntoLibrary(library: MediaLibrary) {
    setImportLibrary(library);
    setMediaImportOpen(true);
  }

  function imageImported() {
    setStatus("Image imported. Publish when you are ready.");
    void git.refreshLocalChanges(root);
    if (importLibrary) void refreshImageLibraryAssets(root, importLibrary);
  }

  const config = schemas.config;
  const entry = useMemo(() => {
    if (!currentFile.filePath || !config) return null;
    if (currentFile.dataEntry) {
      return (
        config.content.find((candidate) => candidate.name === currentFile.dataEntry?.collection) ??
        null
      );
    }
    return matchEntry(config, root, currentFile.filePath);
  }, [config, currentFile.filePath, currentFile.dataEntry, root]);
  // Matched by name+path because the `.posto` overlay clones entries it
  // touches; `.pages.yml` wins ties, matching the config's precedence order.
  const entrySource =
    entry === null
      ? null
      : schemas.pagesConfig?.content.some((e) => e.name === entry.name && e.path === entry.path)
        ? "pages"
        : schemas.derivedConfig?.content.some((e) => e.name === entry.name && e.path === entry.path)
          ? (projectInfo?.type ?? null)
          : null;
  const openFileName =
    currentFile.dataEntry?.id ?? currentFile.filePath?.split("/").pop() ?? "File";
  const mobileEditorTabs = editorTabsForFile({
    filePath: currentFile.filePath,
    fileContent: currentFile.fileContent,
    entry,
    dataEntry: currentFile.dataEntry,
  });
  const mobileActiveTab = resolveEditorTab(mobileEditorTabs, editorTab);

  return (
    <>
      <RepoHeader
        repoName={repo?.name ?? "Repository"}
        repoRoot={repoRoot}
        root={root}
        projectInfo={projectInfo}
        showEditor={showEditor}
        showSettings={showSettings}
        showDeployments={showDeployments}
        showMedia={showMedia}
        choosingWorkspace={workspaceCandidates !== null}
        editorTabs={mobileEditorTabs}
        activeTab={mobileActiveTab}
        confirmingDelete={confirmingDelete}
        openFileName={openFileName}
        onBack={navigateBack}
        onTabChange={setEditorTab}
        onOpenSettings={() => setShowSettings(true)}
        onRequestDelete={() => setConfirmingDelete(true)}
        onConfirmDelete={() => void deleteOpenFile()}
      />
      {workspaceCandidates ? (
        <main className="mobile-settings-screen">
          {browsingWorkspace ? (
            <DirectoryBrowser
              repoRoot={repoRoot}
              onChoose={(dir) => void chooseBrowsedWorkspace(dir)}
              onCancel={() => setBrowsingWorkspace(false)}
            />
          ) : (
            <WorkspaceChooser
              repoRoot={repoRoot}
              candidates={workspaceCandidates}
              onChoose={(candidate) => void chooseWorkspace(candidate)}
              onBrowse={() => void browseWorkspace()}
            />
          )}
        </main>
      ) : showEditor ? (
        <main className="mobile-editor-screen">
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
            hideTabList
            filenamePlacement="fields"
          />
        </main>
      ) : showDeployments ? (
        repo ? (
          <DeploymentStatus owner={repo.owner} name={repo.name} root={root} adapter={adapter} />
        ) : (
          <main className="mobile-settings-screen">
            <Text c="dimmed" size="sm">
              No repository is connected.
            </Text>
          </main>
        )
      ) : showMedia ? (
        <main className="mobile-media-screen">
          <MediaLibraryPane
            root={root}
            libraries={config?.mediaLibraries ?? []}
            onImport={importIntoLibrary}
          />
        </main>
      ) : showSettings ? (
        <RepoSettings
          hasRepository={repo !== null}
          mediaEnabled={adapter.capabilities.mediaLibraries}
          mediaLibraryCount={config?.mediaLibraries?.length ?? 0}
          projectDirectory={root === repoRoot ? "Repository root" : root.slice(repoRoot.length + 1)}
          removing={removingRepo}
          confirmingRemove={confirmingRemoveRepo}
          onOpenDeployments={() => setShowDeployments(true)}
          onOpenMedia={() => setShowMedia(true)}
          onOpenProjects={() => void openWorkspaceChooser()}
          onRemove={() =>
            confirmingRemoveRepo ? void removeRepository() : setConfirmingRemoveRepo(true)
          }
        />
      ) : (
        <main className="repo-home">
          <Stack gap="sm" className="repo-home-notices">
            {repairError && (
              <Alert
                color="red"
                variant="light"
                icon={<TriangleAlert size={19} />}
                title="This repository needs to be downloaded again"
              >
                <Stack gap="sm">
                  <Text size="sm">{repairError}</Text>
                  <Text size="sm">
                    Remove the damaged local copy and download a clean copy from GitHub. Files that
                    have not been published may be lost.
                  </Text>
                  <Button
                    color="red"
                    variant="light"
                    loading={redownloading}
                    onClick={() => void redownloadRepository()}
                  >
                    Remove and redownload
                  </Button>
                </Stack>
              </Alert>
            )}
            {git.behindUpstream && (
              <Alert
                color="blue"
                variant="light"
                icon={<CloudDownload size={18} />}
                title="Updates are available"
                className="sync-alert"
              >
                <Group justify="space-between" align="center" wrap="nowrap">
                  <Text size="sm">Pull the latest changes before editing.</Text>
                  <Button
                    size="sm"
                    variant="light"
                    loading={git.pulling}
                    onClick={() => void git.fetchChanges()}
                  >
                    Pull
                  </Button>
                </Group>
              </Alert>
            )}

            {status && (
              <Alert
                key={status}
                className="mobile-transient-notice"
                color={status.includes("failed") ? "red" : "blue"}
                variant="light"
              >
                {status}
              </Alert>
            )}

            {projectInfo?.diagnostic && (
              <Alert color="yellow" variant="light" title="Project adapter fallback">
                {projectInfo.diagnostic}
              </Alert>
            )}

            {error && (
              <Alert color="red" variant="light" title="Files could not be loaded">
                <Stack gap="sm">
                  <Text size="sm">{error}</Text>
                  <Button
                    variant="light"
                    color="red"
                    size="sm"
                    leftSection={<RefreshCw size={14} />}
                    onClick={() => void files.refreshGroups(root)}
                  >
                    Try again
                  </Button>
                </Stack>
              </Alert>
            )}
          </Stack>

          <div
            className="repo-files"
            onTouchStart={pullRefresh.onTouchStart}
            onTouchMove={pullRefresh.onTouchMove}
            onTouchEnd={pullRefresh.onTouchEnd}
            onTouchCancel={pullRefresh.onTouchEnd}
          >
            <div
              className="mobile-refresh-indicator"
              // The indicator tracks the finger directly while dragging; the height
              // transition only smooths the settle after release.
              style={{
                height: pullRefresh.refreshing ? 44 : pullRefresh.pullDistance,
                transition: pullRefresh.pullDistance > 0 ? "none" : undefined,
              }}
              aria-hidden={!pullRefresh.refreshing && pullRefresh.pullDistance === 0}
            >
              {pullRefresh.refreshing ? (
                <Loader size="sm" />
              ) : (
                <RefreshCw size={18} style={{ opacity: pullRefresh.progress }} />
              )}
            </div>
            <ScrollArea
              className="repo-files-scroll"
              type="auto"
              viewportRef={pullRefresh.viewportRef}
            >
              {loading ? null : fileCount === 0 && !error ? (
                <Center className="repo-files-state">
                  <Stack align="center" gap="xs">
                    <Text fw={600}>No editable files found</Text>
                    <Text size="sm" c="dimmed" ta="center">
                      Markdown, MDX, text, and stylesheet files will appear here.
                    </Text>
                  </Stack>
                </Center>
              ) : (
                <div className="mobile-document-list">
                  {displayGroups.map(({ group, collection, exact }) =>
                    group.label ? (
                      <details key={`${group.kind ?? ""}:${group.path}`} open>
                        <summary>
                          <span className="mobile-group-label" title={group.label}>
                            {group.label}
                          </span>
                          {group.kind !== "styles" && (
                            <ActionIcon
                              className="mobile-group-action"
                              variant="subtle"
                              color="gray"
                              aria-label={`New file in ${group.label}`}
                              title="New file"
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                void createNewFile(group);
                              }}
                            >
                              <Plus size={16} />
                            </ActionIcon>
                          )}
                          {collection && exact && (
                            <ActionIcon
                              className="mobile-group-action"
                              variant="subtle"
                              color="gray"
                              aria-label={`Settings for ${group.label}`}
                              title="Collection settings"
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setSettingsFor({ collection, files: group.files });
                              }}
                            >
                              <SlidersHorizontal size={16} />
                            </ActionIcon>
                          )}
                          <ChevronDown size={14} className="mobile-group-chevron" />
                        </summary>
                        {group.files.map((file) => (
                          <button
                            className="mobile-file-item"
                            key={file.key ?? file.path}
                            title={file.name}
                            onClick={() => void openFile(file)}
                          >
                            {file.title ?? file.name}
                            {collection?.pinned?.includes(file.name) && (
                              <Pin size={13} className="mobile-file-pin" aria-label="Pinned" />
                            )}
                          </button>
                        ))}
                      </details>
                    ) : (
                      <div key={`${group.kind ?? ""}:${group.path}`}>
                        {group.files.map((file) => (
                          <button
                            className="mobile-file-item"
                            key={file.key ?? file.path}
                            title={file.name}
                            onClick={() => void openFile(file)}
                          >
                            {file.title ?? file.name}
                          </button>
                        ))}
                      </div>
                    ),
                  )}
                  {orderableCollections(schemas.config).length > 1 && (
                    <button
                      type="button"
                      className="mobile-collections-settings"
                      onClick={() => setOrderOpen(true)}
                    >
                      <SlidersHorizontal size={16} />
                      Collection settings
                    </button>
                  )}
                  <SchemaDiagnostics config={schemas.config} />
                </div>
              )}
            </ScrollArea>
          </div>

          <div className="repo-home-actions">
            <Button
              fullWidth
              size="sm"
              leftSection={<GitCommitHorizontal size={19} />}
              disabled={!git.hasLocalChanges}
              loading={checkingChanges || git.publishing}
              onClick={() => void openPublish()}
            >
              {git.publishing
                ? "Publishing…"
                : checkingChanges
                  ? "Checking changes…"
                  : git.hasLocalChanges
                    ? "Publish…"
                    : "Up to date"}
            </Button>
          </div>

          {settingsFor && (
            <CollectionSettingsDialog
              root={root}
              collection={settingsFor.collection}
              files={settingsFor.files}
              onClose={() => setSettingsFor(null)}
              onSaved={() => void schemas.loadPostoConfig(root)}
            />
          )}

          {orderOpen && (
            <CollectionOrderDialog
              root={root}
              collections={orderableCollections(schemas.config)}
              onClose={() => setOrderOpen(false)}
              onSaved={() => void schemas.loadPostoConfig(root)}
            />
          )}

          <PublishModal
            opened={publishOpen}
            changes={git.changes}
            error={git.changesError}
            scopeLabel={root !== repoRoot ? root.slice(repoRoot.length + 1) : undefined}
            onClose={() => setPublishOpen(false)}
            onRevert={(file) => void revert(file)}
            onPublish={(message) => {
              setPublishOpen(false);
              void git.publish(message);
            }}
          />
        </main>
      )}

      {adapter.capabilities.mediaLibraries && mediaImportOpen && !importLibrary && (
        <Dialog opened onClose={closeMediaImport} title="Choose image library" size="sm">
          <ImageLibraryList libraries={config?.mediaLibraries ?? []} onChoose={setImportLibrary} />
        </Dialog>
      )}

      {adapter.capabilities.mediaLibraries && importLibrary && config && (
        <ImageLibraryImportDialog
          root={root}
          library={importLibrary}
          config={config}
          groups={files.groups}
          autoChooseSource
          onClose={closeMediaImport}
          onImported={imageImported}
        />
      )}
    </>
  );
}

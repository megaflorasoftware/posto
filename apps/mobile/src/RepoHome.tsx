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
  EditorPane,
  PublishModal,
  buildNewFile,
  createDataDocumentEntry,
  deleteDataDocumentEntry,
  contentHasFields,
  renameTargetForContent,
  orderableCollections,
  sidebarDisplayGroups,
  useCurrentFile,
  useFileGroups,
  useGitSync,
  useSchemas,
  type EditorTab,
} from "@posto/editor";
import { EMPTY_CONFIG, matchEntry, type ContentEntry } from "@posto/core/pagescms/config";
import { parseFile } from "@posto/core/pagescms/frontmatter";
import { invoke } from "@posto/ipc";
import type { ChangedFile, FileEntry, FileGroup, GitHubRepo } from "@posto/ipc";
import {
  CloudDownload,
  ChevronDown,
  ChevronLeft,
  GitCommitHorizontal,
  Menu,
  Pin,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type TouchEvent as ReactTouchEvent,
} from "react";

// Drag distance (after damping) that arms the pull-to-refresh gesture.
const PULL_REFRESH_THRESHOLD = 60;

type Props = {
  root: string;
  repo: GitHubRepo | null;
  onChangeRepo: () => void;
  onRedownloadRepo: () => Promise<void>;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function RepoHome({ root, repo, onChangeRepo, onRedownloadRepo }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [redownloading, setRedownloading] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [checkingChanges, setCheckingChanges] = useState(false);
  // `.posto` settings dialogs: one per collection, one for workspace order.
  const [settingsFor, setSettingsFor] = useState<{
    collection: ContentEntry;
    files: FileEntry[];
  } | null>(null);
  const [orderOpen, setOrderOpen] = useState(false);
  const [editorTab, setEditorTab] = useState<EditorTab>("fields");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const filesViewportRef = useRef<HTMLDivElement>(null);
  const pullStartY = useRef<number | null>(null);
  const schemas = useSchemas();
  const files = useFileGroups(setError);
  const currentFile = useCurrentFile({
    onAfterSave(path, content) {
      files.updateSidebarTitle(path, content);
      if (schemas.configRef.current?.content.some((entry) => entry.dataFile && `${root}/${entry.dataFile.path}` === path)) {
        void files.refreshDataGroups(root, schemas.configRef.current);
      }
      if (path === root + "/.pages.yml") void schemas.loadPagesConfig(root);
      if (path === root + "/src/content.config.ts" || path === root + "/src/content/config.ts") {
        void schemas.loadAstroConfig(root);
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
    onStatus: setStatus,
    beforeSync: () => currentFile.flushPendingSave(),
    afterPull: (dir) => {
      void files.refreshGroups(dir);
      void files.refreshDataGroups(dir, schemas.configRef.current);
    },
    // Publish progress lives on the Publish button; only failures surface.
    onPublishError: setStatus,
  });

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setRepairError(null);
    const repositoryCheck = repo
      ? invoke<string>("doctor_repo", { root, expectedUrl: repo.clone_url }).catch((checkError) => {
          if (active) setRepairError(message(checkError));
        })
      : Promise.resolve();
    const repositoryContent = Promise.all([
      files.refreshGroups(root),
      schemas.loadPagesConfig(root),
      schemas.loadAstroConfig(root),
      schemas.loadPostoConfig(root),
    ]);
    void Promise.all([repositoryContent, repositoryCheck]).finally(() => {
      if (active) setLoading(false);
    });
    void git.refreshLocalChanges(root);
    return () => {
      active = false;
    };
    // The selected root is the only value that should restart initial loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

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

  async function openPublish() {
    await currentFile.flushPendingSave();
    setPublishOpen(true);
    await git.loadChanges(root);
  }

  async function revert(file: ChangedFile) {
    if (!(await git.revertChange(root, file))) return;
    void files.refreshGroups(root);
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

  async function openFile(file: string | FileEntry) {
    setConfirmingDelete(false);
    await currentFile.openFile(file);
    const path = typeof file === "string" ? file : file.path;
    if (currentFile.filePathRef.current === path) setShowEditor(true);
  }

  function schemaSources() {
    return {
      config: schemas.configRef.current ?? EMPTY_CONFIG,
      pagesContent: schemas.pagesConfig?.content ?? [],
      astroContent: schemas.astroConfig?.content ?? [],
    };
  }

  // "New file" creates immediately — an "Untitled" entry with the
  // collection's defaults — and opens it; no dialog. The filename follows
  // the title (or whatever fields the template names) as the user edits.
  async function createNewFile(group: FileGroup) {
    if (group.dataCollection) {
      const collection = schemas.configRef.current?.content.find((entry) => entry.name === group.dataCollection);
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

  // The armed "Delete?" confirm disarms on its own after a moment, the touch
  // equivalent of desktop's cancel-on-mouse-leave.
  useEffect(() => {
    if (!confirmingDelete) return;
    const timer = setTimeout(() => setConfirmingDelete(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmingDelete]);

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

  async function refreshFromPull() {
    setRefreshing(true);
    try {
      await Promise.all([
        git.checkUpstream(),
        git.refreshLocalChanges(root),
        files.refreshGroups(root),
      ]);
    } finally {
      setRefreshing(false);
    }
  }

  function onFilesTouchStart(event: ReactTouchEvent) {
    if (refreshing || (filesViewportRef.current?.scrollTop ?? 1) > 0) return;
    pullStartY.current = event.touches[0].clientY;
  }

  function onFilesTouchMove(event: ReactTouchEvent) {
    if (pullStartY.current === null) return;
    if ((filesViewportRef.current?.scrollTop ?? 0) > 0) {
      pullStartY.current = null;
      setPullDistance(0);
      return;
    }
    const delta = event.touches[0].clientY - pullStartY.current;
    // Damped so the indicator trails the finger like the native gesture.
    setPullDistance(delta > 0 ? Math.min(delta / 2, 90) : 0);
  }

  function onFilesTouchEnd() {
    if (pullStartY.current === null) return;
    pullStartY.current = null;
    if (pullDistance >= PULL_REFRESH_THRESHOLD) void refreshFromPull();
    setPullDistance(0);
  }

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
    if (showEditor) closeEditor();
    else setShowSettings(false);
  }

  function leaveRepository() {
    currentFile.flushPendingSave();
    currentFile.closeFile();
    setShowSettings(false);
    onChangeRepo();
  }

  const config = schemas.config;
  const entry = useMemo(() => {
    if (!currentFile.filePath || !config) return null;
    if (currentFile.dataEntry) {
      return config.content.find((candidate) => candidate.name === currentFile.dataEntry?.collection) ?? null;
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
        : schemas.astroConfig?.content.some((e) => e.name === entry.name && e.path === entry.path)
          ? "astro"
          : "pages";
  const openFileName = currentFile.dataEntry?.id ?? currentFile.filePath?.split("/").pop() ?? "File";

  return (
    <>
      <header className="mobile-header">
        <Group gap={0} wrap="nowrap" className="mobile-header-title">
          <ActionIcon
            variant="subtle"
            aria-label="Back"
            onClick={showEditor || showSettings ? closeSecondaryView : leaveRepository}
          >
            <ChevronLeft size={22} />
          </ActionIcon>
          <Text fw={600} size="sm" truncate>
            {showEditor ? openFileName : showSettings ? "Settings" : repo?.name ?? "Repository"}
          </Text>
        </Group>
        {!showEditor && !showSettings && (
          <ActionIcon
            variant="subtle"
            aria-label="Site settings"
            title="Site settings"
            onClick={() => setShowSettings(true)}
          >
            <Menu size={20} />
          </ActionIcon>
        )}
        {showEditor &&
          (confirmingDelete ? (
            <Button
              color="red"
              variant="light"
              size="compact-md"
              className="mobile-delete-confirm"
              onClick={() => void deleteOpenFile()}
            >
              Delete?
            </Button>
          ) : (
            <ActionIcon
              variant="subtle"
              color="red"
              aria-label={`Delete ${openFileName}`}
              title={`Delete ${openFileName}`}
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2 size={19} />
            </ActionIcon>
          ))}
      </header>
      {showEditor ? (
        <main className="mobile-editor-screen">
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
            hasAstroFallback={schemas.astroConfig !== null}
            groups={files.groups}
            editorTab={editorTab}
            onTabChange={setEditorTab}
            onEdit={currentFile.onEdit}
            onFormEdit={currentFile.onFormEdit}
          />
        </main>
      ) : showSettings ? (
        <main className="mobile-settings-screen">
          <Stack gap="xs">
            {[
              ["Site details", "Name, URL, and metadata"],
              ["Publishing", "Branch and deployment settings"],
              ["Media", "Image sources and upload settings"],
              ["Domains", "Custom domains and redirects"],
            ].map(([label, description]) => (
              <div className="mobile-settings-row" key={label}>
                <div>
                  <Text fw={600} size="sm">{label}</Text>
                  <Text c="dimmed" size="xs">{description}</Text>
                </div>
                <Text c="dimmed" size="xs">Coming soon</Text>
              </div>
            ))}
          </Stack>
        </main>
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
          <Alert color={status.includes("failed") ? "red" : "blue"} variant="light">
            {status}
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
        onTouchStart={onFilesTouchStart}
        onTouchMove={onFilesTouchMove}
        onTouchEnd={onFilesTouchEnd}
        onTouchCancel={onFilesTouchEnd}
      >
      <div
        className="mobile-refresh-indicator"
        // The indicator tracks the finger directly while dragging; the height
        // transition only smooths the settle after release.
        style={{
          height: refreshing ? 44 : pullDistance,
          transition: pullDistance > 0 ? "none" : undefined,
        }}
        aria-hidden={!refreshing && pullDistance === 0}
      >
        {refreshing ? (
          <Loader size="sm" />
        ) : (
          <RefreshCw
            size={18}
            style={{ opacity: Math.min(pullDistance / PULL_REFRESH_THRESHOLD, 1) }}
          />
        )}
      </div>
      <ScrollArea className="repo-files-scroll" type="auto" viewportRef={filesViewportRef}>
        {loading ? (
          null
        ) : fileCount === 0 && !error ? (
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
            {displayGroups.map(({ group, collection, exact }) => (
              group.label ? (
                <details key={`${group.kind ?? ""}:${group.path}`} open>
                  <summary>
                    <span className="mobile-group-label" title={group.label}>{group.label}</span>
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
              )
            ))}
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
          config={schemas.config ?? { media: [], content: [] }}
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
        onClose={() => setPublishOpen(false)}
        onRevert={(file) => void revert(file)}
        onPublish={(message) => {
          setPublishOpen(false);
          void git.publish(message);
        }}
      />
      </main>
      )}
    </>
  );
}

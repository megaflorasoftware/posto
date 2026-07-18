import { useEffect, useMemo, useRef, useState } from "react";
import { Button, MantineProvider } from "@mantine/core";
import { invoke, onFsChanged, openDirectory } from "@posto/ipc";
import { checkForAppUpdate } from "./updater";
import type { ChangedFile, FileEntry, FileGroup } from "@posto/ipc";
import { EMPTY_CONFIG, matchEntry } from "@posto/core/pagescms/config";
import { parseFile } from "@posto/core/pagescms/frontmatter";
import {
  EditorPane,
  NewFileModal,
  PublishModal,
  Sidebar,
  contentHasFields,
  useCurrentFile,
  useFileGroups,
  useGitSync,
  useSchemas,
  type EditorTab,
} from "@posto/editor";
import { useDevServer } from "./hooks/useDevServer";
import { usePreview } from "./hooks/usePreview";
import { AppHeader } from "./components/AppHeader";
import { PreviewPane } from "./components/PreviewPane";

import "@mantine/core/styles.css";
import "@mantine/tiptap/styles.css";
import "@mantine/spotlight/styles.css";
import "@posto/editor/styles.css";
import "./App.css";

function App() {
  const [root, setRoot] = useState<string | null>(null);
  // Recently-opened site roots, newest first (backend caps at 10).
  const [recentRoots, setRecentRoots] = useState<string[]>([]);
  // Editor tab choice sticks for the session; Fields is the default when available.
  const [editorTab, setEditorTab] = useState<EditorTab>("fields");
  // Status-bar message in the header (publish/pull results, errors).
  const [status, setStatus] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  // Directory the "new file" dialog is creating into, when open.
  const [newFileGroup, setNewFileGroup] = useState<FileGroup | null>(null);
  // Bumped after each successful save so the SEO preview refetches the page.
  const [saveTick, setSaveTick] = useState(0);

  // Latest values for callbacks that outlive the render they were created in.
  const rootRef = useRef(root);
  rootRef.current = root;

  const schemas = useSchemas();
  const files = useFileGroups((message) => setStatus(message));
  const devServer = useDevServer();

  const currentFile = useCurrentFile({
    onAfterSave(path, content) {
      files.updateSidebarTitle(path, content);
      setSaveTick((t) => t + 1);
      // Editing the schema itself must re-parse it, or forms keep the old one.
      const dir = rootRef.current;
      if (dir && path === dir + "/.pages.yml") void schemas.loadPagesConfig(dir);
      if (dir && (path === dir + "/src/content.config.ts" || path === dir + "/src/content/config.ts")) {
        void schemas.loadAstroConfig(dir);
      }
    },
    onOpened(path, content) {
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
      setStatus(message);
    },
  });

  // openFile normally moves the preview along; reverse routing (the preview
  // moved first) must not, or the two would fight. The flag rides a ref
  // because onOpened runs from the hook, outside this call stack's scope.
  const navigatePreviewRef = useRef(true);
  function openFile(path: string, navigatePreview = true) {
    navigatePreviewRef.current = navigatePreview;
    void currentFile.openFile(path);
  }

  const preview = usePreview({
    server: devServer.server,
    serverRef: devServer.serverRef,
    groupsRef: files.groupsRef,
    filePathRef: currentFile.filePathRef,
    onRouteOpened: (path) => openFile(path, false),
  });

  const git = useGitSync(root, {
    onStatus: setStatus,
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
  }

  async function selectRoot(dir: string) {
    currentFile.flushPendingSave();
    setRoot(dir);
    currentFile.closeFile();
    setStatus(null);
    preview.resetRoute();
    void schemas.loadPagesConfig(dir);
    void schemas.loadAstroConfig(dir);
    void schemas.loadPostoConfig(dir);
    await refreshGroups(dir);
    void devServer.startServer(dir);
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

  async function chooseDirectory() {
    const dir = await openDirectory();
    if (typeof dir === "string") void selectRoot(dir);
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
    openFile(path);
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
    if (
      paths.some(
        (p) =>
          p.startsWith(dir + "/.astro/collections") ||
          p === dir + "/src/content.config.ts" ||
          p === dir + "/src/content/config.ts",
      )
    ) {
      void schemas.loadAstroConfig(dir);
    }
    if (paths.includes(currentFile.filePathRef.current ?? "")) {
      void currentFile.reloadFromDisk();
    }
  }

  useEffect(() => {
    const unlistenFs = onFsChanged(onExternalChanges);
    // One update check per app launch, once the UI is up.
    void checkForAppUpdate();
    void refreshRecentRoots();
    void (async () => {
      const last = await invoke<string | null>("get_last_root");
      if (last && !rootRef.current) void selectRoot(last);
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
    currentFile.flushPendingSave();
    setPublishOpen(true);
    void git.loadChanges(dir);
  }

  async function deleteFile(file: FileEntry) {
    const dir = rootRef.current;
    if (!dir) return;
    const isOpen = currentFile.filePathRef.current === file.path;
    if (isOpen) {
      // A pending autosave would recreate the file right after the delete.
      currentFile.clearPendingSave();
    }
    try {
      await invoke("delete_file", { path: file.path });
    } catch (e) {
      setStatus(String(e));
      return;
    }
    if (isOpen) currentFile.closeFile();
    if (file.path === dir + "/.pages.yml") void schemas.loadPagesConfig(dir);
    void refreshGroups(dir);
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

  // Content entry describing the open file's fields, if any.
  const entry = useMemo(() => {
    if (!root || !currentFile.filePath || !config) return null;
    return matchEntry(config, root, currentFile.filePath);
  }, [root, currentFile.filePath, config]);

  // Which source the matched entry came from, for the header badge. Matched
  // by name+path because the `.posto` overlay clones entries it touches;
  // `.pages.yml` wins ties, matching the config's precedence order.
  const entrySource =
    entry === null
      ? null
      : schemas.pagesConfig?.content.some((e) => e.name === entry.name && e.path === entry.path)
        ? "pages"
        : schemas.astroConfig?.content.some((e) => e.name === entry.name && e.path === entry.path)
          ? "astro"
          : "pages";

  return (
    <MantineProvider defaultColorScheme="auto">
      <div className="app">
        <AppHeader
          root={root}
          recentRoots={recentRoots}
          status={status}
          behindUpstream={git.behindUpstream}
          pulling={git.pulling}
          hasLocalChanges={git.hasLocalChanges}
          onChooseDirectory={() => void chooseDirectory()}
          onSelectRoot={(dir) => void selectRoot(dir)}
          onFetchChanges={() => void git.fetchChanges()}
          onOpenPublish={() => void openPublishModal()}
        />

        <PublishModal
          opened={publishOpen}
          changes={git.changes}
          error={git.changesError}
          onClose={() => setPublishOpen(false)}
          onRevert={(file) => void revertChange(file)}
          onPublish={(message) => {
            setPublishOpen(false);
            void git.publish(message);
          }}
        />

        {root && newFileGroup && (
          <NewFileModal
            root={root}
            group={newFileGroup}
            config={config ?? EMPTY_CONFIG}
            astroContent={schemas.astroConfig?.content ?? []}
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
            <Sidebar
              root={root}
              groups={files.groups}
              config={config}
              activePath={currentFile.filePath}
              onOpen={(path) => openFile(path)}
              onDelete={(file) => void deleteFile(file)}
              onNewFile={setNewFileGroup}
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
              />
            </div>
          </div>
        )}
      </div>
    </MantineProvider>
  );
}

export default App;

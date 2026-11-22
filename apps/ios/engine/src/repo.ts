/**
 * One open repository: the selected project directory, its schemas and
 * files, the open document, git state and branches. A headless port of the
 * mobile RepoHome's orchestration; Swift renders `view()` and calls methods.
 */
import type { FileEntry, FileGroup } from "@posto/ipc";
import {
  EMPTY_CONFIG,
  matchCollectionForDir,
  type ContentEntry,
  type PagesConfig,
} from "@posto/core/pagescms/config";
import {
  invalidationScopesForPaths,
  routesEqual,
  type FileRoute,
  type ProjectAdapter,
  type ProjectIO,
} from "@posto/core/project/adapter";
import { detectProject, type ProjectInfo } from "@posto/core/project/detect";
import { projectAdapter } from "@posto/core/project/registry";
import {
  decideWorkspace,
  scanWorkspace,
  workspaceProjects,
  type ProjectCandidate,
  type ProjectInventory,
} from "@posto/core/project/workspace";
import { genericAdapter } from "@posto/core/project/generic";
import {
  createDataDocumentEntry,
  deleteDataDocumentEntry,
} from "../../../../packages/editor/src/dataEntries";
import {
  canCreateFileInGroup,
  sidebarFileLabel,
} from "../../../../packages/editor/src/fileTreeModel";
import { buildNewFile, renameTargetForContent } from "../../../../packages/editor/src/newFile";
import {
  orderableCollections,
  sidebarDisplayTree,
  type DisplayGroupNode,
} from "../../../../packages/editor/src/sidebarTree";
import { DocumentSession, type DocumentHost, type DocumentView } from "./document";
import { FileGroups } from "./files";
import { Branches, GitSync } from "./git";
import { errorMessage, invoke, notify, onBackendEvent } from "./host";
import { Schemas } from "./schemas";

const TRANSIENT_NOTICE_MS = 5_000;

export const ipcProjectIO: ProjectIO = {
  pathExists: (path, kind) => invoke<boolean>("path_exists", { path, kind }),
  readTextFileOptional: (path) => invoke<string | null>("read_text_file_optional", { path }),
  listDirFilesOptional: (dir, extensions) =>
    invoke<{ name: string; path: string }[] | null>("list_dir_files_optional", { dir, extensions }),
};

export interface RepoIdentity {
  owner: string;
  name: string;
  cloneUrl: string;
  defaultBranch: string;
}

export interface TreeFileView {
  key: string;
  path: string;
  name: string;
  label: string;
  pinned: boolean;
}

export interface TreeNodeView {
  id: string;
  label: string;
  path: string;
  kind: string | null;
  canCreate: boolean;
  /** Developer mode: the collection whose settings this folder opens. */
  collection: { name: string; label: string } | null;
  defaultOpen: boolean;
  files: TreeFileView[];
  children: TreeNodeView[];
}

export interface WorkspaceCandidateView {
  dir: string;
  label: string;
  type: string;
}

export interface RepoView {
  repoRoot: string;
  root: string;
  repo: RepoIdentity | null;
  loading: boolean;
  projectDirectory: string;
  canSwitchProject: boolean;
  workspaceCandidates: WorkspaceCandidateView[] | null;
  /** The chooser can go back to the open project (it was opened over one,
   * rather than because none is selected yet). */
  canCancelWorkspaceChooser: boolean;
  projectDiagnostic: string | null;
  projectType: string;
  error: string | null;
  repairError: string | null;
  status: { id: number; message: string; severity: "progress" | "success" | "error" } | null;
  looseFiles: TreeFileView[];
  tree: TreeNodeView[];
  fileCount: number;
  mediaLibraryCount: number;
  hasMediaLibraries: boolean;
  showSourceMedia: boolean;
  orderableCollections: Array<{ name: string; label: string }>;
  diagnostics: Array<{ feature: string; collection: string | null; code: string; message: string }>;
  git: {
    behindUpstream: boolean;
    pulling: boolean;
    publishing: boolean;
    canPublish: boolean;
    checkingChanges: boolean;
  };
  branch: string | null;
  branchSwitching: boolean;
  branchConflict: { branch: string; files: string[] } | null;
  documentKey: string | null;
}

function relativeLabel(repoRoot: string, dir: string): string {
  return dir === repoRoot ? "Repository root" : dir.slice(repoRoot.length + 1);
}

function fileView(file: FileEntry, collection: ContentEntry | null): TreeFileView {
  return {
    key: file.key ?? file.path,
    path: file.path,
    name: file.name,
    label: sidebarFileLabel(file, collection),
    pinned: collection?.pinned?.includes(file.name) ?? false,
  };
}

export class RepoSession {
  root: string;
  projectInfo: ProjectInfo | null = null;
  adapter: ProjectAdapter = genericAdapter;
  private projectCount = 0;
  readonly schemas: Schemas;
  readonly files = new FileGroups();
  readonly git: GitSync;
  readonly branches: Branches;
  document: DocumentSession | null = null;
  loading = true;
  error: string | null = null;
  repairError: string | null = null;
  workspaceCandidates: ProjectCandidate[] | null = null;
  private status: RepoView["status"] = null;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private nextStatusId = 1;
  checkingChanges = false;
  private generation = 0;
  developerMode = false;
  closed = false;
  /** Local folders: changed paths waiting out the watcher's burst. */
  private externalPaths = new Set<string>();
  private externalTimer: ReturnType<typeof setTimeout> | undefined;
  private stopWatching: (() => void) | undefined;

  constructor(
    readonly repoRoot: string,
    readonly repo: RepoIdentity | null,
    /** A folder the user opened (the macOS app), not a managed clone. */
    readonly local = false,
  ) {
    this.root = repoRoot;
    this.schemas = new Schemas(ipcProjectIO, this.adapter);
    this.git = new GitSync({
      root: () => this.root,
      config: () => this.schemas.config,
      groups: () => this.files.groups,
      beforeSync: () => this.document?.flushPendingSave() ?? Promise.resolve(),
      afterPull: (dir) => this.refreshAfterPull(dir),
      refreshMediaLibraries: () => notify("media-changed", {}),
      status: (message, severity) => this.setStatus(message, severity),
      changed: () => this.changed(),
    });
    this.branches = new Branches(
      () => this.root,
      async (dir) => {
        await this.refreshAfterPull(dir);
        void this.git.refreshLocalChanges(dir);
        void this.git.checkUpstream();
      },
      () => this.changed(),
    );
  }

  changed(): void {
    if (!this.closed) notify("repo", this.view());
  }

  documentChanged(): void {
    if (!this.closed && this.document) notify("document", this.document.view());
  }

  /** Progress and success notices clear themselves; errors stay until
   * dismissed or replaced, as the Tauri app's error toasts do. */
  setStatus(message: string, severity: "progress" | "success" | "error" = "success"): void {
    clearTimeout(this.statusTimer);
    this.status = { id: this.nextStatusId++, message, severity };
    if (severity !== "error") {
      this.statusTimer = setTimeout(() => {
        this.status = null;
        this.changed();
      }, TRANSIENT_NOTICE_MS);
    }
    this.changed();
  }

  /** Clears the notice with this id (a newer one stays). */
  dismissStatus(id: number): void {
    if (this.status?.id !== id) return;
    clearTimeout(this.statusTimer);
    this.status = null;
    this.changed();
  }

  get config(): PagesConfig {
    return this.schemas.config;
  }

  // --- Opening -----------------------------------------------------------

  private async scanRepository() {
    const inventory = await invoke<ProjectInventory[]>("scan_projects", { root: this.repoRoot });
    const scan = await scanWorkspace(this.repoRoot, inventory);
    this.projectCount = workspaceProjects(this.repoRoot, scan).length;
    return scan;
  }

  /** Checks the clone, then picks (or asks for) the project directory. */
  async open(): Promise<void> {
    const generation = ++this.generation;
    this.loading = true;
    this.changed();
    try {
      if (this.repo && !this.local) {
        try {
          await invoke<string>("doctor_repo", {
            root: this.repoRoot,
            expectedUrl: this.repo.cloneUrl,
          });
        } catch (error) {
          this.repairError = errorMessage(error);
          return;
        }
      }
      const scan = await this.scanRepository();
      if (generation !== this.generation) return;
      const decision = decideWorkspace(this.repoRoot, scan);
      if (decision.kind === "choose") {
        this.workspaceCandidates = decision.candidates;
        return;
      }
      const remembered = await invoke<string | null>("get_work_dir", { root: this.repoRoot });
      await this.activate(remembered ?? decision.workDir, generation);
    } catch (error) {
      this.error = `Could not inspect project: ${errorMessage(error)}`;
    } finally {
      if (generation === this.generation) this.loading = false;
      this.changed();
    }
  }

  private async activate(dir: string, generation: number): Promise<void> {
    const info = await detectProject(dir, ipcProjectIO);
    if (generation !== this.generation) return;
    this.projectInfo = info;
    this.adapter = projectAdapter(info.type);
    this.root = dir;
    await this.refreshContent(dir);
    if (generation !== this.generation) return;
    void this.git.refreshLocalChanges(dir);
    void this.branches.loadCurrent();
    this.git.start();
    if (this.local) this.watch(dir);
  }

  /** Local folders: watches the project as the desktop app does (its
   * adapter's ignore rules, and the workspace files above a subproject), so
   * edits from other apps, git and the dev server reach the sidebar and the
   * open document. */
  private watch(dir: string): void {
    this.stopWatching ??= onBackendEvent<string[]>("fs-changed", (paths) => {
      if (this.closed) return;
      for (const path of paths) this.externalPaths.add(path);
      clearTimeout(this.externalTimer);
      this.externalTimer = setTimeout(() => {
        const changed = [...this.externalPaths];
        this.externalPaths.clear();
        void this.externalChanges(changed);
      }, 300);
    });
    const extraPaths =
      dir === this.repoRoot
        ? []
        : ["package.json", "pnpm-workspace.yaml", "lerna.json", "turbo.json"].map(
            (path) => `${this.repoRoot}/${path}`,
          );
    void invoke("watch_root", {
      root: dir,
      ignoreRules: this.adapter.watchIgnores(),
      extraPaths,
      workspaceRoot: this.repoRoot,
    }).catch(() => {});
  }

  /** Files changed outside the app: content and local changes (no fetch),
   * and the open document when it's among them (unless an edit is pending,
   * which then saves over it, as on desktop). Our own saves echo here too
   * and resolve to no-ops. */
  async externalChanges(paths: string[]): Promise<void> {
    if (this.closed || !this.projectInfo) return;
    await this.refreshContent(this.root);
    void this.git.refreshLocalChanges(this.root);
    const document = this.document;
    if (document && paths.includes(document.path) && (await document.reloadFromDisk())) {
      this.documentChanged();
    }
    if (paths.some((path) => !/\.(md|mdx|markdoc|mdoc|ya?ml|json|toml)$/i.test(path))) {
      notify("media-changed", {});
    }
  }

  async chooseWorkspace(dir: string | null): Promise<void> {
    const generation = ++this.generation;
    const selected = dir ?? this.repoRoot;
    await this.closeDocument();
    try {
      await this.activate(selected, generation);
      this.workspaceCandidates = null;
      void invoke("set_last_root", { root: this.repoRoot, workDir: selected });
    } catch (error) {
      this.error = `Could not inspect project: ${errorMessage(error)}`;
    }
    this.changed();
  }

  async showWorkspaceChooser(): Promise<void> {
    const scan = await this.scanRepository();
    this.workspaceCandidates = workspaceProjects(this.repoRoot, scan);
    this.changed();
  }

  /** The repository's projects, for a chooser that leaves the open project
   * in place until one is picked (iOS opens it from Settings). */
  async listWorkspaceCandidates(): Promise<WorkspaceCandidateView[]> {
    const scan = await this.scanRepository();
    return workspaceProjects(this.repoRoot, scan).map((candidate) => this.candidateView(candidate));
  }

  private candidateView(candidate: ProjectCandidate): WorkspaceCandidateView {
    return {
      dir: candidate.dir,
      label: relativeLabel(this.repoRoot, candidate.dir),
      type: candidate.type,
    };
  }

  cancelWorkspaceChooser(): void {
    if (!this.projectInfo) return;
    this.workspaceCandidates = null;
    this.changed();
  }

  // --- Content -----------------------------------------------------------

  async refreshContent(dir: string = this.root): Promise<void> {
    this.error = null;
    const [groups, config] = await Promise.allSettled([
      this.files.refresh(dir),
      this.schemas.load(dir, this.adapter),
    ]);
    if (groups.status === "rejected") this.error = errorMessage(groups.reason);
    await this.files.refreshData(
      dir,
      config.status === "fulfilled" ? config.value : this.config,
      this.adapter.capabilities.dataDocuments,
    );
    this.changed();
  }

  /** Pull-to-refresh: upstream, local changes and content together. */
  async refresh(): Promise<void> {
    await Promise.all([
      this.git.checkUpstream(),
      this.git.refreshLocalChanges(this.root),
      this.refreshContent(this.root),
    ]);
  }

  private async refreshAfterPull(dir: string): Promise<void> {
    const generation = this.generation;
    try {
      const scan = await this.scanRepository();
      if (generation !== this.generation) return;
      const candidates = workspaceProjects(this.repoRoot, scan);
      if (!(await ipcProjectIO.pathExists(dir, "directory"))) {
        this.document?.clearPendingSave();
        this.document = null;
        this.projectInfo = null;
        this.workspaceCandidates = candidates;
        this.changed();
        return;
      }
      if (this.workspaceCandidates) this.workspaceCandidates = candidates;
      const info = await detectProject(dir, ipcProjectIO);
      if (generation !== this.generation) return;
      this.projectInfo = info;
      this.adapter = projectAdapter(info.type);
      await this.refreshContent(dir);
      if (await this.document?.reloadFromDisk()) this.documentChanged();
      notify("site-url-changed", {});
    } catch (error) {
      this.error = `Could not refresh workspace: ${errorMessage(error)}`;
      this.changed();
    }
  }

  /** After each save: sidebar titles, invalidated schemas, template renames. */
  private afterSave(path: string, content: string): void {
    this.files.updateTitle(path, content);
    const config = this.config;
    if (
      config.content.some(
        (entry) => entry.dataFile && `${this.root}/${entry.dataFile.path}` === path,
      )
    ) {
      void this.files
        .refreshData(this.root, config, this.adapter.capabilities.dataDocuments)
        .then(() => this.changed());
    }
    if (path === `${this.root}/.pages.yml`)
      void this.schemas.reloadPages(this.root).then(() => this.changed());
    const scopes = invalidationScopesForPaths(this.adapter, this.root, [path], config);
    if (scopes.has("siteUrl")) notify("site-url-changed", {});
    if (scopes.has("projectType")) {
      void this.refreshAfterPull(this.root);
    } else {
      if (scopes.has("derivedConfig"))
        void this.schemas.reloadDerived(this.root).then(() => this.changed());
      if (scopes.has("componentSchemas")) notify("component-schemas-changed", {});
      if (scopes.has("dataDocuments")) {
        void this.files
          .refreshData(this.root, this.config, this.adapter.capabilities.dataDocuments)
          .then(() => this.changed());
      }
    }
    void this.renameForTemplate(path, content);
    // No filesystem watcher here (the desktop app has one): keep Publish's
    // state current as saves land, since iPad shows it beside the editor.
    void this.git.refreshLocalChanges(this.root);
    this.changed();
  }

  // --- Documents ---------------------------------------------------------

  private documentHost(): DocumentHost {
    return {
      root: this.root,
      config: () => this.config,
      configError: () => this.schemas.configError,
      hasDerivedFallback: () => this.schemas.derivedConfig !== null,
      adapter: () => this.adapter,
      groups: () => this.files.groups,
      developerMode: () => this.developerMode,
      afterSave: (path, content) => this.afterSave(path, content),
      changed: () => this.documentChanged(),
    };
  }

  /** The site route the open document renders at: the desktop preview's
   * forward guess, `certain` for file-based pages. */
  previewRoute(): FileRoute | null {
    const document = this.document;
    return document ? this.adapter.routeForFile(this.root, document.path, document.content) : null;
  }

  /** The sidebar key of the file a route in the preview belongs to (the
   * desktop preview's reverse sync). */
  fileForRoute(route: string): string | null {
    for (const group of this.files.groups) {
      for (const file of group.files) {
        const fileRoute = this.adapter.routeForFile(this.root, file.path, "")?.route;
        if (fileRoute && routesEqual(fileRoute, route)) return file.key ?? file.path;
      }
    }
    return null;
  }

  /** Opens and closes run one at a time (calls aren't serialized), so the
   * document the engine edits is the one the last open asked for. */
  private documentQueue: Promise<unknown> = Promise.resolve();

  inDocumentQueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.documentQueue.then(work);
    this.documentQueue = next.catch(() => {});
    return next;
  }

  openFile(key: string): Promise<DocumentView> {
    return this.inDocumentQueue(() => this.openFileNow(key));
  }

  private async openFileNow(key: string): Promise<DocumentView> {
    if (this.document?.key === key) return this.document.view();
    await this.closeDocument();
    const found = this.files.find(key);
    const file: FileEntry = found?.file ?? { name: key.slice(key.lastIndexOf("/") + 1), path: key };
    this.document = await DocumentSession.open(this.documentHost(), file);
    this.changed();
    return this.document.view();
  }

  async closeDocument(): Promise<void> {
    const document = this.document;
    if (!document) return;
    this.document = null;
    this.checkingChanges = true;
    this.changed();
    try {
      await document.close();
      await this.git.refreshLocalChanges(this.root);
    } finally {
      this.checkingChanges = false;
      this.changed();
    }
  }

  requireDocument(): DocumentSession {
    if (!this.document) throw new Error("No file is open");
    return this.document;
  }

  private schemaSources() {
    return { config: this.config ?? EMPTY_CONFIG };
  }

  /** "New file" creates an Untitled entry with the collection's defaults and
   * opens it; the filename follows its template as the user edits. */
  async createFile(groupPath: string, dataCollection: string | null): Promise<DocumentView> {
    const group = this.files.groups.find((candidate) =>
      dataCollection ? candidate.dataCollection === dataCollection : candidate.path === groupPath,
    ) ?? { label: groupPath.slice(this.root.length + 1), path: groupPath, files: [] };
    if (dataCollection) {
      const collection = this.config.content.find((entry) => entry.name === dataCollection);
      if (!collection) throw new Error(`Unknown collection ${dataCollection}`);
      const id = await createDataDocumentEntry(group, collection);
      await this.files.refreshData(this.root, this.config, this.adapter.capabilities.dataDocuments);
      const created = this.files.groups
        .find((candidate) => candidate.dataCollection === dataCollection)
        ?.files.find((file) => file.dataEntry?.id === id);
      if (!created) throw new Error("The new entry could not be found");
      return this.openFile(created.key ?? created.path);
    }
    const { path, content } = buildNewFile(this.root, group as FileGroup, this.schemaSources());
    await invoke("create_text_file", { path, content });
    await this.files.refresh(this.root);
    void this.git.refreshLocalChanges(this.root);
    return this.openFile(path);
  }

  deleteOpenFile(): Promise<void> {
    return this.deleteFile(this.requireDocument().key);
  }

  /** Deletes a sidebar file or data-document entry: closes it when it's the
   * open one, and reloads the open entry when it shares the deleted entry's
   * data file (as the desktop app's deleteFile does). */
  deleteFile(key: string): Promise<void> {
    return this.inDocumentQueue(() => this.deleteFileNow(key));
  }

  private async deleteFileNow(key: string): Promise<void> {
    const document = this.document;
    const isOpen = document?.key === key;
    const file: FileEntry | undefined =
      this.files.find(key)?.file ??
      (document && isOpen
        ? { name: document.name, path: document.path, key, dataEntry: document.dataEntry }
        : undefined);
    if (!file) throw new Error("That file no longer exists.");
    const sharesOpenDocument = !isOpen && Boolean(file.dataEntry) && document?.path === file.path;
    if (document && isOpen) {
      // A pending autosave would write the file back; one already running
      // finishes first.
      document.clearPendingSave();
      await document.flushPendingSave();
    } else if (document && sharesOpenDocument) {
      // The open entry saves its whole data file, deleted entry included.
      await document.flushPendingSave();
    }
    if (file.dataEntry) await deleteDataDocumentEntry(file);
    else await invoke("delete_file", { path: file.path });
    if (document && isOpen) {
      document.closed = true;
      if (this.document === document) this.document = null;
    } else if (document && sharesOpenDocument && (await document.reloadFromDisk())) {
      this.documentChanged();
    }
    if (file.path === `${this.root}/.pages.yml`) await this.schemas.reloadPages(this.root);
    await this.files.refresh(this.root).catch(() => {});
    await this.files.refreshData(this.root, this.config, this.adapter.capabilities.dataDocuments);
    void this.git.refreshLocalChanges(this.root);
    this.changed();
  }

  /** Keeps a template-derived filename in step with its frontmatter. */
  private async renameForTemplate(path: string, content: string): Promise<void> {
    const document = this.document;
    if (!document || document.path !== path) return;
    const target = renameTargetForContent(this.root, path, content, this.schemaSources());
    if (!target) return;
    if (this.files.hasPath(target)) {
      this.setStatus(
        `A file named ${target.slice(target.lastIndexOf("/") + 1)} already exists.`,
        "error",
      );
      return;
    }
    if (!(await document.renameOpenFile(path, target))) return;
    await this.files.refresh(this.root).catch(() => {});
    void this.git.refreshLocalChanges(this.root);
    this.changed();
    this.documentChanged();
  }

  /** Renames the open file; resolves to an error message or null. */
  async renameOpenFile(filename: string): Promise<string | null> {
    const document = this.requireDocument();
    const from = document.path;
    if (filename.includes("/")) return "A filename can't contain “/”.";
    const target = from.slice(0, from.lastIndexOf("/") + 1) + filename;
    if (target === from) return null;
    if (this.files.hasPath(target)) return `A file named ${filename} already exists.`;
    if (!(await document.renameOpenFile(from, target)))
      return `Could not rename the file to ${filename}.`;
    await this.files.refresh(this.root).catch(() => {});
    void this.git.refreshLocalChanges(this.root);
    this.changed();
    this.documentChanged();
    return null;
  }

  async refreshFilename(): Promise<string | null> {
    const document = this.requireDocument();
    const template = document.view().filename.refreshTemplate;
    if (!template) return null;
    const next = document.templatedFilename(template);
    return next ? this.renameOpenFile(next) : null;
  }

  // --- View --------------------------------------------------------------

  private treeView(nodes: DisplayGroupNode[]): TreeNodeView[] {
    return nodes
      .filter((node) => node.group.label)
      .map((node) => ({
        id: `directory:${node.group.kind ?? ""}:${node.group.path}${node.group.dataCollection ? `#${node.group.dataCollection}` : ""}`,
        label: node.group.label,
        path: node.group.path,
        kind: node.group.kind ?? null,
        canCreate: canCreateFileInGroup(this.root, node.group),
        collection:
          this.developerMode && node.collection && node.exact
            ? { name: node.collection.name, label: node.collection.label ?? node.collection.name }
            : null,
        defaultOpen: node.defaultOpen,
        files: node.group.files.map((file) => fileView(file, node.collection)),
        children: this.treeView(node.children),
      }));
  }

  view(): RepoView {
    const config = this.config;
    const nodes = sidebarDisplayTree(this.files.groups, config, this.root);
    const loose = nodes
      .filter((node) => !node.group.label)
      .flatMap((node) => node.group.files.map((file) => fileView(file, node.collection)));
    return {
      repoRoot: this.repoRoot,
      root: this.root,
      repo: this.repo,
      loading: this.loading,
      projectDirectory: relativeLabel(this.repoRoot, this.root),
      canSwitchProject: this.projectCount > 1,
      workspaceCandidates:
        this.workspaceCandidates?.map((candidate) => this.candidateView(candidate)) ?? null,
      canCancelWorkspaceChooser: this.workspaceCandidates !== null && this.projectInfo !== null,
      projectDiagnostic: this.projectInfo?.diagnostic ?? null,
      projectType: this.projectInfo?.type ?? "generic",
      error: this.error,
      repairError: this.repairError,
      status: this.status,
      looseFiles: loose,
      tree: this.treeView(nodes),
      fileCount: this.files.fileCount,
      mediaLibraryCount: config.mediaLibraries?.length ?? 0,
      hasMediaLibraries: this.adapter.capabilities.mediaLibraries,
      showSourceMedia: config.media.some((media) => media.relative && media.input === "src"),
      orderableCollections: orderableCollections(config).map((entry) => ({
        name: entry.name,
        label: entry.label ?? entry.name,
      })),
      diagnostics: (config.diagnostics ?? []).map((diagnostic) => ({
        feature: diagnostic.feature,
        collection: diagnostic.collection ?? null,
        code: diagnostic.code,
        message: diagnostic.message,
      })),
      git: {
        behindUpstream: this.git.behindUpstream,
        pulling: this.git.pulling,
        publishing: this.git.publishing,
        canPublish: this.git.canPublish,
        checkingChanges: this.checkingChanges,
      },
      branch: this.branches.branch,
      branchSwitching: this.branches.switching,
      branchConflict: this.branches.conflict,
      documentKey: this.document?.key ?? null,
    };
  }

  collectionForGroup(path: string): ContentEntry | null {
    return matchCollectionForDir(this.config, this.root, path);
  }

  async close(): Promise<void> {
    this.git.stop();
    clearTimeout(this.statusTimer);
    clearTimeout(this.externalTimer);
    this.stopWatching?.();
    await this.document?.close();
    this.document = null;
    this.closed = true;
  }
}

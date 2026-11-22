/**
 * The open file. A headless port of useCurrentFile (load, debounced
 * autosave, a save/rename queue, save state) joined with EditorPane's tab and
 * filename rules and BodyEditor's managed MDX imports. Swift renders
 * `view()` and sends edits; every edit runs through the shared form model.
 */
import type { FileEntry, FileGroup } from "@posto/ipc";
import { isRemoteMediaUrl, type CdnSource } from "@posto/core/media/sources";
import {
  collectionExtension,
  expandMediaEntry,
  matchEntry,
  mediaInputPath,
  mediaOutputPath,
  renamedFilename,
  resolveMedia,
  resolveMediaForValue,
  relativeMediaPath,
  resolveRelativeMediaPath,
  type ContentEntry,
  type Field,
  type FieldTemplateSchema,
  type MediaEntry,
  type MediaLibrary,
  type PagesConfig,
} from "@posto/core/pagescms/config";
import { parseFile, type ValuePath } from "@posto/core/pagescms/frontmatter";
import { importInfo, resolveImportPath, splitLeadingImports } from "@posto/core/mdx/mdx";
import type { ProjectAdapter } from "@posto/core/project/adapter";
import { AUTOSAVE_DELAY_MS } from "../../../../packages/editor/src/autosave";
import { applyCollectionPrefs } from "../../../../packages/editor/src/collectionPrefs";
import {
  markdownMediaHtml,
  markdownMediaKind,
  markdownMediaOutputPath,
  type MarkdownMediaKind,
} from "../../../../packages/editor/src/markdownMedia";
import {
  editorTabsForFile,
  resolveEditorTab,
  type EditorTab,
} from "../../../../packages/editor/src/editorTabs";
import {
  fieldAt,
  referenceOptions,
  type SelectValue,
} from "../../../../packages/editor/src/formModel";
import { DataEntryForm, FrontmatterForm, type FormEmit, type FormStore } from "./forms";
import { scanBodyEmbeds, type BodyEmbed } from "./bodyEmbeds";
import { dateControls, type DateControl } from "./dates";
import { fieldViews, type FieldView } from "./fieldViews";
import { errorMessage, invoke } from "./host";

export type SaveState = "saved" | "saving" | "error" | "invalid";

/** What image fields resolve against, as FieldEditor's context: the
 * collection entry (its media and templates), the document relative image
 * values are relative to, and the values templated media folders expand
 * from. The open document is one; a referenced entry being created is
 * another (its collection, at a provisional path). */
export interface FieldScope {
  readonly entry: ContentEntry | null;
  readonly documentPath: string | undefined;
  templateValues(): Record<string, unknown>;
}

/** What the document needs from the repository it belongs to. */
export interface DocumentHost {
  readonly root: string;
  config(): PagesConfig;
  configError(): string | null;
  hasDerivedFallback(): boolean;
  adapter(): ProjectAdapter;
  groups(): FileGroup[];
  developerMode(): boolean;
  /** Runs after every successful write (sidebar titles, invalidations,
   * template-driven renames). */
  afterSave(path: string, content: string): void;
  /** The document's visible state changed. */
  changed(): void;
}

/** An import statement managed outside the editable body. */
interface ManagedImport {
  statement: string;
  names: string[];
  pinned: boolean;
}

function bodyComponentNames(markdown: string): Set<string> {
  return new Set([...markdown.matchAll(/<([A-Z][\w.]*)[\s/>]/g)].map((m) => m[1].split(".")[0]));
}

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "ico"];
const MARKDOWN = /\.(md|mdx|markdown)$/i;

export interface DocumentView {
  /** This open document, across renames (the key follows the path). */
  session: number;
  key: string;
  path: string;
  name: string;
  isData: boolean;
  tabs: EditorTab[];
  tab: EditorTab;
  saveState: SaveState;
  /** Bumped whenever the form is rebuilt from content (external changes). */
  revision: number;
  collectionLabel: string | null;
  filename: {
    value: string;
    readOnly: boolean;
    /** Set when a manual filename template can regenerate the name. */
    refreshTemplate: string | null;
    /** The filename template itself, for developer mode. */
    template: string | null;
    controlled: boolean;
  };
  configError: string | null;
  form: {
    parseError: string | null;
    missing: boolean;
    fields: FieldView[];
    values: Record<string, unknown>;
    errors: Record<string, string>;
    dates: Record<string, DateControl>;
  } | null;
  body: { kind: "markdown" | "mdx" | "plain"; text: string; componentBlocks: boolean } | null;
  /** The whole file, only while the raw tab is showing. */
  raw: string | null;
}

let nextSession = 1;

export class DocumentSession {
  /** Identifies this open document even when a filename template renames
   * it (which changes `key`), so edits typed meanwhile still land. */
  readonly session = nextSession++;
  path: string;
  key: string;
  readonly dataEntry: FileEntry["dataEntry"];
  content: string;
  saveState: SaveState = "saved";
  tab: EditorTab;
  private form: FormStore | null = null;
  private imports: ManagedImport[] = [];
  private revision = 0;
  private bodyText = "";
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private activeSave: Promise<void> | null = null;
  closed = false;

  constructor(
    private readonly host: DocumentHost,
    file: FileEntry,
    content: string,
  ) {
    this.path = file.path;
    this.key = file.key ?? file.path;
    this.dataEntry = file.dataEntry;
    this.content = content;
    this.tab = this.dataEntry || MARKDOWN.test(this.path) ? "content" : "raw";
    this.rebuild();
  }

  static async open(host: DocumentHost, file: FileEntry): Promise<DocumentSession> {
    const content = await invoke<string>("read_text_file", { path: file.path });
    return new DocumentSession(host, file, content);
  }

  get entry(): ContentEntry | null {
    const config = this.host.config();
    if (this.dataEntry) {
      return (
        config.content.find((candidate) => candidate.name === this.dataEntry?.collection) ?? null
      );
    }
    return matchEntry(config, this.host.root, this.path);
  }

  get name(): string {
    return this.dataEntry?.id ?? this.path.slice(this.path.lastIndexOf("/") + 1);
  }

  private get isMdx(): boolean {
    return /\.mdx$/i.test(this.path);
  }

  tabs(): EditorTab[] {
    return editorTabsForFile({
      filePath: this.path,
      fileContent: this.content,
      entry: this.entry,
      dataEntry: this.dataEntry,
      developerMode: this.host.developerMode(),
    });
  }

  /** Rebuilds the form from `content`, as FormEditor does for external changes. */
  rebuild(): void {
    this.revision += 1;
    const entry = this.entry;
    if (this.dataEntry && entry) {
      this.form = new DataEntryForm(this.content, entry, this.dataEntry, () => this.entry);
      this.bodyText = "";
      return;
    }
    if (!entry && !MARKDOWN.test(this.path)) {
      this.form = null;
      return;
    }
    const form = new FrontmatterForm(this.content, entry, () => this.entry);
    this.form = form;
    const body = form.body();
    if (this.isMdx) {
      const split = splitLeadingImports(body);
      const used = bodyComponentNames(split.body);
      this.imports = split.imports.map((statement) => {
        const { names } = importInfo(statement);
        return { statement, names, pinned: !names.some((name) => used.has(name)) };
      });
      this.bodyText = split.body;
    } else {
      this.imports = [];
      this.bodyText = body;
    }
  }

  /** Managed imports (filtered to what the body still uses) above the body. */
  private composeBody(body: string): string {
    if (!this.isMdx) return body;
    const used = bodyComponentNames(body);
    this.imports = this.imports.filter((imp) => {
      if (imp.names.length === 0) return true;
      if (imp.names.some((name) => used.has(name))) {
        imp.pinned = false;
        return true;
      }
      return imp.pinned;
    });
    if (this.imports.length === 0) return body;
    return this.imports.map((imp) => imp.statement).join("\n") + "\n\n" + body;
  }

  /** Adds an import for a component inserted into the body. */
  addImport(statement: string): void {
    if (this.imports.some((imp) => imp.statement === statement)) return;
    const { names } = importInfo(statement);
    if (names.some((name) => this.imports.some((imp) => imp.names.includes(name)))) return;
    this.imports.push({ statement, names, pinned: false });
  }

  hasImportFor(name: string): boolean {
    return this.imports.some((imp) => imp.names.includes(name));
  }

  /** The file a component in the body is imported from, when resolvable. */
  importPathFor(name: string): string | null {
    for (const imp of this.imports) {
      if (!imp.names.includes(name)) continue;
      const { spec } = importInfo(imp.statement);
      return spec ? resolveImportPath(this.path, spec) : null;
    }
    return null;
  }

  view(): DocumentView {
    const entry = this.entry;
    const tabs = this.tabs();
    const tab = resolveEditorTab(tabs, this.tab);
    const schema: FieldTemplateSchema | undefined =
      entry?.fieldSchemas?.filename ??
      (entry?.filename ? { template: entry.filename, editBehavior: "controlled" } : undefined);
    const readOnly = Boolean(this.dataEntry) || schema?.editBehavior === "controlled";
    const configError = this.host.configError();
    const form = this.form;
    const markdown = MARKDOWN.test(this.path);
    return {
      session: this.session,
      key: this.key,
      path: this.path,
      name: this.name,
      isData: Boolean(this.dataEntry),
      tabs,
      tab,
      saveState: this.saveState,
      revision: this.revision,
      collectionLabel: entry ? (entry.label ?? entry.name) : null,
      filename: {
        value: this.name,
        readOnly,
        refreshTemplate:
          !readOnly && schema?.template && schema.editBehavior === "manual"
            ? schema.template
            : null,
        template: schema?.template ?? null,
        controlled: schema?.editBehavior === "controlled",
      },
      configError: configError
        ? `Schema configuration issue${this.host.hasDerivedFallback() ? " (using the last available schemas)" : ""} — ${configError}`
        : null,
      form:
        form && tab === "content"
          ? {
              parseError: form.parseError,
              missing: form instanceof DataEntryForm && form.missing,
              fields: fieldViews(
                form.fields,
                entry,
                this.host.config(),
                this.host.adapter().capabilities.entryIds !== null,
              ),
              values: form.values(),
              errors: Object.fromEntries(form.errors()),
              dates: dateControls(form.fields, form.values()),
            }
          : null,
      body:
        form instanceof FrontmatterForm && tab === "content" && !form.parseError
          ? {
              kind: markdown ? (this.isMdx ? "mdx" : "markdown") : "plain",
              text: this.bodyText,
              componentBlocks:
                this.isMdx && this.host.adapter().capabilities.componentBlocks !== null,
            }
          : null,
      raw: tab === "raw" ? this.content : null,
    };
  }

  setTab(tab: EditorTab): void {
    if (tab === this.tab) return;
    this.tab = tab;
    if (tab === "content") this.rebuild();
  }

  // --- Edits -------------------------------------------------------------

  private onEdit(content: string) {
    this.content = content;
    this.saveState = "saving";
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.saveNow(this.path, content);
    }, AUTOSAVE_DELAY_MS);
  }

  /** Form edits only reach disk while the form validates; invalid states
   * keep the in-memory content (so Raw shows it) but never save. */
  private onFormEdit({ content, valid }: FormEmit) {
    if (valid) this.onEdit(content);
    else {
      this.content = content;
      this.clearPendingSave();
      this.saveState = "invalid";
    }
  }

  private requireForm(): FormStore {
    if (!this.form) throw new Error("This file has no form");
    return this.form;
  }

  edit(path: ValuePath, value: unknown): void {
    this.onFormEdit(this.requireForm().edit(path, value === null ? undefined : value));
  }

  listAppend(path: ValuePath, value: unknown): void {
    this.onFormEdit(this.requireForm().listAppend(path, value));
  }

  listRemove(path: ValuePath, index: number): void {
    this.onFormEdit(this.requireForm().listRemove(path, index));
  }

  listMove(path: ValuePath, from: number, to: number): void {
    this.onFormEdit(this.requireForm().listMove(path, from, to));
  }

  setBody(text: string): void {
    const form = this.form;
    if (!(form instanceof FrontmatterForm)) throw new Error("This file has no body");
    this.bodyText = text;
    this.onFormEdit(form.setBody(this.composeBody(text)));
  }

  setRaw(content: string): void {
    this.onEdit(content);
  }

  // --- Saving ------------------------------------------------------------

  private saveNow(path: string, content: string): Promise<void> {
    this.saveState = "saving";
    this.host.changed();
    const previous = this.activeSave ?? Promise.resolve();
    // The target resolves when the write runs: a rename queued ahead of it
    // may have moved the file, and writing the old path would resurrect it.
    let target = path;
    const task = previous
      .then(() => {
        if (!this.closed) target = this.path;
        return invoke("write_text_file", { path: target, content });
      })
      .then(() => {
        if (this.saveTimer === undefined && this.saveState !== "invalid") this.saveState = "saved";
        this.host.afterSave(target, content);
      })
      .catch((error) => {
        console.error("Save failed", errorMessage(error));
        this.saveState = "error";
      })
      .finally(() => {
        if (this.activeSave === task) this.activeSave = null;
        this.host.changed();
      });
    this.activeSave = task;
    return task;
  }

  /** Moves the open file on disk, queued behind any in-flight save. Resolves
   * false when the rename failed; the file then keeps its name. */
  renameOpenFile(from: string, to: string): Promise<boolean> {
    const previous = this.activeSave ?? Promise.resolve();
    let renamed = false;
    const task = previous
      .then(() => invoke("rename_file", { from, to }))
      .then(() => {
        renamed = true;
        if (this.path === from) {
          this.path = to;
          this.key = to;
        }
      })
      .catch(() => {})
      .finally(() => {
        if (this.activeSave === task) this.activeSave = null;
      });
    this.activeSave = task;
    return task.then(() => renamed);
  }

  async flushPendingSave(): Promise<void> {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      await this.saveNow(this.path, this.content);
      return;
    }
    if (this.activeSave) await this.activeSave;
  }

  clearPendingSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
  }

  get hasPendingSave(): boolean {
    return this.saveTimer !== undefined;
  }

  /** Re-reads the file after an external change, unless an edit is pending. */
  async reloadFromDisk(): Promise<boolean> {
    if (this.saveTimer !== undefined) return false;
    const path = this.path;
    let content: string;
    try {
      content = await invoke<string>("read_text_file", { path });
    } catch {
      return false;
    }
    if (this.path !== path || this.saveTimer !== undefined || content === this.content)
      return false;
    this.content = content;
    this.saveState = "saved";
    this.rebuild();
    return true;
  }

  // --- Field helpers -----------------------------------------------------

  /** The schema fields the form edits (none without a form). */
  get formFields(): Field[] {
    return this.form?.fields ?? [];
  }

  private fieldAtPath(path: ValuePath): Field | null {
    return this.form ? fieldAt(this.form.fields, path) : null;
  }

  private templateValues(): Record<string, unknown> {
    return this.form?.values() ?? {};
  }

  private documentPath(): string | undefined {
    return this.dataEntry ? undefined : this.path;
  }

  /** This document as the scope its own fields (and a component's props)
   * resolve against. */
  private ownScope(): FieldScope {
    return {
      entry: this.entry,
      documentPath: this.documentPath(),
      templateValues: () => this.templateValues(),
    };
  }

  /** The body's cards and pills (see bodyEmbeds.ts), with where each image
   * can be previewed. */
  bodyEmbeds(
    text: string,
  ): Array<BodyEmbed & { image?: { path: string | null; url: string | null } }> {
    return scanBodyEmbeds(text, this.isMdx).map((embed) =>
      embed.kind === "image" && embed.src !== undefined
        ? { ...embed, image: this.bodyImagePreview(embed.src) }
        : embed,
    );
  }

  /** Where a body image can be previewed, resolved as the desktop body
   * editor does: document-relative paths, then the entry's media folder and
   * the image libraries, then `public/` for other site paths. */
  bodyImagePreview(src: string): { path: string | null; url: string | null } {
    if (!src) return { path: null, url: null };
    if (isRemoteMediaUrl(src)) return { path: null, url: src };
    // Previews read only inside the site: a `../../` source can't reach the
    // rest of the disk (the macOS app isn't sandboxed).
    const inside = (path: string | null) => {
      const normal = path === null ? null : normalizeAbsolute(path);
      return normal !== null && normal.startsWith(`${this.host.root}/`) ? normal : null;
    };
    if (!src.startsWith("/")) {
      const documentPath = this.documentPath();
      return {
        path: documentPath ? inside(resolveRelativeMediaPath(documentPath, src)) : null,
        url: null,
      };
    }
    let decoded = src;
    try {
      decoded = decodeURIComponent(src);
    } catch {
      // Keep malformed escapes resolvable as their literal filename.
    }
    const configured = this.bodyConfiguredMedia();
    const libraryMedia = (this.host.config().mediaLibraries ?? []).map(defaultLibraryMedia);
    const resolved = [configured, ...libraryMedia]
      .filter((candidate): candidate is MediaEntry => candidate !== null)
      .map((candidate) => mediaInputPath(this.host.root, candidate, decoded))
      .find((candidate): candidate is string => candidate !== null);
    return { path: inside(resolved ?? `${this.host.root}/public${decoded}`), url: null };
  }

  /** Where an image value can be previewed: a local absolute path or URL.
   * `field` is the field at `path` in another form (a component's props),
   * resolved against this document's entry as on desktop. */
  imagePreview(
    path: ValuePath,
    value: string,
    field: Field | null = this.fieldAtPath(path),
    scope: FieldScope = this.ownScope(),
  ): { path: string | null; url: string | null } {
    if (!value) return { path: null, url: null };
    if (isRemoteMediaUrl(value)) return { path: null, url: value };
    const config = this.host.config();
    const values = scope.templateValues();
    const media = field ? resolveMedia(config, field, scope.entry, values) : null;
    const valueMedia = field
      ? resolveMediaForValue(config, field, value, scope.entry, values)
      : null;
    const libraryMedia: MediaEntry[] = (config.mediaLibraries ?? []).map((library) => {
      const input = library.base.replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
      return { name: `library:${library.collection}`, input, output: `/${input}` };
    });
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      // Keep malformed escapes resolvable as their literal filename.
    }
    const resolved =
      [valueMedia, media, ...config.media, ...libraryMedia]
        .filter((candidate): candidate is MediaEntry => candidate !== null)
        .map((candidate) => mediaInputPath(this.host.root, candidate, value, scope.documentPath))
        .find((candidate): candidate is string => candidate !== null) ??
      (value.startsWith("/") ? `${this.host.root}/public${decoded}` : null);
    return { path: resolved, url: null };
  }

  /** The images an image field can pick from its media folder (`field`
   * as for imagePreview). */
  async imageChoices(
    path: ValuePath,
    field: Field | null = this.fieldAtPath(path),
    current?: string,
    scope: FieldScope = this.ownScope(),
  ): Promise<{
    media: { name: string; label: string | null; input: string } | null;
    files: Array<{ name: string; path: string; value: string }>;
    /** Set when picked images belong on a CDN, which can be browsed too. */
    cdnSource: CdnSource | null;
  }> {
    const config = this.host.config();
    const media = field
      ? this.imageFieldMedia(field, current, scope)
      : (scope.entry?.media ?? config.media[0] ?? null);
    if (!media) return { media: null, files: [], cdnSource: null };
    const sourceName =
      typeof field?.options?.mediaSource === "string" ? field.options.mediaSource : media.name;
    const cdnSource = config.cdnSources?.find((source) => source.name === sourceName) ?? null;
    const dir = `${this.host.root}/${media.input}`;
    const listed =
      (await invoke<FileEntry[] | null>("list_dir_files_optional", {
        dir,
        extensions: IMAGE_EXTENSIONS,
      })) ?? [];
    return {
      media: { name: media.name, label: media.label ?? null, input: media.input },
      files: listed.flatMap((file) => {
        const value = mediaOutputPath(this.host.root, media, file.path, scope.documentPath);
        return value ? [{ name: file.name, path: file.path, value }] : [];
      }),
      cdnSource,
    };
  }

  /** The media folder an image field picks from: the one its current
   * value lives in (as the desktop picker opens), else the field's own. */
  private imageFieldMedia(
    field: Field | null,
    current: string | undefined,
    scope: FieldScope,
  ): MediaEntry | null {
    if (!field) return null;
    const config = this.host.config();
    const values = scope.templateValues();
    return (
      (current ? resolveMediaForValue(config, field, current, scope.entry, values) : null) ??
      resolveMedia(config, field, scope.entry, values)
    );
  }

  /** The value an image field stores for a file picked in the media
   * picker, or null when the field can't reference it:
   * - inside the field's media folder: as the desktop field picker writes it;
   * - in `public/`: its site path, which the site serves;
   * - elsewhere, for a field storing document-relative paths (Astro
   *   `image()`): relative to the document, as Astro imports it. */
  imageFieldValue(
    path: ValuePath,
    absolutePath: string,
    field: Field | null = this.fieldAtPath(path),
    current?: string,
    scope: FieldScope = this.ownScope(),
  ): string | null {
    const root = this.host.root;
    const media = this.imageFieldMedia(field, current, scope);
    if (media) {
      const value = mediaOutputPath(root, media, absolutePath, scope.documentPath);
      if (value) return value;
    }
    const publicRoot = `${root}/public/`;
    if (absolutePath.startsWith(publicRoot)) return `/${absolutePath.slice(publicRoot.length)}`;
    const documentPath = scope.documentPath;
    if (media?.relative && documentPath) return relativeMediaPath(documentPath, absolutePath);
    return null;
  }

  /** The stored value for a file picked into the body, as the desktop body
   * editor writes it (markdownMediaOutputPath): a site path inside
   * `public/`, relative to the document anywhere else (an image library,
   * `src/`, a media folder). */
  bodyMediaValue(absolutePath: string): string {
    return markdownMediaOutputPath(this.host.root, this.path, absolutePath);
  }

  /** The markdown the desktop body editor inserts for picked media
   * (markdownMediaEditorContent, as Tiptap writes it out): an image, an
   * `<audio>`/`<video>` element, or a link. A local file gets its path from
   * bodyMediaValue; `url` (a CDN image) is used as is. Without `kind`, the
   * file's extension decides. */
  bodyMediaSnippet(pick: {
    absolutePath?: string | null;
    url?: string | null;
    kind?: string | null;
    /** The image's alt text. Without it, the file's name: as the desktop
     * picker writes it, but without the extension, as the app always has. */
    alt?: string | null;
    /** The file's name, which a link shows. */
    label?: string | null;
  }): { snippet: string; kind: MarkdownMediaKind } {
    const outputPath = pick.url
      ? pick.url
      : pick.absolutePath
        ? this.bodyMediaValue(pick.absolutePath)
        : null;
    if (!outputPath) throw new Error("Choose a file or a URL to insert.");
    const kinds: MarkdownMediaKind[] = ["image", "audio", "video", "link"];
    const kind = kinds.includes(pick.kind as MarkdownMediaKind)
      ? (pick.kind as MarkdownMediaKind)
      : markdownMediaKind(pick.absolutePath ?? outputPath);
    const file = pick.absolutePath ?? outputPath.replace(/[?#].*$/, "");
    const label = pick.label || file.slice(file.lastIndexOf("/") + 1);
    const html = markdownMediaHtml({ outputPath, label, kind });
    if (html) return { snippet: html, kind };
    if (kind === "image") {
      const alt =
        pick.alt ?? (label.includes(".") ? label.slice(0, label.lastIndexOf(".")) : label);
      return { snippet: markdownImage(alt, outputPath), kind };
    }
    return { snippet: `[${markdownLabel(label)}](${markdownDestination(outputPath)})`, kind };
  }

  /** The configured media folder of the document's entry, with its
   * per-entry template filled in (BodyEditor's `configuredMedia`). */
  bodyConfiguredMedia(): MediaEntry | null {
    const media = this.entry?.media;
    return media ? expandMediaEntry(media, this.templateValues()) : null;
  }

  async referenceOptions(
    path: ValuePath,
    field: Field | null = this.fieldAtPath(path),
  ): Promise<{
    options: SelectValue[];
    collection: { name: string; label: string } | null;
  }> {
    const config = this.host.config();
    const collection =
      config.content.find(
        (entry) => entry.type === "collection" && entry.name === field?.options?.collection,
      ) ?? null;
    if (!field || !collection) return { options: [], collection: null };
    let listed: FileEntry[] = [];
    if (collection.dataFile) {
      listed =
        this.host.groups().find((group) => group.dataCollection === collection.name)?.files ?? [];
    } else {
      const extension = collectionExtension(collection);
      try {
        listed = await invoke<FileEntry[]>("list_dir_files", {
          dir: `${this.host.root}/${collection.path}`,
          extensions: extension ? [extension] : [],
        });
      } catch {
        listed = [];
      }
    }
    const known = new Map<string, FileEntry>();
    for (const group of this.host.groups()) {
      for (const file of group.files) known.set(file.path, file);
    }
    const enriched = listed.map((file) => {
      if (file.dataEntry) return file;
      const match = known.get(file.path);
      return match
        ? { ...file, title: file.title ?? match.title, frontmatter: match.frontmatter }
        : file;
    });
    return {
      options: referenceOptions({
        files: applyCollectionPrefs(enriched, collection),
        field,
        collection,
        root: this.host.root,
        entryIds: this.host.adapter().capabilities.entryIds,
      }),
      collection: { name: collection.name, label: collection.label ?? collection.name },
    };
  }

  /** The filename a manual template would produce now, or null. */
  templatedFilename(template: string): string | null {
    const entry = this.entry;
    if (!entry) return null;
    const parsed = parseFile(this.content);
    const raw = parsed.doc.toJSON() as unknown;
    if (parsed.error || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Fix the file's frontmatter before refreshing its filename.");
    }
    return renamedFilename(template, entry, raw as Record<string, unknown>, this.name);
  }

  close(): Promise<void> {
    const pending = this.flushPendingSave();
    this.closed = true;
    return pending;
  }
}

/** Where an image library's files are served from when no media folder
 * says otherwise (BodyEditor's defaultLibraryMedia). */
export function defaultLibraryMedia(library: MediaLibrary): MediaEntry {
  const input = library.base.replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
  return { name: `library:${library.collection}`, input, output: `/${input}` };
}

/** Alt or link text that stays one label: brackets and backslashes escaped,
 * line breaks folded (a newline would end the image's paragraph). */
function markdownLabel(text: string): string {
  return text.replace(/[\\[\]]/g, "\\$&").replace(/\s*[\r\n]+\s*/g, " ");
}

/** A link or image destination; one with spaces, parentheses or angle
 * brackets (a document-relative path keeps its file's name as is) goes in
 * `<…>`, as CommonMark allows. */
function markdownDestination(path: string): string {
  if (!/[\s()<>]/.test(path)) return path;
  return `<${path.replace(/[<>]/g, (character) => encodeURIComponent(character))}>`;
}

function markdownImage(alt: string, src: string): string {
  return `![${markdownLabel(alt)}](${markdownDestination(src)})`;
}

/** An absolute path with `.` and `..` segments resolved; null when it
 * climbs above the root. */
function normalizeAbsolute(path: string): string | null {
  if (!path.startsWith("/")) return null;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `/${parts.join("/")}`;
}

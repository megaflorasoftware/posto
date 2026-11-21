/**
 * The Media screen: image libraries, the read-only `src` images, and
 * `public/` files, with every management action the mobile app offers
 * (folders, import, edit and rename, move, delete, validate). The listing
 * and planning logic is the editor package's; this module holds the state
 * the React hooks and dialogs used to.
 */
import type { FileEntry } from "@posto/ipc";
import type { CdnSource } from "@posto/core/media/sources";
import { cdnObjectForUrl } from "@posto/core/media/sources";
import type {
  MediaLibrary,
  MediaLibraryMetadataExtension,
  PagesConfig,
} from "@posto/core/pagescms/config";
import { pathEntryId } from "@posto/core/project/entryIds";
import {
  discoverImageLibraryAssets,
  matchesImageLibraryPath,
  planMediaImport,
  serializeImageLibraryMetadata,
  usesImageDetails,
  usesPlaceholder,
  withImageDetails,
  type ImageDetails,
  type ImageLibraryAsset,
} from "@posto/core/project/mediaLibrary";
import { imageLibraryItemsIn } from "../../../../packages/editor/src/imageLibraryItems";
import {
  editValueAtPath,
  imageLibraryMetadataFields,
  metadataExtension,
} from "../../../../packages/editor/src/imageLibraryMetadata";
import {
  applyImageLibraryReferenceUpdates,
  planImageLibraryReferenceUpdates,
  planMarkdownMediaReferenceUpdates,
} from "../../../../packages/editor/src/imageLibraryReferences";
import {
  hasImageDetailFields,
  validateImageLibraryAssets,
  validationSources,
} from "../../../../packages/editor/src/imageLibraryValidation";
import { markdownMediaKind } from "../../../../packages/editor/src/markdownMedia";
import {
  markdownReferenceReplacements,
  moveFileMediaItems,
  moveImageLibraryItems,
} from "../../../../packages/editor/src/mediaMoves";
import {
  directoriesContainingFiles,
  isPublicMediaFile,
} from "../../../../packages/editor/src/hooks/usePublicMediaFiles";
import { dateControls, type DateControl } from "./dates";
import { fieldViews, type FieldView } from "./fieldViews";
import { errorMessage, invoke, notify } from "./host";
import {
  importFileMediaItem,
  importImageLibraryAsset,
  mediaPlaceholder,
  readImageDetails,
  recordMediaDelete,
} from "./ipc";
import { MetadataForm } from "./metadataForm";
import type { RepoSession } from "./repo";

export const PUBLIC_TAB = "__posto_public__";
export const SOURCE_TAB = "__posto_src__";

export interface MediaTab {
  id: string;
  label: string;
  kind: "library" | "source" | "public";
}

export interface MediaFolderView {
  name: string;
  path: string;
  previews: string[];
}

export interface MediaItemView {
  /** Library entries: the metadata path; files: the file path. */
  id: string;
  /** Library entries: the id references store. */
  entryId?: string;
  name: string;
  imagePath: string | null;
  imageUrl: string | null;
  kind: "image" | "audio" | "video" | "link";
  /** Broken library entries can't be selected or edited. */
  problem: string | null;
}

export interface MediaListing {
  tab: string;
  rootDirectory: string;
  directory: string;
  folders: MediaFolderView[];
  items: MediaItemView[];
  loading: boolean;
  error: string | null;
  readOnly: boolean;
}

interface LibraryState {
  assets: ImageLibraryAsset[];
  directories: string[];
  error: string | null;
  loaded: boolean;
}

interface FileState {
  files: FileEntry[];
  directories: string[];
  error: string | null;
  loaded: boolean;
}

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function sourceStem(path: string): string {
  const name = basename(path);
  return name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
}

function sourceExtension(path: string): string {
  const name = basename(path);
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
}

function metadataAlt(metadata: Record<string, unknown>): string | undefined {
  return Object.prototype.hasOwnProperty.call(metadata, "alt") && typeof metadata.alt === "string"
    ? metadata.alt
    : undefined;
}

export interface AssetEditorView {
  id: string;
  entryId: string;
  imagePath: string | null;
  imageUrl: string | null;
  filename: string | null;
  extension: string;
  fields: FieldView[];
  values: Record<string, unknown>;
  errors: Record<string, string>;
  dates: Record<string, DateControl>;
}

export interface ImportDraft {
  sourceImagePath: string;
  filename: string;
  metadataExtension: MediaLibraryMetadataExtension | null;
  form: MetadataForm;
}

export interface ImportView {
  tab: string;
  library: string;
  folder: string;
  metadataExtensions: MediaLibraryMetadataExtension[];
  drafts: Array<{
    sourceImagePath: string;
    filename: string;
    extension: string;
    metadataExtension: MediaLibraryMetadataExtension | null;
    values: Record<string, unknown>;
    errors: Record<string, string>;
    dates: Record<string, DateControl>;
  }>;
  fields: FieldView[];
  canImport: boolean;
}

export class MediaSession {
  private libraries = new Map<string, LibraryState>();
  private files = new Map<string, FileState>();
  assetEditor: { library: MediaLibrary; asset: ImageLibraryAsset; form: MetadataForm } | null =
    null;
  importer: { library: MediaLibrary; folder: string; drafts: ImportDraft[] } | null = null;
  private credentialResolver:
    | ((credential: { accessKeyId?: string; secret: string } | null) => void)
    | null = null;

  constructor(private readonly repo: RepoSession) {}

  private get root(): string {
    return this.repo.root;
  }

  private get config(): PagesConfig {
    return this.repo.config;
  }

  tabs(): MediaTab[] {
    const libraries = this.repo.adapter.capabilities.mediaLibraries
      ? (this.config.mediaLibraries ?? [])
      : [];
    return [
      ...libraries.map((library) => ({
        id: library.collection,
        label: library.collection,
        kind: "library" as const,
      })),
      ...(this.repo.view().showSourceMedia
        ? [{ id: SOURCE_TAB, label: "src", kind: "source" as const }]
        : []),
      { id: PUBLIC_TAB, label: "public", kind: "public" as const },
    ];
  }

  library(tab: string): MediaLibrary {
    const library = this.config.mediaLibraries?.find((candidate) => candidate.collection === tab);
    if (!library) throw new Error(`Unknown media library ${tab}`);
    return library;
  }

  private libraryRoot(library: MediaLibrary): string {
    return `${this.root}/${library.base}`;
  }

  /** The tab and folder that show `folder` (absolute), so a picker opens at
   * a field's media folder: the most specific root holding it wins. */
  locate(folder: string): { tab: string; directory: string } | null {
    const clean = (path: string) => path.replace(/\/\.\//g, "/").replace(/\/+$/, "");
    const target = clean(folder);
    const roots = this.tabs()
      .map((tab) => ({
        tab: tab.id,
        root: clean(tab.kind === "library" ? this.libraryRoot(this.library(tab.id)) : this.fileRoot(tab.id)),
      }))
      .sort((a, b) => b.root.length - a.root.length);
    for (const { tab, root } of roots) {
      if (target === root) return { tab, directory: "" };
      if (target.startsWith(`${root}/`)) return { tab, directory: target.slice(root.length + 1) };
    }
    return null;
  }

  private fileRoot(tab: string): string {
    return tab === SOURCE_TAB ? `${this.root}/src` : `${this.root}/public`;
  }

  // --- Loading -----------------------------------------------------------

  async loadLibrary(library: MediaLibrary): Promise<LibraryState> {
    const libraryRoot = this.libraryRoot(library);
    try {
      const [files, directories] = await Promise.all([
        invoke<FileEntry[]>("list_dir_files", { dir: libraryRoot, extensions: [] }),
        invoke<string[]>("list_directories", { dir: libraryRoot }),
      ]);
      const extensions = new Set(library.metadataExtensions);
      const metadata = files.filter((file) => {
        const extension = file.name
          .split(".")
          .pop()
          ?.toLowerCase() as MediaLibraryMetadataExtension;
        return (
          extensions.has(extension) &&
          matchesImageLibraryPath(library, file.path.slice(libraryRoot.length + 1))
        );
      });
      const documents = await Promise.all(
        metadata.map(async (file) => ({
          path: file.path,
          content: await invoke<string>("read_text_file", { path: file.path }),
        })),
      );
      const state: LibraryState = {
        assets: discoverImageLibraryAssets(
          library,
          this.root,
          documents,
          files.map((file) => file.path),
        ),
        directories,
        error: null,
        loaded: true,
      };
      this.libraries.set(library.collection, state);
      return state;
    } catch (error) {
      const state: LibraryState = {
        assets: this.libraries.get(library.collection)?.assets ?? [],
        directories: this.libraries.get(library.collection)?.directories ?? [],
        error: errorMessage(error),
        loaded: true,
      };
      this.libraries.set(library.collection, state);
      return state;
    }
  }

  private async loadFiles(tab: string): Promise<FileState> {
    const directoryRoot = this.fileRoot(tab);
    const source = tab === SOURCE_TAB;
    try {
      const listed = await invoke<FileEntry[] | null>("list_dir_files_optional", {
        dir: directoryRoot,
        extensions: [],
      });
      if (listed === null) {
        const empty = { files: [], directories: [], error: null, loaded: true };
        this.files.set(tab, empty);
        return empty;
      }
      const accepted = listed.filter((file) =>
        source ? markdownMediaKind(file.path) === "image" : isPublicMediaFile(file.path),
      );
      const state: FileState = {
        files: accepted,
        directories: source
          ? directoriesContainingFiles(directoryRoot, accepted)
          : await invoke<string[]>("list_directories", { dir: directoryRoot }),
        error: null,
        loaded: true,
      };
      this.files.set(tab, state);
      return state;
    } catch (error) {
      const state = { files: [], directories: [], error: errorMessage(error), loaded: true };
      this.files.set(tab, state);
      return state;
    }
  }

  invalidate(): void {
    this.libraries.clear();
    this.files.clear();
  }

  async list(tab: string, directory: string, reload = false): Promise<MediaListing> {
    if (tab === PUBLIC_TAB || tab === SOURCE_TAB) {
      const state = (!reload && this.files.get(tab)) || (await this.loadFiles(tab));
      const rootDirectory = this.fileRoot(tab);
      const current = directory ? `${rootDirectory}/${directory}` : rootDirectory;
      return {
        tab,
        rootDirectory,
        directory,
        folders: state.directories
          .filter((path) => dirname(path) === current)
          .map((path) => ({
            name: basename(path),
            path,
            previews: state.files
              .filter(
                (file) =>
                  file.path.startsWith(`${path}/`) && markdownMediaKind(file.path) === "image",
              )
              .slice(0, 4)
              .map((file) => file.path),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        items: state.files
          .filter((file) => dirname(file.path) === current)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((file) => ({
            id: file.path,
            name: file.name,
            imagePath: file.path,
            imageUrl: null,
            kind: markdownMediaKind(file.path),
            problem: null,
          })),
        loading: false,
        error: state.error,
        readOnly: tab === SOURCE_TAB,
      };
    }
    const library = this.library(tab);
    const state = (!reload && this.libraries.get(tab)) || (await this.loadLibrary(library));
    const rootDirectory = this.libraryRoot(library);
    const visible = imageLibraryItemsIn(rootDirectory, directory, state.directories, state.assets);
    return {
      tab,
      rootDirectory,
      directory,
      folders: visible.folders.map((folder) => ({
        ...folder,
        previews: state.assets
          .filter((asset) => asset.metadataPath.startsWith(`${folder.path}/`))
          .flatMap((asset) => asset.imagePath ?? asset.imageUrl ?? [])
          .slice(0, 4),
      })),
      items: visible.assets.map((asset) => ({
        id: asset.metadataPath,
        entryId: asset.entryId,
        name: asset.entryId.split("/").pop() ?? asset.entryId,
        imagePath: asset.imagePath,
        imageUrl: asset.imageUrl ?? null,
        kind: "image",
        problem: asset.health.includes("valid") ? null : asset.health.join(", "),
      })),
      loading: false,
      error: state.error,
      readOnly: false,
    };
  }

  /** Every usable entry of a library, for image-library reference fields. */
  async libraryAssets(collection: string) {
    const library = this.library(collection);
    const state = this.libraries.get(collection) ?? (await this.loadLibrary(library));
    return state.assets
      .filter((asset) => asset.health.includes("valid"))
      .map((asset) => ({
        id: asset.metadataPath,
        entryId: asset.entryId,
        name: asset.entryId.split("/").pop() ?? asset.entryId,
        imagePath: asset.imagePath,
        imageUrl: asset.imageUrl ?? null,
      }));
  }

  private asset(tab: string, id: string): ImageLibraryAsset {
    const asset = this.libraries
      .get(tab)
      ?.assets.find((candidate) => candidate.metadataPath === id);
    if (!asset) throw new Error("That image is no longer in the library.");
    return asset;
  }

  private changed(library: MediaLibrary | null, silent = false) {
    if (!silent) this.repo.setStatus("Media updated. Publish when you are ready.");
    void this.repo.git.refreshLocalChanges();
    if (library) this.libraries.delete(library.collection);
    void this.repo.document?.reloadFromDisk().then((reloaded) => {
      if (reloaded) this.repo.documentChanged();
    });
    notify("media-changed", {});
  }

  private cdn() {
    return { root: this.root, sources: this.config.cdnSources ?? [] };
  }

  // --- Folders -----------------------------------------------------------

  async createFolder(tab: string, directory: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (
      !trimmed ||
      trimmed === "." ||
      trimmed === ".." ||
      /[\\/]/.test(trimmed) ||
      trimmed.startsWith(".")
    ) {
      throw new Error("Use a visible folder name without slashes.");
    }
    if (tab === PUBLIC_TAB) {
      await invoke("create_file_media_directory", {
        repositoryRoot: this.root,
        mediaRoot: `${this.root}/public`,
        directory: [directory, trimmed].filter(Boolean).join("/"),
      });
      this.files.delete(tab);
      return;
    }
    const library = this.library(tab);
    const libraryRoot = this.libraryRoot(library);
    await invoke("create_image_library_directory", {
      libraryRoot,
      directoryPath: [libraryRoot, directory, trimmed].filter(Boolean).join("/"),
    });
    this.libraries.delete(tab);
  }

  // --- Delete ------------------------------------------------------------

  private async deleteAsset(libraryRoot: string, asset: ImageLibraryAsset): Promise<void> {
    if (asset.imageUrl) {
      const cdn = this.cdn();
      const object = cdnObjectForUrl(cdn.sources, asset.imageUrl);
      if (object) {
        await recordMediaDelete(cdn.root, {
          sourceName: object.source.name,
          key: object.key,
          url: asset.imageUrl,
          metadataPath: asset.metadataPath,
        });
      }
      await invoke("delete_media_file", { mediaRoot: libraryRoot, filePath: asset.metadataPath });
      return;
    }
    if (!asset.imagePath) throw new Error(`${asset.entryId} has no image to delete.`);
    await invoke("delete_image_library_asset", {
      libraryRoot,
      imagePath: asset.imagePath,
      metadataPath: asset.metadataPath,
    });
  }

  async deleteItems(tab: string, ids: string[], folders: string[]): Promise<void> {
    if (tab === PUBLIC_TAB) {
      const mediaRoot = `${this.root}/public`;
      for (const path of ids) await invoke("delete_media_file", { mediaRoot, filePath: path });
      for (const path of folders) {
        await invoke("delete_media_directory", { mediaRoot, directoryPath: path });
      }
      this.files.delete(tab);
      this.changed(null, true);
      return;
    }
    const library = this.library(tab);
    const libraryRoot = this.libraryRoot(library);
    const state = this.libraries.get(tab);
    for (const id of ids) await this.deleteAsset(libraryRoot, this.asset(tab, id));
    for (const directory of folders) {
      for (const asset of state?.assets ?? []) {
        if (!asset.imageUrl || !asset.metadataPath.startsWith(`${directory}/`)) continue;
        const object = cdnObjectForUrl(this.cdn().sources, asset.imageUrl);
        if (object) {
          await recordMediaDelete(this.root, {
            sourceName: object.source.name,
            key: object.key,
            url: asset.imageUrl,
            metadataPath: asset.metadataPath,
          });
        }
      }
      await invoke("delete_image_library_directory", { libraryRoot, directoryPath: directory });
    }
    this.changed(library, true);
  }

  // --- Move --------------------------------------------------------------

  /** Folders a move can target, relative to the tab's root. */
  async moveTargets(tab: string): Promise<string[]> {
    if (tab === PUBLIC_TAB) {
      const state = this.files.get(tab) ?? (await this.loadFiles(tab));
      const root = this.fileRoot(tab);
      return ["", ...state.directories.map((path) => path.slice(root.length + 1))];
    }
    const library = this.library(tab);
    const state = this.libraries.get(tab) ?? (await this.loadLibrary(library));
    const root = this.libraryRoot(library);
    return ["", ...state.directories.map((path) => path.slice(root.length + 1))];
  }

  async moveItems(
    tab: string,
    ids: string[],
    folders: string[],
    destination: string,
  ): Promise<void> {
    const flush = () => this.repo.document?.flushPendingSave() ?? Promise.resolve();
    if (tab === PUBLIC_TAB) {
      const state = this.files.get(tab) ?? (await this.loadFiles(tab));
      const mediaRoot = `${this.root}/public`;
      await moveFileMediaItems({
        root: this.root,
        mediaRoot,
        groups: this.repo.files.groups,
        directories: state.directories,
        files: state.files,
        movingFiles: state.files.filter((file) => ids.includes(file.path)),
        movingDirectories: folders,
        destinationDirectory: destination ? `${mediaRoot}/${destination}` : mediaRoot,
        onBeforeChange: flush,
      });
      this.files.delete(tab);
      this.changed(null);
      return;
    }
    const library = this.library(tab);
    const state = this.libraries.get(tab) ?? (await this.loadLibrary(library));
    const libraryRoot = this.libraryRoot(library);
    await moveImageLibraryItems({
      root: this.root,
      library,
      config: this.config,
      groups: this.repo.files.groups,
      libraryRoot,
      directories: state.directories,
      assets: state.assets,
      movingAssets: state.assets.filter((asset) => ids.includes(asset.metadataPath)),
      movingDirectories: folders,
      destinationDirectory: destination ? `${libraryRoot}/${destination}` : libraryRoot,
      onBeforeMove: flush,
    });
    this.changed(library);
  }

  // --- Validate ----------------------------------------------------------

  /** Asks Swift for a storage password; resolves null when cancelled. */
  private requestCredential(source: CdnSource, error: string | null) {
    return new Promise<{ accessKeyId?: string; secret: string } | null>((resolve) => {
      this.credentialResolver = resolve;
      notify("media-credential", { source, error });
    });
  }

  submitCredential(credential: { accessKeyId?: string; secret: string } | null): void {
    const resolve = this.credentialResolver;
    this.credentialResolver = null;
    resolve?.(credential);
  }

  async validate(
    tab: string,
    ids: string[],
    folders: string[],
  ): Promise<{
    skipped: string | null;
    updated: number;
    unchanged: number;
    failed: Array<{ entryId: string; message: string }>;
  } | null> {
    const library = this.library(tab);
    if (!hasImageDetailFields(library)) {
      return {
        skipped:
          "No fields in this library take a value from the image. Add an annotation like value=schema.<image>.width or initial=schema.<image>.capture-date to a field's description.",
        updated: 0,
        unchanged: 0,
        failed: [],
      };
    }
    const state = this.libraries.get(tab) ?? (await this.loadLibrary(library));
    const assets = state.assets.filter(
      (asset) =>
        asset.health.includes("valid") &&
        (ids.includes(asset.metadataPath) ||
          folders.some((folder) => asset.metadataPath.startsWith(`${folder}/`))),
    );
    const sources = this.config.cdnSources ?? [];
    for (const source of validationSources(library, assets, sources)) {
      if (await invoke<boolean>("media_credential_exists", { source })) continue;
      let refusal: string | null = null;
      for (;;) {
        const credential = await this.requestCredential(source, refusal);
        if (!credential) return null;
        try {
          await invoke("media_credential_save", {
            source,
            credential,
            prefix: source.prefix ?? "",
          });
          break;
        } catch (error) {
          refusal = errorMessage(error);
        }
      }
    }
    await this.repo.document?.flushPendingSave();
    const result = await validateImageLibraryAssets({
      library,
      assets,
      sources,
      onProgress: (done, total) => notify("media-progress", { done, total }),
    });
    if (result.updated.length > 0) this.changed(library);
    return {
      skipped: null,
      updated: result.updated.length,
      unchanged: result.unchanged,
      failed: result.failed,
    };
  }

  // --- Edit --------------------------------------------------------------

  openAsset(tab: string, id: string): AssetEditorView {
    const library = this.library(tab);
    const asset = this.asset(tab, id);
    this.assetEditor = {
      library,
      asset,
      form: new MetadataForm(imageLibraryMetadataFields(library), structuredClone(asset.metadata)),
    };
    return this.assetView();
  }

  assetView(): AssetEditorView {
    const editor = this.assetEditor;
    if (!editor) throw new Error("No image is being edited");
    const { asset, form } = editor;
    const filename = asset.imagePath ? basename(asset.imagePath) : null;
    return {
      id: asset.metadataPath,
      entryId: asset.entryId,
      imagePath: asset.imagePath,
      imageUrl: asset.imageUrl ?? null,
      filename,
      extension: filename ? sourceExtension(filename) : "",
      fields: fieldViews(form.fields, null, this.config, false, []),
      values: form.values(),
      errors: Object.fromEntries(form.errors()),
      dates: dateControls(form.fields, form.values()),
    };
  }

  async saveAsset(filename: string | null): Promise<void> {
    const editor = this.assetEditor;
    if (!editor) throw new Error("No image is being edited");
    const { asset, form, library } = editor;
    if (!form.valid) throw new Error("Fix the highlighted fields first.");
    const metadata = form.values();
    const libraryRoot = this.libraryRoot(library);
    const originalFilename = asset.imagePath ? basename(asset.imagePath) : "";
    const imageReference = asset.imagePath ?? asset.imageUrl;
    const flush = () => this.repo.document?.flushPendingSave() ?? Promise.resolve();
    if (asset.imagePath && filename !== null && filename !== originalFilename) {
      const originalExtension = sourceExtension(originalFilename);
      if (
        !filename ||
        filename.startsWith(".") ||
        /[\\/]/.test(filename) ||
        sourceExtension(filename).toLowerCase() !== originalExtension.toLowerCase()
      ) {
        throw new Error(`Use a visible filename ending in .${originalExtension}`);
      }
    }
    if (!asset.imagePath || filename === null || filename === originalFilename) {
      const serialized = serializeImageLibraryMetadata(
        metadata,
        metadataExtension(asset.metadataPath),
      );
      const nextAlt = metadataAlt(metadata);
      if (!imageReference || nextAlt === undefined) {
        await invoke("write_text_file", { path: asset.metadataPath, content: serialized });
      } else {
        await flush();
        const plan = await planImageLibraryReferenceUpdates({
          root: this.root,
          config: this.config,
          groups: this.repo.files.groups,
          library,
          relocations: [
            {
              oldEntryId: asset.entryId,
              newEntryId: asset.entryId,
              oldImagePath: imageReference,
              newImagePath: imageReference,
              newAlt: nextAlt,
            },
          ],
        });
        await invoke("write_text_file", { path: asset.metadataPath, content: serialized });
        try {
          await applyImageLibraryReferenceUpdates(plan);
        } catch (error) {
          await invoke("write_text_file", {
            path: asset.metadataPath,
            content: asset.metadataSource,
          }).catch(() => undefined);
          throw error;
        }
      }
    } else {
      await flush();
      const imageDirectory = dirname(asset.imagePath);
      const metadataDirectory = dirname(asset.metadataPath);
      const stem = filename.slice(0, -(sourceExtension(originalFilename).length + 1));
      const targetImagePath = `${imageDirectory}/${filename}`;
      const targetMetadataPath = `${metadataDirectory}/${stem}.${metadataExtension(asset.metadataPath)}`;
      const nextMetadata = editValueAtPath(metadata, library.imageFieldPath, `./${filename}`);
      const serialized = serializeImageLibraryMetadata(
        nextMetadata,
        metadataExtension(asset.metadataPath),
      );
      const plan = await planImageLibraryReferenceUpdates({
        root: this.root,
        config: this.config,
        groups: this.repo.files.groups,
        library,
        relocations: [
          {
            oldEntryId: asset.entryId,
            newEntryId: pathEntryId(targetMetadataPath.slice(libraryRoot.length + 1)),
            oldImagePath: asset.imagePath,
            newImagePath: targetImagePath,
            newAlt: metadataAlt(nextMetadata),
          },
        ],
      });
      await invoke("rename_image_library_asset", {
        libraryRoot,
        imagePath: asset.imagePath,
        metadataPath: asset.metadataPath,
        targetImagePath,
        targetMetadataPath,
        serializedMetadata: serialized,
      });
      try {
        await applyImageLibraryReferenceUpdates(plan);
      } catch (error) {
        await invoke("rename_image_library_asset", {
          libraryRoot,
          imagePath: targetImagePath,
          metadataPath: targetMetadataPath,
          targetImagePath: asset.imagePath,
          targetMetadataPath: asset.metadataPath,
          serializedMetadata: asset.metadataSource,
        }).catch(() => undefined);
        throw error;
      }
    }
    this.assetEditor = null;
    this.changed(library);
  }

  async deleteEditedAsset(): Promise<void> {
    const editor = this.assetEditor;
    if (!editor) throw new Error("No image is being edited");
    await this.deleteAsset(this.libraryRoot(editor.library), editor.asset);
    this.assetEditor = null;
    this.changed(editor.library, true);
  }

  // --- Public files ------------------------------------------------------

  async renamePublicFile(path: string, filename: string): Promise<void> {
    const name = basename(path);
    const extension = sourceExtension(name);
    if (
      !filename ||
      filename.startsWith(".") ||
      /[\\/]/.test(filename) ||
      sourceExtension(filename).toLowerCase() !== extension.toLowerCase()
    ) {
      throw new Error(`Use a visible filename ending in .${extension}`);
    }
    if (filename === name) return;
    const mediaRoot = `${this.root}/public`;
    const targetPath = `${dirname(path)}/${filename}`;
    await this.repo.document?.flushPendingSave();
    const plan = await planMarkdownMediaReferenceUpdates({
      groups: this.repo.files.groups,
      root: this.root,
      relocations: [{ from: path, to: targetPath }],
      replacements: markdownReferenceReplacements(this.root, [{ from: path, to: targetPath }]),
    });
    await invoke("rename_media_file", { mediaRoot, filePath: path, targetFilePath: targetPath });
    try {
      await applyImageLibraryReferenceUpdates(plan);
    } catch (error) {
      await invoke("rename_media_file", {
        mediaRoot,
        filePath: targetPath,
        targetFilePath: path,
      }).catch(() => undefined);
      throw error;
    }
    this.files.delete(PUBLIC_TAB);
    this.changed(null);
  }

  /** Copies picked files (already on this device) into `public/`. */
  async importPublic(directory: string, sources: string[]): Promise<string[]> {
    if (sources.length > 0 && sources.every((path) => !isPublicMediaFile(path))) {
      throw new Error("Choose non-text media files to import into public.");
    }
    const imported: string[] = [];
    for (const sourceFilePath of sources) {
      imported.push(
        await importFileMediaItem({
          repositoryRoot: this.root,
          sourceFilePath,
          directory,
          mediaRoot: `${this.root}/public`,
        }),
      );
    }
    this.files.delete(PUBLIC_TAB);
    this.repo.setStatus("Media imported. Publish when you are ready.");
    void this.repo.git.refreshLocalChanges();
    notify("media-changed", {});
    return imported;
  }

  // --- Library import ----------------------------------------------------

  private async detailsFor(library: MediaLibrary, path: string): Promise<ImageDetails | null> {
    if (!usesImageDetails(library)) return null;
    const [details, placeholder] = await Promise.all([
      readImageDetails(path).catch(() => null),
      usesPlaceholder(library) ? mediaPlaceholder(path).catch(() => null) : null,
    ]);
    if (!details && !placeholder) return null;
    return { captureDate: null, dimensions: null, ...details, placeholder };
  }

  async startImport(tab: string, folder: string, sources: string[]): Promise<ImportView> {
    const library = this.library(tab);
    const extensions = library.metadataExtensions;
    const defaultExtension =
      extensions.length === 1 ? extensions[0] : extensions.includes("yaml") ? "yaml" : null;
    const fields = imageLibraryMetadataFields(library);
    const drafts: ImportDraft[] = [];
    for (const path of sources) {
      const details = await this.detailsFor(library, path);
      drafts.push({
        sourceImagePath: path,
        filename: sourceStem(path),
        metadataExtension: defaultExtension,
        form: new MetadataForm(fields, details ? withImageDetails(library, {}, details) : {}),
      });
    }
    this.importer = { library, folder, drafts };
    return this.importView();
  }

  importView(): ImportView {
    const importer = this.importer;
    if (!importer) throw new Error("No import is in progress");
    const fields = imageLibraryMetadataFields(importer.library);
    return {
      tab: importer.library.collection,
      library: importer.library.collection,
      folder: importer.folder,
      metadataExtensions: importer.library.metadataExtensions,
      drafts: importer.drafts.map((draft) => ({
        sourceImagePath: draft.sourceImagePath,
        filename: draft.filename,
        extension: sourceExtension(draft.sourceImagePath),
        metadataExtension: draft.metadataExtension,
        values: draft.form.values(),
        errors: Object.fromEntries(draft.form.errors()),
        dates: dateControls(draft.form.fields, draft.form.values()),
      })),
      fields: fieldViews(fields, null, this.config, false, []),
      canImport:
        importer.drafts.length > 0 &&
        importer.drafts.every((draft) => draft.filename.trim() && draft.form.valid),
    };
  }

  importDraft(index: number): ImportDraft {
    const draft = this.importer?.drafts[index];
    if (!draft) throw new Error("That image is no longer part of the import.");
    return draft;
  }

  updateDraft(
    index: number,
    changes: { filename?: string; metadataExtension?: MediaLibraryMetadataExtension },
  ): void {
    const draft = this.importDraft(index);
    if (changes.filename !== undefined) draft.filename = changes.filename;
    if (changes.metadataExtension !== undefined)
      draft.metadataExtension = changes.metadataExtension;
  }

  /** Imports drafts in order; drafts that land are dropped so a retry after
   * a mid-batch failure never writes them twice. Returns what landed, so a
   * picker that imported can pick it. */
  async executeImport(): Promise<
    Array<{ entryId: string; imagePath: string; alt: string | null }>
  > {
    const importer = this.importer;
    if (!importer || importer.drafts.length === 0) throw new Error("Choose an image to import.");
    const { library } = importer;
    const libraryRoot = this.libraryRoot(library);
    const prefix = `${libraryRoot}/`;
    const extensions = new Set(library.metadataExtensions);
    let imported = 0;
    const landed: Array<{ entryId: string; imagePath: string; alt: string | null }> = [];
    try {
      for (const draft of importer.drafts) {
        let files: FileEntry[] = [];
        try {
          files = await invoke<FileEntry[]>("list_dir_files", { dir: libraryRoot, extensions: [] });
        } catch {
          // A missing library folder is created by the import.
        }
        const plan = planMediaImport({
          library,
          repositoryRoot: this.root,
          sourceImagePath: draft.sourceImagePath,
          folder: importer.folder,
          filename: draft.filename
            ? `${draft.filename}.${sourceExtension(draft.sourceImagePath)}`
            : undefined,
          metadata: draft.form.values(),
          metadataExtension: draft.metadataExtension ?? undefined,
          existingPaths: files.map((file) => file.path),
          existingEntryIds: files.flatMap((file) =>
            extensions.has(
              file.name.split(".").pop()?.toLowerCase() as MediaLibraryMetadataExtension,
            ) && matchesImageLibraryPath(library, file.path.slice(prefix.length))
              ? [pathEntryId(file.path.slice(prefix.length))]
              : [],
          ),
        });
        await importImageLibraryAsset({
          libraryRoot: plan.libraryRoot,
          sourceImagePath: plan.sourceImagePath,
          destinationImagePath: plan.destinationImagePath,
          destinationMetadataPath: plan.destinationMetadataPath,
          serializedMetadata: plan.serializedMetadata,
          entryId: plan.entryId,
        });
        imported += 1;
        const alt = draft.form.values().alt;
        landed.push({
          entryId: plan.entryId,
          imagePath: plan.destinationImagePath,
          alt: typeof alt === "string" && alt !== "" ? alt : null,
        });
      }
    } finally {
      if (imported > 0) {
        importer.drafts = importer.drafts.slice(imported);
        this.libraries.delete(library.collection);
        this.repo.setStatus("Image imported. Publish when you are ready.");
        void this.repo.git.refreshLocalChanges();
        notify("media-changed", {});
      }
    }
    this.importer = null;
    return landed;
  }
}

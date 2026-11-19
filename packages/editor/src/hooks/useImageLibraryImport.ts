import { useEffect, useState } from "react";
import { pathEntryId } from "@posto/core/project/entryIds";
import {
  MediaPlanError,
  matchesImageLibraryPath,
  planMediaImport,
  usesImageDetails,
  usesPlaceholder,
  withImageDetails,
  type ImageDetails,
  type MediaImportPlan,
} from "@posto/core/project/mediaLibrary";
import type { MediaLibrary, MediaLibraryMetadataExtension } from "@posto/core/pagescms/config";
import {
  importImageLibraryAsset,
  invoke,
  mediaPlaceholder,
  openImageFiles,
  readImageDetails,
  type FileEntry,
  type ImageLibraryImportResult,
} from "@posto/ipc";

export interface ImageLibraryImportDraft {
  sourceImagePath: string;
  filename: string;
  metadata: Record<string, unknown>;
  metadataExtension?: MediaLibraryMetadataExtension;
}

function sourceStem(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  return name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
}

function sourceExtension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
}

function defaultMetadataExtension(
  library: MediaLibrary,
): MediaLibraryMetadataExtension | undefined {
  if (library.metadataExtensions.length === 1) return library.metadataExtensions[0];
  return library.metadataExtensions.includes("yaml") ? "yaml" : undefined;
}

function makeDraft(sourceImagePath: string, library: MediaLibrary): ImageLibraryImportDraft {
  return {
    sourceImagePath,
    filename: sourceStem(sourceImagePath),
    metadata: {},
    metadataExtension: defaultMetadataExtension(library),
  };
}

/** Reads the image's details when the library's schema takes values from it.
 * A file that can't be read leaves those fields to the schema's validation. */
async function detailsFor(
  library: MediaLibrary,
  sourceImagePath: string,
): Promise<ImageDetails | null> {
  if (!usesImageDetails(library)) return null;
  const [details, placeholder] = await Promise.all([
    readImageDetails(sourceImagePath).catch(() => null),
    usesPlaceholder(library) ? mediaPlaceholder(sourceImagePath).catch(() => null) : null,
  ]);
  if (!details && !placeholder) return null;
  return { captureDate: null, dimensions: null, ...details, placeholder };
}

async function metadataForImport(
  library: MediaLibrary,
  draft: ImageLibraryImportDraft,
): Promise<Record<string, unknown>> {
  // The form normally shows these values already; this covers an import that
  // starts before reading the image finished.
  const details = await detailsFor(library, draft.sourceImagePath);
  return details ? withImageDetails(library, draft.metadata, details) : draft.metadata;
}

/** Drives a multi-image import into one library: a single chosen location
 * shared by every image, plus a per-image draft (filename + metadata) the
 * caller pages through. `execute` imports the drafts in order and drops the
 * ones that land so a retry after a mid-batch failure never double-writes. */
export function useImageLibraryImport(input: {
  root: string;
  library: MediaLibrary;
  initialSources?: string[];
  initialFolder?: string;
  onImported?: (result: ImageLibraryImportResult, draft: ImageLibraryImportDraft) => void;
}) {
  const [folder, setFolder] = useState(input.initialFolder ?? "");
  const [drafts, setDrafts] = useState<ImageLibraryImportDraft[]>(() =>
    (input.initialSources ?? []).map((path) => makeDraft(path, input.library)),
  );
  const [index, setIndex] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Shows the values each photo provides in the form, where editable ones
   * can be adjusted before importing. Values the user already typed are kept. */
  function prefillImageDetails(paths: string[], library: MediaLibrary) {
    for (const path of paths) {
      void detailsFor(library, path).then((details) => {
        if (!details) return;
        setDrafts((current) =>
          current.map((draft) =>
            draft.sourceImagePath === path
              ? { ...draft, metadata: withImageDetails(library, draft.metadata, details) }
              : draft,
          ),
        );
      });
    }
  }

  useEffect(() => {
    prefillImageDetails(input.initialSources ?? [], input.library);
    // Only the sources the importer opened with; later ones prefill as chosen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setSources(paths: string[]) {
    setDrafts(paths.map((path) => makeDraft(path, input.library)));
    setIndex(0);
    setError(null);
    prefillImageDetails(paths, input.library);
  }

  function retarget(library: MediaLibrary) {
    setFolder("");
    const paths = drafts.map((draft) => draft.sourceImagePath);
    setDrafts((current) => current.map((draft) => makeDraft(draft.sourceImagePath, library)));
    setIndex(0);
    setError(null);
    prefillImageDetails(paths, library);
  }

  function updateDraft(
    at: number,
    update: (draft: ImageLibraryImportDraft) => ImageLibraryImportDraft,
  ) {
    setDrafts((current) => current.map((draft, i) => (i === at ? update(draft) : draft)));
  }

  async function plan(draft: ImageLibraryImportDraft): Promise<MediaImportPlan> {
    const libraryRoot = `${input.root}/${input.library.base}`;
    let files: FileEntry[] = [];
    try {
      files = await invoke<FileEntry[]>("list_dir_files", { dir: libraryRoot, extensions: [] });
    } catch {
      // The native transaction creates a missing nested destination, while
      // independently checking collisions immediately before writing.
    }
    const prefix = libraryRoot.endsWith("/") ? libraryRoot : `${libraryRoot}/`;
    const metadataExts = new Set(input.library.metadataExtensions);
    return planMediaImport({
      library: input.library,
      repositoryRoot: input.root,
      sourceImagePath: draft.sourceImagePath,
      folder,
      filename: draft.filename
        ? `${draft.filename}.${sourceExtension(draft.sourceImagePath)}`
        : undefined,
      metadata: await metadataForImport(input.library, draft),
      metadataExtension: draft.metadataExtension,
      existingPaths: files.map((file) => file.path),
      existingEntryIds: files.flatMap((file) =>
        metadataExts.has(
          file.name.split(".").pop()?.toLowerCase() as MediaLibraryMetadataExtension,
        ) && matchesImageLibraryPath(input.library, file.path.slice(prefix.length))
          ? [pathEntryId(file.path.slice(prefix.length))]
          : [],
      ),
    });
  }

  /** Imports every draft in order. Each image re-reads the library first, so a
   * name that collides with a sibling imported moments earlier is caught. On
   * failure the drafts that already landed are removed and the offending image
   * is left focused; returns whether the whole batch imported. */
  async function execute(): Promise<boolean> {
    if (drafts.length === 0) {
      setError(
        new MediaPlanError([{ code: "validation", message: "Choose an image to import." }]).message,
      );
      return false;
    }
    setPending(true);
    setError(null);
    let imported = 0;
    const importFrom = async (draftIndex: number): Promise<void> => {
      const draft = drafts[draftIndex];
      if (!draft) return;
      const operation = await plan(draft);
      const result = await importImageLibraryAsset({
        libraryRoot: operation.libraryRoot,
        sourceImagePath: operation.sourceImagePath,
        destinationImagePath: operation.destinationImagePath,
        destinationMetadataPath: operation.destinationMetadataPath,
        serializedMetadata: operation.serializedMetadata,
        entryId: operation.entryId,
      });
      input.onImported?.(result, draft);
      imported = draftIndex + 1;
      await importFrom(draftIndex + 1);
    };
    try {
      await importFrom(0);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      if (imported > 0) {
        setDrafts((current) => current.slice(imported));
        setIndex(0);
      }
      setPending(false);
    }
  }

  return {
    drafts,
    index,
    setIndex,
    folder,
    setFolder,
    setSources,
    retarget,
    updateDraft,
    chooseSources: openImageFiles,
    plan,
    execute,
    pending,
    error,
    setError,
  };
}

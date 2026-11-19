import { useEffect, useState } from "react";
import { pathEntryId } from "@posto/core/project/entryIds";
import {
  MediaPlanError,
  imageDimensionFields,
  matchesImageLibraryPath,
  planMediaImport,
  withImageDimensions,
  type MediaImportPlan,
} from "@posto/core/project/mediaLibrary";
import type { MediaLibrary, MediaLibraryMetadataExtension } from "@posto/core/pagescms/config";
import { fieldsWithDefault } from "@posto/core/posto/annotations";
import { editValueAtPath, valueAtPath } from "../imageLibraryMetadata";
import {
  importImageLibraryAsset,
  inspectMediaFile,
  invoke,
  openImageFiles,
  readCaptureDate,
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

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** Fills empty capture-date fields, leaving anything the user entered. */
function withCaptureDate(
  library: MediaLibrary,
  metadata: Record<string, unknown>,
  date: string | null,
): Record<string, unknown> {
  if (!date) return metadata;
  return fieldsWithDefault(library.fields, "capture-date").reduce(
    (current, path) =>
      isEmpty(valueAtPath(current, path)) ? editValueAtPath(current, path, date) : current,
    metadata,
  );
}

async function captureDateFor(library: MediaLibrary, sourceImagePath: string) {
  if (fieldsWithDefault(library.fields, "capture-date").length === 0) return null;
  return readCaptureDate(sourceImagePath).catch(() => null);
}

/** Adds the capture date and dimensions that the library's schema asks for. A
 * file that can't be measured falls through to the schema's own validation. */
async function metadataForImport(
  library: MediaLibrary,
  draft: ImageLibraryImportDraft,
): Promise<Record<string, unknown>> {
  // The form normally shows the capture date already; this covers an import
  // that starts before reading it finished.
  const metadata = withCaptureDate(
    library,
    draft.metadata,
    await captureDateFor(library, draft.sourceImagePath),
  );
  if (!imageDimensionFields(library)) return metadata;
  const inspected = await inspectMediaFile(draft.sourceImagePath).catch(() => null);
  return inspected?.dimensions
    ? withImageDimensions(library, metadata, inspected.dimensions)
    : metadata;
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

  /** Shows each photo's capture date in the form, where it can be adjusted
   * before importing. Values the user already typed are kept. */
  function prefillCaptureDates(paths: string[], library: MediaLibrary) {
    for (const path of paths) {
      void captureDateFor(library, path).then((date) => {
        if (!date) return;
        setDrafts((current) =>
          current.map((draft) =>
            draft.sourceImagePath === path
              ? { ...draft, metadata: withCaptureDate(library, draft.metadata, date) }
              : draft,
          ),
        );
      });
    }
  }

  useEffect(() => {
    prefillCaptureDates(input.initialSources ?? [], input.library);
    // Only the sources the importer opened with; later ones prefill as chosen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setSources(paths: string[]) {
    setDrafts(paths.map((path) => makeDraft(path, input.library)));
    setIndex(0);
    setError(null);
    prefillCaptureDates(paths, input.library);
  }

  function retarget(library: MediaLibrary) {
    setFolder("");
    const paths = drafts.map((draft) => draft.sourceImagePath);
    setDrafts((current) => current.map((draft) => makeDraft(draft.sourceImagePath, library)));
    setIndex(0);
    setError(null);
    prefillCaptureDates(paths, library);
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

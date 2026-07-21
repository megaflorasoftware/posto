import { useState } from "react";
import { astroEntryId } from "@posto/core/astro/collections";
import {
  MediaPlanError,
  matchesImageLibraryPath,
  planMediaImport,
  type MediaImportPlan,
} from "@posto/core/astro/imageLibrary";
import type { AstroImageLibrary, ImageLibraryMetadataExtension } from "@posto/core/pagescms/config";
import {
  importImageLibraryAsset,
  invoke,
  openImageFiles,
  type FileEntry,
  type ImageLibraryImportResult,
} from "@posto/ipc";

export interface ImageLibraryImportDraft {
  sourceImagePath: string;
  filename: string;
  metadata: Record<string, unknown>;
  metadataExtension?: ImageLibraryMetadataExtension;
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
  library: AstroImageLibrary,
): ImageLibraryMetadataExtension | undefined {
  if (library.metadataExtensions.length === 1) return library.metadataExtensions[0];
  return library.metadataExtensions.includes("yaml") ? "yaml" : undefined;
}

function makeDraft(sourceImagePath: string, library: AstroImageLibrary): ImageLibraryImportDraft {
  return {
    sourceImagePath,
    filename: sourceStem(sourceImagePath),
    metadata: {},
    metadataExtension: defaultMetadataExtension(library),
  };
}

/** Drives a multi-image import into one library: a single chosen location
 * shared by every image, plus a per-image draft (filename + metadata) the
 * caller pages through. `execute` imports the drafts in order and drops the
 * ones that land so a retry after a mid-batch failure never double-writes. */
export function useImageLibraryImport(input: {
  root: string;
  library: AstroImageLibrary;
  initialSources?: string[];
  onImported?: (result: ImageLibraryImportResult) => void;
}) {
  const [folder, setFolder] = useState("");
  const [drafts, setDrafts] = useState<ImageLibraryImportDraft[]>(() =>
    (input.initialSources ?? []).map((path) => makeDraft(path, input.library)),
  );
  const [index, setIndex] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setSources(paths: string[]) {
    setDrafts(paths.map((path) => makeDraft(path, input.library)));
    setIndex(0);
    setError(null);
  }

  function updateDraft(
    at: number,
    update: (draft: ImageLibraryImportDraft) => ImageLibraryImportDraft,
  ) {
    setDrafts((current) => current.map((draft, i) => (i === at ? update(draft) : draft)));
  }

  async function chooseSources(): Promise<string[]> {
    return openImageFiles();
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
      metadata: draft.metadata,
      metadataExtension: draft.metadataExtension,
      existingPaths: files.map((file) => file.path),
      existingEntryIds: files
        .filter(
          (file) =>
            metadataExts.has(
              file.name.split(".").pop()?.toLowerCase() as ImageLibraryMetadataExtension,
            ) && matchesImageLibraryPath(input.library, file.path.slice(prefix.length)),
        )
        .map((file) => astroEntryId(file.path.slice(prefix.length))),
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
    try {
      for (const draft of drafts) {
        const operation = await plan(draft);
        const result = await importImageLibraryAsset({
          libraryRoot: operation.libraryRoot,
          sourceImagePath: operation.sourceImagePath,
          destinationImagePath: operation.destinationImagePath,
          destinationMetadataPath: operation.destinationMetadataPath,
          serializedMetadata: operation.serializedMetadata,
          entryId: operation.entryId,
        });
        input.onImported?.(result);
        imported += 1;
      }
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
    updateDraft,
    chooseSources,
    plan,
    execute,
    pending,
    error,
    setError,
  };
}

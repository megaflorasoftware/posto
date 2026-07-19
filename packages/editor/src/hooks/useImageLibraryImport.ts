import { useState } from "react";
import { astroEntryId } from "@posto/core/astro/collections";
import {
  MediaPlanError,
  planMediaImport,
  type MediaImportPlan,
} from "@posto/core/astro/imageLibrary";
import type { AstroImageLibrary, ImageLibraryMetadataExtension } from "@posto/core/pagescms/config";
import {
  importImageLibraryAsset,
  invoke,
  openImageFile,
  type FileEntry,
  type ImageLibraryImportResult,
} from "@posto/ipc";

export interface ImageLibraryImportDraft {
  sourceImagePath: string | null;
  folder: string;
  filename: string;
  metadata: Record<string, unknown>;
  metadataExtension?: ImageLibraryMetadataExtension;
}

export function useImageLibraryImport(input: {
  root: string;
  library: AstroImageLibrary;
  onImported?: (result: ImageLibraryImportResult) => void;
}) {
  const [draft, setDraft] = useState<ImageLibraryImportDraft>({
    sourceImagePath: null,
    folder: "",
    filename: "",
    metadata: {},
    metadataExtension: input.library.metadataExtensions.length === 1
      ? input.library.metadataExtensions[0]
      : undefined,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setSource(sourceImagePath: string) {
    setDraft((current) => ({
      ...current,
      sourceImagePath,
      filename: current.filename || sourceImagePath.split(/[\\/]/).pop() || "",
    }));
    setError(null);
  }

  async function chooseSource() {
    const path = await openImageFile();
    if (path) setSource(path);
  }

  async function plan(): Promise<MediaImportPlan> {
    if (!draft.sourceImagePath) {
      throw new MediaPlanError([{ code: "validation", message: "Choose an image to import." }]);
    }
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
      folder: draft.folder,
      filename: draft.filename || undefined,
      metadata: draft.metadata,
      metadataExtension: draft.metadataExtension,
      existingPaths: files.map((file) => file.path),
      existingEntryIds: files
        .filter((file) => metadataExts.has(file.name.split(".").pop()?.toLowerCase() as ImageLibraryMetadataExtension))
        .map((file) => astroEntryId(file.path.slice(prefix.length))),
    });
  }

  async function execute(): Promise<ImageLibraryImportResult | null> {
    setPending(true);
    setError(null);
    try {
      const operation = await plan();
      const result = await importImageLibraryAsset({
        libraryRoot: operation.libraryRoot,
        sourceImagePath: operation.sourceImagePath,
        destinationImagePath: operation.destinationImagePath,
        destinationMetadataPath: operation.destinationMetadataPath,
        serializedMetadata: operation.serializedMetadata,
        entryId: operation.entryId,
      });
      input.onImported?.(result);
      return result;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally {
      setPending(false);
    }
  }

  return { draft, setDraft, setSource, chooseSource, plan, execute, pending, error };
}

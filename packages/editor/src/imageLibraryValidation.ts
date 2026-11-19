import type { MediaLibrary } from "@posto/core/pagescms/config";
import { imageFields } from "@posto/core/posto/annotations";
import {
  dataDocumentFormat,
  parseDataDocument,
  serializeDataDocument,
  setDataValue,
} from "@posto/core/project/dataDocument";
import {
  imageDetailUpdates,
  type ImageDetails,
  type ImageLibraryAsset,
} from "@posto/core/project/mediaLibrary";
import { invoke, readImageDetails, readRemoteImageDetails } from "@posto/ipc";
import { mapWithConcurrency } from "./imageLibraryReferences";
import { valueAtPath } from "./imageLibraryMetadata";

const CONCURRENCY = 4;

export interface ImageLibraryValidation {
  updated: string[];
  unchanged: number;
  failed: Array<{ entryId: string; message: string }>;
}

/** Whether the library has fields Posto controls from the image (`value=`). */
export function hasLockedImageFields(library: MediaLibrary): boolean {
  return imageFields(library.fields, library.imageFieldPath).some(({ source }) => source.locked);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function detailsFor(library: MediaLibrary, asset: ImageLibraryAsset): Promise<ImageDetails> {
  if (asset.imagePath) return readImageDetails(asset.imagePath);
  if (!asset.imageUrl) throw new Error("This entry has no image.");
  const needsDate = imageFields(library.fields, library.imageFieldPath).some(
    ({ source }) => source.locked && source.value === "capture-date",
  );
  return readRemoteImageDetails(asset.imageUrl, needsDate);
}

/** Sets every locked (`value=`) field of the given entries from their image,
 * for example after a schema starts locking a field. Entries that already
 * match are left untouched, and failures don't stop the rest. */
export async function validateImageLibraryAssets(input: {
  library: MediaLibrary;
  assets: ImageLibraryAsset[];
  onProgress?: (done: number, total: number) => void;
}): Promise<ImageLibraryValidation> {
  let done = 0;
  const outcomes = await mapWithConcurrency(
    input.assets,
    CONCURRENCY,
    async (asset): Promise<"updated" | "unchanged" | { message: string }> => {
      try {
        const details = await detailsFor(input.library, asset);
        const changes = imageDetailUpdates(input.library, asset.metadata, details, {
          lockedOnly: true,
        }).filter(({ path, value }) => valueAtPath(asset.metadata, path) !== value);
        if (changes.length === 0) return "unchanged";
        const format = dataDocumentFormat(asset.metadataPath);
        if (!format) throw new Error("Its metadata format isn't supported.");
        const parsed = parseDataDocument(asset.metadataSource, format);
        if (parsed.error) throw new Error(parsed.error);
        for (const { path, value } of changes) setDataValue(parsed, path, value);
        await invoke("write_text_file", {
          path: asset.metadataPath,
          content: serializeDataDocument(parsed),
        });
        return "updated";
      } catch (error) {
        return { message: errorText(error) };
      } finally {
        done += 1;
        input.onProgress?.(done, input.assets.length);
      }
    },
  );
  // Reported in the order the entries were chosen, however they finished.
  const result: ImageLibraryValidation = { updated: [], unchanged: 0, failed: [] };
  outcomes.forEach((outcome, index) => {
    const { entryId } = input.assets[index];
    if (outcome === "updated") result.updated.push(entryId);
    else if (outcome === "unchanged") result.unchanged += 1;
    else result.failed.push({ entryId, message: outcome.message });
  });
  return result;
}

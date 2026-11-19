import { plainDateField, type MediaLibrary } from "@posto/core/pagescms/config";
import { imageFields } from "@posto/core/posto/annotations";
import {
  dataDocumentFormat,
  parseDataDocument,
  serializeDataDocument,
  setDataValue,
} from "@posto/core/project/dataDocument";
import {
  imageDetailTargets,
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

/** Whether the library has fields that take a value from the image. */
export function hasImageDetailFields(library: MediaLibrary): boolean {
  return imageFields(library.fields, library.imageFieldPath).length > 0;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function detailsFor(asset: ImageLibraryAsset, needsDate: boolean): Promise<ImageDetails> {
  if (asset.imagePath) return readImageDetails(asset.imagePath);
  if (!asset.imageUrl) throw new Error("This entry has no image.");
  return readRemoteImageDetails(asset.imageUrl, needsDate);
}

/** Brings entries up to date with their schema after it changes: sets every
 * locked (`value=`) field from the image, and fills `initial=` fields whose
 * key the entry doesn't have. A key that's present but empty stays empty.
 * Entries that already match are left untouched, and failures don't stop
 * the rest. */
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
        const targets = imageDetailTargets(input.library, asset.metadata, "when-missing");
        if (targets.length === 0) return "unchanged";
        const needsDate = targets.some(({ source }) => source.value === "capture-date");
        // Schema dates stay unquoted so Astro reads them as dates.
        const dateFields = new Set(
          targets.filter(({ field }) => plainDateField(field)).map(({ path }) => path.join(".")),
        );
        const details = await detailsFor(asset, needsDate);
        const changes = imageDetailUpdates(
          input.library,
          asset.metadata,
          details,
          "when-missing",
        ).filter(({ path, value }) => valueAtPath(asset.metadata, path) !== value);
        if (changes.length === 0) return "unchanged";
        const format = dataDocumentFormat(asset.metadataPath);
        if (!format) throw new Error("Its metadata format isn't supported.");
        const parsed = parseDataDocument(asset.metadataSource, format);
        if (parsed.error) throw new Error(parsed.error);
        for (const { path, value } of changes) {
          setDataValue(parsed, path, value, { dateField: dateFields.has(path.join(".")) });
        }
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

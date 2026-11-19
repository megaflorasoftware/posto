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
import {
  cdnObjectForUrl,
  derivedImageSizes,
  srcsetFor,
  type CdnSource,
} from "@posto/core/media/sources";
import type { AnnotatedField } from "@posto/core/posto/annotations";
import {
  deriveRemoteMedia,
  invoke,
  mediaPlaceholder,
  readImageDetails,
  readRemoteImageDetails,
} from "@posto/ipc";
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

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
  bmp: "image/bmp",
};

function contentTypeOf(key: string): string {
  return CONTENT_TYPES[key.split(".").pop()?.toLowerCase() ?? ""] ?? "";
}

const wants = (targets: AnnotatedField[], value: string) =>
  targets.some(({ source }) => source.value === value);

/** Sizes and placeholders of CDN images are made by uploading to the CDN. */
function needsCdn(targets: AnnotatedField[]): boolean {
  return wants(targets, "srcset") || wants(targets, "placeholder");
}

/** The CDN sources validating these entries will upload to, which need a
 * saved password first. */
export function validationSources(
  library: MediaLibrary,
  assets: ImageLibraryAsset[],
  sources: CdnSource[],
): CdnSource[] {
  const used = new Map<string, CdnSource>();
  for (const asset of assets) {
    if (!asset.imageUrl || !needsCdn(imageDetailTargets(library, asset.metadata, "when-missing")))
      continue;
    const object = cdnObjectForUrl(sources, asset.imageUrl);
    if (object) used.set(object.source.name, object.source);
  }
  return [...used.values()];
}

async function detailsFor(
  asset: ImageLibraryAsset,
  targets: AnnotatedField[],
  sources: CdnSource[],
): Promise<ImageDetails> {
  if (asset.imagePath) {
    const details = await readImageDetails(asset.imagePath);
    // Sizes are made when the image is uploaded, so a local one only gets
    // its placeholder.
    const placeholder = wants(targets, "placeholder")
      ? await mediaPlaceholder(asset.imagePath)
      : null;
    return { ...details, placeholder };
  }
  if (!asset.imageUrl) throw new Error("This entry has no image.");
  const details = await readRemoteImageDetails(asset.imageUrl, wants(targets, "capture-date"));
  if (!needsCdn(targets)) return details;
  const object = cdnObjectForUrl(sources, asset.imageUrl);
  if (!object) throw new Error("Its image isn't on one of this site's CDN sources.");
  const images = object.source.images;
  const sizes = wants(targets, "srcset")
    ? derivedImageSizes(object.source, object.key, contentTypeOf(object.key), details.dimensions)
    : [];
  const made = await deriveRemoteMedia({
    source: object.source,
    key: object.key,
    url: asset.imageUrl,
    ...(images && sizes.length > 0
      ? { derived: { format: images.format, quality: images.quality, sizes } }
      : {}),
    placeholder: wants(targets, "placeholder"),
  });
  return {
    ...details,
    srcset: sizes.length > 0 ? srcsetFor(object.source, sizes) : null,
    placeholder: made.placeholder,
  };
}

/** Brings entries up to date with their schema after it changes: sets every
 * locked (`value=`) field from the image, and fills `initial=` fields whose
 * key the entry doesn't have. A key that's present but empty stays empty.
 * Entries that already match are left untouched, and failures don't stop
 * the rest. */
export async function validateImageLibraryAssets(input: {
  library: MediaLibrary;
  assets: ImageLibraryAsset[];
  /** The site's CDN sources, for images already uploaded. */
  sources?: CdnSource[];
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
        // Schema dates stay unquoted so Astro reads them as dates.
        const dateFields = new Set(
          targets.filter(({ field }) => plainDateField(field)).map(({ path }) => path.join(".")),
        );
        const details = await detailsFor(asset, targets, input.sources ?? []);
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

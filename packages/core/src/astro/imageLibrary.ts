import YAML from "yaml";
import picomatch from "picomatch";
import type { AstroImageLibrary, Field, ImageLibraryMetadataExtension } from "../pagescms/config";
import { validateForm } from "../pagescms/validate";
import { astroEntryId } from "./collections";

export const IMAGE_LIBRARY_EXTENSIONS = [
  "avif",
  "gif",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "tif",
  "tiff",
  "webp",
] as const;

export type ImageLibraryHealth =
  | "valid"
  | "missing-image"
  | "malformed-image"
  | "external-image"
  | "duplicate-entry-id"
  | "shared-image";

export interface ImageLibraryAsset {
  libraryId: string;
  entryId: string;
  metadataPath: string;
  imagePath: string | null;
  metadata: Record<string, unknown>;
  metadataSource: string;
  health: ImageLibraryHealth[];
}

export interface ImageLibraryMetadataFile {
  path: string;
  content: string;
}

export interface MediaPlanIssue {
  code:
    | "ambiguous-metadata-format"
    | "collision"
    | "excluded-by-pattern"
    | "external-path"
    | "invalid-filename"
    | "unsupported-image"
    | "validation";
  message: string;
  path?: string;
}

export class MediaPlanError extends Error {
  constructor(public readonly issues: MediaPlanIssue[]) {
    super(issues.map((issue) => issue.message).join("\n"));
    this.name = "MediaPlanError";
  }
}

export interface MediaImportPlan {
  library: AstroImageLibrary;
  libraryRoot: string;
  repositoryRoot: string;
  sourceImagePath: string;
  destinationImagePath: string;
  destinationMetadataPath: string;
  entryId: string;
  metadata: Record<string, unknown>;
  serializedMetadata: string;
}

export interface PlanMediaImportInput {
  library: AstroImageLibrary;
  repositoryRoot: string;
  sourceImagePath: string;
  folder?: string;
  filename?: string;
  metadata?: Record<string, unknown>;
  metadataExtension?: ImageLibraryMetadataExtension;
  existingPaths?: Iterable<string>;
  existingEntryIds?: Iterable<string>;
}

function slash(path: string): string {
  return path.replace(/\\/g, "/");
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(slash(path));
}

function normalize(path: string): string {
  const source = slash(path);
  const prefix = source.startsWith("/") ? "/" : (source.match(/^[A-Za-z]:\//)?.[0] ?? "");
  const parts: string[] = [];
  for (const part of source.slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return prefix + parts.join("/");
}

function join(...parts: string[]): string {
  let result = "";
  for (const part of parts) {
    if (!part) continue;
    result = isAbsolute(part) ? part : result ? `${result}/${part}` : part;
  }
  return normalize(result);
}

function dirname(path: string): string {
  const normalized = normalize(path);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? (normalized.startsWith("/") ? "/" : "") : normalized.slice(0, index);
}

function basename(path: string): string {
  return slash(path).split("/").pop() ?? "";
}

function extension(path: string): string {
  return (
    basename(path)
      .match(/\.([^.]+)$/)?.[1]
      ?.toLowerCase() ?? ""
  );
}

function relative(from: string, to: string): string | null {
  const root = normalize(from).replace(/\/$/, "");
  const target = normalize(to);
  if (target === root) return "";
  return target.startsWith(root + "/") ? target.slice(root.length + 1) : null;
}

function libraryRoot(library: AstroImageLibrary, repositoryRoot: string): string {
  return join(repositoryRoot, library.base);
}

/** Applies Astro glob-loader include/exclude patterns to a base-relative path.
 * A managed import must create metadata that the collection will actually load. */
export function matchesImageLibraryPath(library: AstroImageLibrary, relativePath: string): boolean {
  const path = slash(relativePath).replace(/^\/+/, "");
  const includes = library.patterns.filter((pattern) => !pattern.startsWith("!"));
  const excludes = library.patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1));
  return (
    includes.some((pattern) => picomatch(pattern, { dot: false })(path)) &&
    !excludes.some((pattern) => picomatch(pattern, { dot: false })(path))
  );
}

export interface ImageLibraryLocation {
  library: AstroImageLibrary;
  /** Base-relative folder limiting the picker; empty means the whole library. */
  subset: string;
}

function normalizedRelativePath(path: string): string {
  return slash(path)
    .replace(/^\.\//, "")
    .replace(/^\/+|\/+$/g, "");
}

/** Resolves a configured media directory to a discovered library or one of
 * its included subfolders. Paths excluded by the Astro glob are rejected. */
export function resolveImageLibraryLocation(
  libraries: AstroImageLibrary[],
  mediaDirectory: string,
): ImageLibraryLocation | null {
  const input = normalizedRelativePath(mediaDirectory);
  const candidates = libraries
    .map((library) => ({ library, base: normalizedRelativePath(library.base) }))
    .filter(({ base }) => input === base || input.startsWith(`${base}/`))
    .sort((left, right) => right.base.length - left.base.length);
  for (const { library, base } of candidates) {
    const subset = input === base ? "" : input.slice(base.length + 1);
    if (subset === "") return { library, subset };
    const extension = library.metadataExtensions[0];
    const probeFolder = subset.replace(/\{[^}]+\}/g, "posto");
    if (matchesImageLibraryPath(library, `${probeFolder}/__posto__.${extension}`)) {
      return { library, subset };
    }
  }
  return null;
}

export function imageLibraryContainsAsset(
  library: AstroImageLibrary,
  repositoryRoot: string,
  asset: ImageLibraryAsset,
  subset: string,
): boolean {
  if (subset === "") return true;
  const root = libraryRoot(library, repositoryRoot);
  const metadata = relative(root, asset.metadataPath);
  const folder = normalizedRelativePath(subset);
  return metadata !== null && (metadata === folder || metadata.startsWith(`${folder}/`));
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function valueAt(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!record(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function setAt(target: Record<string, unknown>, path: string[], value: unknown): void {
  let current = target;
  path.forEach((segment, index) => {
    if (index === path.length - 1) current[segment] = value;
    else {
      if (!record(current[segment])) current[segment] = {};
      current = current[segment] as Record<string, unknown>;
    }
  });
}

function metadataFormat(path: string): ImageLibraryMetadataExtension | null {
  const ext = extension(path);
  return ext === "json" || ext === "yaml" || ext === "yml" ? ext : null;
}

export function parseImageLibraryMetadata(
  content: string,
  format: ImageLibraryMetadataExtension,
): Record<string, unknown> | null {
  try {
    const value = format === "json" ? JSON.parse(content) : YAML.parse(content);
    return record(value) ? value : null;
  } catch {
    return null;
  }
}

export function serializeImageLibraryMetadata(
  metadata: Record<string, unknown>,
  format: ImageLibraryMetadataExtension,
): string {
  return format === "json"
    ? JSON.stringify(metadata, null, 2) + "\n"
    : YAML.stringify(metadata, { lineWidth: 0 });
}

/** Discovers pairs from metadata contents. `existingPaths` should contain the
 * repository's image files; matching basenames are never assumed. */
export function discoverImageLibraryAssets(
  library: AstroImageLibrary,
  repositoryRoot: string,
  metadataFiles: ImageLibraryMetadataFile[],
  existingPaths: Iterable<string>,
): ImageLibraryAsset[] {
  const root = libraryRoot(library, repositoryRoot);
  const existing = new Set([...existingPaths].map(normalize));
  const assets = metadataFiles.flatMap((file): ImageLibraryAsset[] => {
    const path = normalize(file.path);
    const rel = relative(root, path);
    const format = metadataFormat(path);
    if (
      rel === null ||
      !format ||
      !library.metadataExtensions.includes(format) ||
      !matchesImageLibraryPath(library, rel)
    )
      return [];
    const metadata = parseImageLibraryMetadata(file.content, format);
    const id = astroEntryId(rel);
    if (!metadata) {
      return [
        {
          libraryId: library.collection,
          entryId: id,
          metadataPath: path,
          imagePath: null,
          metadata: {},
          metadataSource: file.content,
          health: ["malformed-image"],
        },
      ];
    }
    const imageValue = valueAt(metadata, library.imageFieldPath);
    if (typeof imageValue !== "string" || imageValue.trim() === "") {
      return [
        {
          libraryId: library.collection,
          entryId: id,
          metadataPath: path,
          imagePath: null,
          metadata,
          metadataSource: file.content,
          health: ["malformed-image"],
        },
      ];
    }
    const imagePath = isAbsolute(imageValue)
      ? normalize(imageValue)
      : join(dirname(path), imageValue);
    const health: ImageLibraryHealth[] = [];
    if (relative(root, imagePath) === null) health.push("external-image");
    else if (!existing.has(imagePath)) health.push("missing-image");
    return [
      {
        libraryId: library.collection,
        entryId: id,
        metadataPath: path,
        imagePath,
        metadata,
        metadataSource: file.content,
        health: health.length ? health : ["valid"],
      },
    ];
  });

  const ids = new Map<string, ImageLibraryAsset[]>();
  const images = new Map<string, ImageLibraryAsset[]>();
  for (const asset of assets) {
    (ids.get(asset.entryId) ?? (ids.set(asset.entryId, []), ids.get(asset.entryId)!)).push(asset);
    if (asset.imagePath)
      (
        images.get(asset.imagePath) ??
        (images.set(asset.imagePath, []), images.get(asset.imagePath)!)
      ).push(asset);
  }
  for (const group of ids.values())
    if (group.length > 1) {
      for (const asset of group)
        asset.health = [...asset.health.filter((state) => state !== "valid"), "duplicate-entry-id"];
    }
  for (const group of images.values())
    if (group.length > 1) {
      for (const asset of group)
        asset.health = [...asset.health.filter((state) => state !== "valid"), "shared-image"];
    }
  return assets;
}

function defaults(fields: Field[], supplied: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...supplied };
  for (const field of fields) {
    if (result[field.name] === undefined && field.default !== undefined)
      result[field.name] = field.default;
    if (field.type === "object") {
      const child = record(result[field.name])
        ? (result[field.name] as Record<string, unknown>)
        : {};
      const withDefaults = defaults(field.fields ?? [], child);
      if (Object.keys(withDefaults).length > 0) result[field.name] = withDefaults;
    }
  }
  return result;
}

function normalizedFilename(requested: string): string | null {
  const justName = basename(requested)
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-");
  return justName && justName !== "." && justName !== ".." && !justName.startsWith(".")
    ? justName
    : null;
}

/** Produces a deterministic, validated import plan without touching disk. */
export function planMediaImport(input: PlanMediaImportInput): MediaImportPlan {
  const issues: MediaPlanIssue[] = [];
  const root = libraryRoot(input.library, input.repositoryRoot);
  const sourceExt = extension(input.sourceImagePath);
  if (!(IMAGE_LIBRARY_EXTENSIONS as readonly string[]).includes(sourceExt)) {
    issues.push({
      code: "unsupported-image",
      message: `Unsupported image extension: ${sourceExt || "none"}`,
    });
  }
  const requested = input.filename ?? basename(input.sourceImagePath);
  const filename = normalizedFilename(requested);
  if (!filename || extension(filename) !== sourceExt) {
    issues.push({
      code: "invalid-filename",
      message: "The destination filename must retain the source image extension.",
    });
  }
  const folder = normalize(input.folder ?? "");
  if (isAbsolute(input.folder ?? "") || (input.folder ?? "").split(/[\\/]/).includes("..")) {
    issues.push({
      code: "external-path",
      message: "The destination folder must stay inside the image library.",
    });
  }
  const format =
    input.metadataExtension ??
    (input.library.metadataExtensions.length === 1 ? input.library.metadataExtensions[0] : null);
  if (!format || !input.library.metadataExtensions.includes(format)) {
    issues.push({
      code: "ambiguous-metadata-format",
      message: "Choose one of the library's supported metadata formats.",
    });
  }
  if (issues.length || !filename || !format) throw new MediaPlanError(issues);

  const stem = filename.slice(0, -(sourceExt.length + 1));
  const imagePath = join(root, folder, filename);
  const metadataPath = join(root, folder, `${stem}.${format}`);
  if (relative(root, imagePath) === null || relative(root, metadataPath) === null) {
    throw new MediaPlanError([
      { code: "external-path", message: "Planned files must stay inside the image library." },
    ]);
  }
  const relativeMetadataPath = relative(root, metadataPath)!;
  if (!matchesImageLibraryPath(input.library, relativeMetadataPath)) {
    issues.push({
      code: "excluded-by-pattern",
      message: `The destination is not included by the ${input.library.collection} collection's glob patterns.`,
      path: relativeMetadataPath,
    });
  }
  const existingPaths = new Set([...(input.existingPaths ?? [])].map(normalize));
  for (const path of [imagePath, metadataPath])
    if (existingPaths.has(path)) {
      issues.push({ code: "collision", message: `File already exists: ${path}`, path });
    }
  const entryId = astroEntryId(relativeMetadataPath);
  if (new Set(input.existingEntryIds ?? []).has(entryId)) {
    issues.push({ code: "collision", message: `Astro entry ID already exists: ${entryId}` });
  }
  const metadata = defaults(input.library.fields, input.metadata ?? {});
  setAt(metadata, input.library.imageFieldPath, `./${filename}`);
  for (const [path, message] of validateForm(input.library.fields, metadata)) {
    issues.push({ code: "validation", message, path });
  }
  if (issues.length) throw new MediaPlanError(issues);
  return {
    library: input.library,
    libraryRoot: root,
    repositoryRoot: normalize(input.repositoryRoot),
    sourceImagePath: normalize(input.sourceImagePath),
    destinationImagePath: imagePath,
    destinationMetadataPath: metadataPath,
    entryId,
    metadata,
    serializedMetadata: serializeImageLibraryMetadata(metadata, format),
  };
}

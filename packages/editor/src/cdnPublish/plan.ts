import {
  cdnObjectKey,
  cdnObjectUrl,
  isRemoteMediaUrl,
  type CdnSource,
} from "@posto/core/media/sources";
import {
  expandMediaEntry,
  mediaInputPath,
  mediaOutputPath,
  resolveMedia,
  resolveMediaForValue,
  resolveRelativeMediaPath,
  type ContentEntry,
  type Field,
  type MediaEntry,
  type MediaLibrary,
  type PagesConfig,
} from "@posto/core/pagescms/config";
import {
  parseFile,
  serializeFile,
  setValue,
  type ValuePath,
} from "@posto/core/pagescms/frontmatter";
import {
  dataDocumentEntries,
  dataDocumentFormat,
  dataEntryValues,
  parseDataDocument,
  serializeDataDocument,
  setDataValue,
} from "@posto/core/project/dataDocument";
import {
  discoverImageLibraryAssets,
  imageDetailUpdates,
  imageDimensionFields,
  type ImageLibraryAsset,
} from "@posto/core/project/mediaLibrary";
import {
  inspectMediaFile,
  invoke,
  pendingMediaDeletes,
  type FileEntry,
  type FileGroup,
  type MediaFileInspection,
} from "@posto/ipc";
import { normalizeFilePath } from "../filePaths";
import {
  entryForPath,
  isImageValueField,
  mapWithConcurrency,
  rewriteMarkdownMediaDestinations,
} from "../imageLibraryReferences";
import { markdownMediaKind, markdownMediaOutputPath } from "../markdownMedia";

const INSPECT_CONCURRENCY = 4;
const READ_CONCURRENCY = 8;
/** Text formats that can reference an image outside the fields Posto rewrites. */
const REFERENCE_EXTENSIONS = [
  "astro",
  "cjs",
  "css",
  "html",
  "js",
  "json",
  "jsx",
  "less",
  "markdown",
  "md",
  "mdx",
  "mjs",
  "njk",
  "sass",
  "scss",
  "svelte",
  "toml",
  "ts",
  "tsx",
  "vue",
  "yaml",
  "yml",
];
const CONTENT_CONFIG_PATHS = [
  "src/content.config.ts",
  "src/content.config.mts",
  "src/content.config.js",
  "src/content.config.mjs",
  "src/content/config.ts",
  "src/content/config.mts",
  "src/content/config.js",
  "src/content/config.mjs",
];

export interface CdnUpload {
  sourceName: string;
  /** Absolute path of the local image. */
  path: string;
  key: string;
  url: string;
  sha256: string;
  size: number;
  contentType: string;
}

/** A CDN object whose library entry was deleted, removed after Publish lands. */
export interface CdnDelete {
  sourceName: string;
  key: string;
  url: string;
}

export interface CdnPlanWrite {
  path: string;
  previous: string;
  content: string;
}

export interface CdnPlanWarning {
  path: string;
  message: string;
}

/** Everything Publish would change. Building a plan changes nothing. */
export interface CdnPublishPlan {
  uploads: CdnUpload[];
  writes: CdnPlanWrite[];
  /** Local images that are safe to remove once their uploads are committed. */
  removals: string[];
  deletes: CdnDelete[];
  warnings: CdnPlanWarning[];
  /** Problems that must be fixed before Publish can continue. */
  blockers: string[];
  /** Collections publishing CDN images for the first time. Their templates
   * start receiving URL strings instead of local image metadata. */
  firstMigrations: string[];
}

interface PendingImage {
  path: string;
  source: CdnSource;
  folder: string;
  /** Whether the file lives in the location owned by the CDN source. */
  managed: boolean;
}

interface LibraryImage {
  library: MediaLibrary;
  asset: ImageLibraryAsset;
  previous: string;
}

interface ContentDocument {
  path: string;
  entry: ContentEntry;
  previous: string;
}

interface DocumentRecord {
  values: Record<string, unknown>;
  basePath: ValuePath;
}

/** One parsed content file, whether Markdown frontmatter or a data document. */
interface OpenDocument {
  records: DocumentRecord[];
  set: (path: ValuePath, value: string) => void;
  body: string | null;
  setBody: (body: string) => void;
  serialize: () => string;
}

interface PlanContext {
  root: string;
  config: PagesConfig;
  sources: Map<string, CdnSource>;
  /** Collections with images about to move, and those already on a CDN. */
  migrating: Set<string>;
  published: Set<string>;
  /** CDN URLs still used by a library entry, which must never be deleted. */
  liveUrls: Set<string>;
}

function inside(root: string, path: string): string | null {
  const base = normalizeFilePath(root).replace(/\/+$/, "");
  const target = normalizeFilePath(path);
  return target.startsWith(`${base}/`) ? target.slice(base.length + 1) : null;
}

function directoryOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function basename(path: string): string {
  return normalizeFilePath(path).split("/").pop() ?? path;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function libraryMedia(library: MediaLibrary): MediaEntry {
  const input = library.base.replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
  return { name: `library:${library.collection}`, input, output: `/${input}` };
}

function addPending(pending: Map<string, PendingImage>, image: PendingImage): void {
  if (!pending.has(image.path)) pending.set(image.path, image);
}

function usesCdnBinding(fields: Field[]): boolean {
  return fields.some(
    (field) => typeof field.options?.mediaSource === "string" || usesCdnBinding(field.fields ?? []),
  );
}

/** A schema can name a CDN source that this device can't read, such as on iOS
 * when generated schemas aren't committed. Publishing then would skip uploads. */
async function unreadableBindingBlockers(context: PlanContext): Promise<string[]> {
  const { config, root } = context;
  const resolved =
    (config.mediaLibraries ?? []).some((library) => library.mediaSource) ||
    config.content.some((entry) => usesCdnBinding(entry.fields));
  if (resolved) return [];
  for (const path of CONTENT_CONFIG_PATHS) {
    const source = await invoke<string | null>("read_text_file_optional", {
      path: `${root}/${path}`,
    });
    if (source?.includes("value=posto.media.")) {
      return [
        `${path} assigns images to a CDN source, but Posto can't read this site's generated schemas. Run the site once and commit .astro/collections, then publish again.`,
      ];
    }
  }
  return [];
}

async function collectLibraryImages(
  context: PlanContext,
  pending: Map<string, PendingImage>,
): Promise<LibraryImage[]> {
  const images: LibraryImage[] = [];
  for (const library of context.config.mediaLibraries ?? []) {
    const source = library.mediaSource ? context.sources.get(library.mediaSource) : undefined;
    if (!source) continue;
    const libraryRoot = `${context.root}/${library.base}`;
    const files = await invoke<FileEntry[] | null>("list_dir_files_optional", {
      dir: libraryRoot,
      extensions: [],
    });
    if (!files) continue;
    const metadataFiles = files.filter((file) =>
      (library.metadataExtensions as string[]).includes(
        file.name.split(".").pop()?.toLowerCase() ?? "",
      ),
    );
    const documents = await mapWithConcurrency(metadataFiles, READ_CONCURRENCY, async (file) => ({
      path: file.path,
      content: await invoke<string>("read_text_file", { path: file.path }),
    }));
    const assets = discoverImageLibraryAssets(
      library,
      context.root,
      documents,
      files.map((file) => file.path),
    );
    for (const asset of assets) {
      if (asset.imageUrl) {
        context.published.add(library.collection);
        context.liveUrls.add(asset.imageUrl);
      }
      if (!asset.imagePath || asset.health.includes("missing-image")) continue;
      context.migrating.add(library.collection);
      const relative = inside(libraryRoot, asset.imagePath);
      addPending(pending, {
        path: asset.imagePath,
        source,
        folder: directoryOf(relative ?? ""),
        managed: relative !== null,
      });
      images.push({ library, asset, previous: asset.metadataSource });
    }
  }
  return images;
}

/** A Pages CMS media entry named after a CDN source hands that whole folder to
 * the CDN, matching how its picker offers every file inside. */
async function collectMediaSourceImages(
  context: PlanContext,
  pending: Map<string, PendingImage>,
): Promise<void> {
  for (const media of context.config.media) {
    const source = context.sources.get(media.name);
    if (!source || media.relative) continue;
    const input = `${context.root}/${media.input}`;
    const files = await invoke<FileEntry[] | null>("list_dir_files_optional", {
      dir: input,
      extensions: [],
    });
    for (const file of files ?? []) {
      if (markdownMediaKind(file.path) !== "image") continue;
      const relative = inside(input, file.path) ?? file.name;
      addPending(pending, {
        path: normalizeFilePath(file.path),
        source,
        folder: directoryOf(relative),
        managed: true,
      });
    }
  }
}

/** Recorded deletes whose object no remaining library entry uses. A delete for
 * a source this device can't see stays recorded for later. */
async function collectDeletes(context: PlanContext): Promise<CdnDelete[]> {
  const intents = await pendingMediaDeletes(context.root);
  return intents
    .filter((intent) => context.sources.has(intent.sourceName))
    .filter((intent) => !context.liveUrls.has(intent.url))
    .map(({ sourceName, key, url }) => ({ sourceName, key, url }));
}

async function readDocuments(
  context: PlanContext,
  groups: FileGroup[],
): Promise<ContentDocument[]> {
  const paths = [...new Set(groups.flatMap((group) => group.files.map((file) => file.path)))];
  const candidates = paths.flatMap((path) => {
    const entry = entryForPath(context.config, context.root, path);
    return entry && (entry.dataFile || /\.(md|mdx|markdown)$/i.test(path)) ? [{ path, entry }] : [];
  });
  return mapWithConcurrency(candidates, READ_CONCURRENCY, async ({ path, entry }) => ({
    path,
    entry,
    previous: await invoke<string>("read_text_file", { path }),
  }));
}

function openDocument(document: ContentDocument): OpenDocument | { error: string } {
  const { entry, path, previous } = document;
  if (entry.dataFile) {
    const parsed = parseDataDocument(previous, entry.dataFile.format);
    if (parsed.error) return { error: `${path}: ${parsed.error}` };
    return {
      records: dataDocumentEntries(parsed).flatMap((locator) => {
        const values = dataEntryValues(parsed, locator);
        return values ? [{ values, basePath: locator.path }] : [];
      }),
      set: (valuePath, value) => setDataValue(parsed, valuePath, value),
      body: null,
      setBody: () => undefined,
      serialize: () => serializeDataDocument(parsed),
    };
  }
  const parsed = parseFile(previous);
  if (parsed.error) return { error: `${path}: ${parsed.error}` };
  return {
    records: [{ values: (parsed.doc.toJS() ?? {}) as Record<string, unknown>, basePath: [] }],
    set: (valuePath, value) => setValue(parsed.doc, valuePath, value),
    body: parsed.body,
    setBody: (body) => {
      parsed.body = body;
    },
    serialize: () => serializeFile(parsed),
  };
}

function valueAt(values: unknown, path: ValuePath): unknown {
  let value = values;
  for (const key of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}

/** Calls back for each string held by a media-capable field in a record. */
function visitImageValues(
  fields: Field[],
  record: DocumentRecord,
  visitor: (field: Field, path: ValuePath, value: string) => void,
): void {
  const visit = (field: Field, path: ValuePath, listItem = false) => {
    const value = valueAt(record.values, path.slice(record.basePath.length));
    if (field.list && !listItem) {
      if (Array.isArray(value)) {
        value.forEach((_item, index) => visit(field, [...path, index], true));
      }
      return;
    }
    if (field.fields?.length) {
      for (const child of field.fields) visit(child, [...path, child.name]);
      return;
    }
    if (typeof value === "string" && value !== "" && isImageValueField(field)) {
      visitor(field, path, value);
    }
  };
  for (const field of fields) {
    if (field.name !== "body") visit(field, [...record.basePath, field.name]);
  }
}

/** Local files a stored value could mean, most specific location first. */
function localCandidates(
  context: PlanContext,
  document: ContentDocument,
  field: Field,
  values: Record<string, unknown>,
  value: string,
): string[] {
  if (isRemoteMediaUrl(value)) return [];
  const { config, root } = context;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Malformed escapes remain literal filenames.
  }
  const media = [
    resolveMediaForValue(config, field, value, document.entry, values),
    resolveMedia(config, field, document.entry, values),
    ...config.media,
    ...(config.mediaLibraries ?? []).map(libraryMedia),
  ].filter((candidate): candidate is MediaEntry => candidate !== null);
  const candidates = media.flatMap((candidate) => {
    const path = mediaInputPath(root, candidate, decoded, document.path);
    return path ? [path] : [];
  });
  const fallback = decoded.startsWith("/")
    ? `${root}/public${decoded}`
    : resolveRelativeMediaPath(document.path, value);
  return [...new Set([...candidates, ...(fallback ? [fallback] : [])].map(normalizeFilePath))];
}

function boundSource(
  context: PlanContext,
  field: Field,
  entry: ContentEntry,
  values: Record<string, unknown>,
): CdnSource | null {
  if (field.type !== "image") return null;
  const name =
    typeof field.options?.mediaSource === "string"
      ? field.options.mediaSource
      : resolveMedia(context.config, field, entry, values)?.name;
  return (name ? context.sources.get(name) : undefined) ?? null;
}

/** Image fields bound to a CDN source upload whichever local file they use. */
async function collectFieldImages(
  context: PlanContext,
  documents: ContentDocument[],
  pending: Map<string, PendingImage>,
): Promise<void> {
  const found: Array<{ source: CdnSource; candidates: string[]; collection: string }> = [];
  for (const document of documents) {
    const open = openDocument(document);
    if ("error" in open) continue;
    for (const record of open.records) {
      visitImageValues(document.entry.fields, record, (field, _path, value) => {
        const source = boundSource(context, field, document.entry, record.values);
        if (!source) return;
        if (isRemoteMediaUrl(value)) context.published.add(document.entry.name);
        const candidates = localCandidates(context, document, field, record.values, value);
        if (candidates.length > 0) {
          found.push({ source, candidates, collection: document.entry.name });
        }
      });
    }
  }
  for (const { source, candidates, collection } of found) {
    for (const path of candidates) {
      if (!(await invoke<boolean>("path_exists", { path }))) continue;
      context.migrating.add(collection);
      const relative = inside(context.root, path) ?? basename(path);
      addPending(pending, {
        path,
        source,
        folder: directoryOf(relative.replace(/^(src|public)\//, "")),
        managed: inside(context.root, path) !== null,
      });
      break;
    }
  }
}

/** Every spelling a document might use for one local image. */
function bodyReplacements(
  context: PlanContext,
  document: ContentDocument,
  values: Record<string, unknown>,
  uploads: Map<string, CdnUpload>,
): Map<string, string> {
  const { config, root } = context;
  const media = [
    document.entry.media,
    ...config.media,
    ...(config.mediaLibraries ?? []).map(libraryMedia),
  ].flatMap((candidate) => {
    const expanded = candidate ? expandMediaEntry(candidate, values) : null;
    return expanded ? [expanded] : [];
  });
  const replacements = new Map<string, string>();
  const add = (destination: string | null, url: string) => {
    if (!destination) return;
    for (const spelling of [destination, encodeURI(destination)]) {
      replacements.set(spelling, url);
      if (spelling.startsWith("/")) replacements.set(spelling.slice(1), url);
      else if (!spelling.startsWith(".")) replacements.set(`./${spelling}`, url);
    }
  };
  for (const [path, upload] of uploads) {
    add(markdownMediaOutputPath(root, document.path, path), upload.url);
    for (const candidate of media) {
      add(mediaOutputPath(root, candidate, path, document.path), upload.url);
    }
  }
  return replacements;
}

/** Returns the rewritten file, or null when nothing in it refers to an upload.
 * Untouched files are never reserialized, which could reformat their YAML. */
function rewriteDocument(
  context: PlanContext,
  document: ContentDocument,
  open: OpenDocument,
  uploads: Map<string, CdnUpload>,
): string | null {
  let changed = false;
  for (const record of open.records) {
    const updates: Array<{ path: ValuePath; url: string }> = [];
    visitImageValues(document.entry.fields, record, (field, path, value) => {
      const candidates = localCandidates(context, document, field, record.values, value);
      const match = candidates.find((candidate) => uploads.has(candidate));
      if (match) updates.push({ path, url: uploads.get(match)!.url });
    });
    for (const update of updates) open.set(update.path, update.url);
    changed ||= updates.length > 0;
  }
  if (open.body !== null) {
    const values = open.records[0]?.values ?? {};
    const replacements = bodyReplacements(context, document, values, uploads);
    const body = rewriteMarkdownMediaDestinations(open.body, replacements);
    if (body.replacements > 0) {
      open.setBody(body.content);
      changed = true;
    }
  }
  return changed ? open.serialize() : null;
}

function fieldAtPath(fields: Field[], path: string[]): Field | undefined {
  let current = fields;
  let found: Field | undefined;
  for (const segment of path) {
    found = current.find((field) => field.name === segment);
    current = found?.fields ?? [];
  }
  return found;
}

/** Points a library entry at its uploaded image. Empty dimension fields are
 * filled too, since the original file leaves the device with this publish. */
function rewriteMetadata(
  image: LibraryImage,
  upload: CdnUpload,
  inspection: MediaFileInspection,
): { content: string } | { blocker: string } {
  const { asset, library } = image;
  const format = dataDocumentFormat(asset.metadataPath);
  if (!format) return { blocker: `${asset.metadataPath}: unsupported metadata format.` };
  const parsed = parseDataDocument(image.previous, format);
  if (parsed.error) return { blocker: `${asset.metadataPath}: ${parsed.error}` };
  setDataValue(parsed, library.imageFieldPath, upload.url);
  // Capture dates are only taken at import, so publishing fills dimensions.
  const details = { captureDate: null, dimensions: inspection.dimensions };
  for (const { path, value } of imageDetailUpdates(library, asset.metadata, details)) {
    setDataValue(parsed, path, value);
  }
  if (!inspection.dimensions) {
    const fields = imageDimensionFields(library);
    const missing = (fields ? [...fields.width, ...fields.height] : []).filter((path) => {
      const value = valueAt(asset.metadata, path);
      return value === undefined || value === null || value === "";
    });
    const required = missing.some((path) => fieldAtPath(library.fields, path)?.required === true);
    if (required) {
      return {
        blocker: `Posto couldn't read the dimensions of ${basename(upload.path)}, which ${library.collection} requires. Add its width and height, then publish again.`,
      };
    }
  }
  return { content: serializeDataDocument(parsed) };
}

/** Finds images something other than Posto's rewrites still refers to. */
async function stillReferenced(
  root: string,
  uploads: CdnUpload[],
  rewritten: Map<string, string>,
): Promise<Map<string, string>> {
  const files = await invoke<FileEntry[] | null>("list_dir_files_optional", {
    dir: root,
    extensions: REFERENCE_EXTENSIONS,
  });
  const contents = await mapWithConcurrency(files ?? [], READ_CONCURRENCY, async (file) => ({
    path: file.path,
    content:
      rewritten.get(file.path) ??
      (await invoke<string>("read_text_file", { path: file.path }).catch(() => "")),
  }));
  const references = new Map<string, string>();
  for (const upload of uploads) {
    const names = [basename(upload.path), encodeURIComponent(basename(upload.path))];
    const reference = contents.find(({ content }) => names.some((name) => content.includes(name)));
    if (reference) references.set(upload.path, reference.path);
  }
  return references;
}

/**
 * Works out what publishing CDN-bound media would do. Local images stay in the
 * working tree until Publish, so this reads them, computes their object keys
 * and URLs, and prepares every content rewrite without changing anything.
 */
export async function planCdnPublish(input: {
  root: string;
  config: PagesConfig;
  groups: FileGroup[];
}): Promise<CdnPublishPlan> {
  const context = planContext(input.root, input.config);
  const warnings: CdnPlanWarning[] = [];
  const empty = { uploads: [], writes: [], removals: [], deletes: [], firstMigrations: [] };
  // Without a defined source, annotated images simply stay local.
  if (context.sources.size === 0) return { ...empty, warnings, blockers: [] };
  const blockers = await unreadableBindingBlockers(context);

  const pending = new Map<string, PendingImage>();
  const libraryImages = await collectLibraryImages(context, pending);
  const deletes = await collectDeletes(context);
  await collectMediaSourceImages(context, pending);
  const documents = await readDocuments(context, input.groups);
  await collectFieldImages(context, documents, pending);

  const inspected = await mapWithConcurrency(
    [...pending.values()],
    INSPECT_CONCURRENCY,
    async (image) => {
      try {
        return { image, inspection: await inspectMediaFile(image.path) };
      } catch (error) {
        warnings.push({ path: image.path, message: `Skipped: ${errorText(error)}` });
        return null;
      }
    },
  );
  const uploads = new Map<string, CdnUpload>();
  const inspections = new Map<string, MediaFileInspection>();
  for (const result of inspected) {
    if (!result) continue;
    const { image, inspection } = result;
    const key = cdnObjectKey(image.source, image.folder, basename(image.path), inspection.sha256);
    uploads.set(image.path, {
      sourceName: image.source.name,
      path: image.path,
      key,
      url: cdnObjectUrl(image.source, key),
      sha256: inspection.sha256,
      size: inspection.size,
      contentType: inspection.contentType,
    });
    inspections.set(image.path, inspection);
  }
  if (uploads.size === 0) return { ...empty, deletes, warnings, blockers };

  const rewritten = new Map<string, string>();
  const previous = new Map<string, string>();
  for (const image of libraryImages) {
    const upload = uploads.get(image.asset.imagePath!);
    const inspection = inspections.get(image.asset.imagePath!);
    if (!upload || !inspection) continue;
    const result = rewriteMetadata(image, upload, inspection);
    if ("blocker" in result) {
      blockers.push(result.blocker);
      continue;
    }
    rewritten.set(image.asset.metadataPath, result.content);
    previous.set(image.asset.metadataPath, image.previous);
  }
  for (const document of documents) {
    const open = openDocument(document);
    if ("error" in open) {
      blockers.push(`Could not read ${open.error}`);
      continue;
    }
    const content = rewriteDocument(context, document, open, uploads);
    if (content !== null) {
      rewritten.set(document.path, content);
      previous.set(document.path, document.previous);
    }
  }

  const uploadList = [...uploads.values()].sort((a, b) => a.key.localeCompare(b.key));
  const references = await stillReferenced(input.root, uploadList, rewritten);
  const removals: string[] = [];
  for (const upload of uploadList) {
    const reference = references.get(upload.path);
    if (reference) {
      warnings.push({
        path: upload.path,
        message: `Kept the local file because ${inside(input.root, reference) ?? reference} still refers to it.`,
      });
    } else if (pending.get(upload.path)?.managed) {
      removals.push(upload.path);
    } else {
      warnings.push({
        path: upload.path,
        message: "Kept the local file because it's outside the CDN library's folder.",
      });
    }
  }
  return {
    uploads: uploadList,
    writes: [...rewritten].map(([path, content]) => ({
      path,
      previous: previous.get(path)!,
      content,
    })),
    removals,
    deletes,
    warnings,
    blockers,
    firstMigrations: [...context.migrating]
      .filter((collection) => !context.published.has(collection))
      .sort(),
  };
}

function planContext(root: string, config: PagesConfig): PlanContext {
  return {
    root,
    config,
    sources: new Map((config.cdnSources ?? []).map((source) => [source.name, source])),
    migrating: new Set(),
    published: new Set(),
    liveUrls: new Set(),
  };
}

/** Counts CDN work waiting for Publish without reading or hashing images, so
 * Publish can be offered when only a migration or a retried delete is pending.
 * Images used only by CDN-bound content fields are found when that content is
 * next published. */
export async function countPendingCdnMedia(root: string, config: PagesConfig): Promise<number> {
  const context = planContext(root, config);
  if (context.sources.size === 0) return 0;
  const pending = new Map<string, PendingImage>();
  await collectLibraryImages(context, pending);
  await collectMediaSourceImages(context, pending);
  return pending.size + (await collectDeletes(context)).length;
}

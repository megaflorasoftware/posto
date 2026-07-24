import type {
  ContentEntry,
  Field,
  MediaEntry,
  MediaLibrary,
  PagesConfig,
} from "@posto/core/pagescms/config";
import {
  expandMediaEntry,
  mediaInputPath,
  mediaOutputPath,
  resolveMediaForValue,
} from "@posto/core/pagescms/config";
import {
  parseFile,
  serializeFile,
  setValue,
  type ValuePath,
} from "@posto/core/pagescms/frontmatter";
import {
  dataDocumentEntries,
  dataEntryValues,
  parseDataDocument,
  serializeDataDocument,
  setDataValue,
} from "@posto/core/project/dataDocument";
import { invoke, type FileGroup } from "@posto/ipc";

export interface ImageLibraryRelocation {
  oldEntryId: string;
  newEntryId: string;
  oldImagePath: string;
  newImagePath: string;
  newAlt?: string;
}

export interface ImageLibraryReferenceUpdatePlan {
  writes: Array<{ path: string; previous: string; content: string }>;
  replacements: number;
}

const IMAGE_NAME = /^(src|image|img|imgsrc)$/i;

function valueAt(root: unknown, path: ValuePath): unknown {
  let value = root;
  for (const key of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}

function entryForPath(config: PagesConfig, root: string, filePath: string): ContentEntry | null {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (!filePath.startsWith(prefix)) return null;
  const relative = filePath.slice(prefix.length);
  for (const entry of config.content) {
    if (entry.dataFile) {
      if (relative === entry.dataFile.path) return entry;
    } else if (entry.type === "file") {
      if (relative === entry.path) return entry;
    } else if (relative.startsWith(`${entry.path}/`)) {
      const remainder = relative.slice(entry.path.length + 1);
      if (entry.subfolders !== false || !remainder.includes("/")) return entry;
    }
  }
  return null;
}

function defaultLibraryMedia(library: MediaLibrary): MediaEntry {
  const input = library.base.replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
  return { name: `library:${library.collection}`, input, output: `/${input}` };
}

function outputReplacement(
  current: string,
  field: Field,
  entry: ContentEntry,
  values: Record<string, unknown>,
  root: string,
  config: PagesConfig,
  library: MediaLibrary,
  relocations: ImageLibraryRelocation[],
): string | null {
  const media =
    resolveMediaForValue(config, field, current, entry, values) ?? defaultLibraryMedia(library);
  const oldAbsolute = mediaInputPath(root, media, current);
  const relocation = relocations.find((candidate) => candidate.oldImagePath === oldAbsolute);
  if (!relocation) return null;
  return mediaOutputPath(root, media, relocation.newImagePath);
}

function fieldUpdates(
  fields: Field[],
  values: Record<string, unknown>,
  basePath: ValuePath,
  entry: ContentEntry,
  root: string,
  config: PagesConfig,
  library: MediaLibrary,
  relocations: ImageLibraryRelocation[],
): Array<{ path: ValuePath; value: string }> {
  const updates: Array<{ path: ValuePath; value: string }> = [];
  const entryIds = new Map(relocations.map((item) => [item.oldEntryId, item.newEntryId]));

  const visit = (field: Field, path: ValuePath, listItem = false) => {
    const value = valueAt(values, path.slice(basePath.length));
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
    if (typeof value !== "string") return;
    if (field.type === "reference" && field.options?.collection === library.collection) {
      const replacement = entryIds.get(value);
      if (replacement && replacement !== value) updates.push({ path, value: replacement });
      return;
    }
    if (field.type === "image" || IMAGE_NAME.test(field.name)) {
      const replacement = outputReplacement(
        value,
        field,
        entry,
        values,
        root,
        config,
        library,
        relocations,
      );
      if (replacement && replacement !== value) updates.push({ path, value: replacement });
    }
  };

  for (const field of fields) {
    if (field.name !== "body") visit(field, [...basePath, field.name]);
  }
  return updates;
}

function markdownOutputMap(
  entry: ContentEntry,
  values: Record<string, unknown>,
  root: string,
  config: PagesConfig,
  library: MediaLibrary,
  relocations: ImageLibraryRelocation[],
  includeAlt: boolean,
): Map<string, { destination: string; alt?: string }> {
  const candidates = [entry.media, ...config.media, defaultLibraryMedia(library)]
    .filter((media): media is MediaEntry => !!media)
    .flatMap((media) => {
      const expanded = expandMediaEntry(media, values);
      return expanded ? [expanded] : [];
    });
  const result = new Map<string, { destination: string; alt?: string }>();
  for (const media of candidates) {
    for (const relocation of relocations) {
      const oldOutput = mediaOutputPath(root, media, relocation.oldImagePath);
      const newOutput = mediaOutputPath(root, media, relocation.newImagePath);
      const alt = includeAlt ? relocation.newAlt : undefined;
      if (!oldOutput || !newOutput || (oldOutput === newOutput && alt === undefined)) continue;
      result.set(oldOutput, { destination: newOutput, alt });
      result.set(oldOutput.replace(/^\//, ""), {
        destination: newOutput.replace(/^\//, ""),
        alt,
      });
    }
  }
  return result;
}

function replacementForDestination<T>(
  destination: string,
  replacements: Map<string, T>,
): { replacement: T; suffix: string } | null {
  for (const [oldPath, replacement] of replacements) {
    if (destination === oldPath) return { replacement, suffix: "" };
    if (destination.startsWith(`${oldPath}?`) || destination.startsWith(`${oldPath}#`)) {
      return { replacement, suffix: destination.slice(oldPath.length) };
    }
  }
  return null;
}

function escapeMarkdownImageAlt(alt: string): string {
  return alt.replace(/\r?\n/g, " ").replace(/([\\[\]])/g, "\\$1");
}

function rewriteMarkdownImages(
  body: string,
  replacements: Map<string, { destination: string; alt?: string }>,
): { content: string; replacements: number } {
  let fencedBy: "`" | "~" | null = null;
  let count = 0;
  const lines = body.split(/(?<=\n)/);
  const content = lines
    .map((line) => {
      const fence = line.match(/^\s*(`{3,}|~{3,})/);
      if (fence) {
        const marker = fence[1][0] as "`" | "~";
        if (fencedBy === marker) fencedBy = null;
        else if (!fencedBy) fencedBy = marker;
        return line;
      }
      if (fencedBy) return line;
      return line.replace(
        /!\[((?:\\.|[^\]\\\n])*)\](\(\s*)(<)?([^\s)>]+)(>)?/g,
        (
          match,
          currentAlt: string,
          destinationPrefix: string,
          open: string | undefined,
          destination: string,
          close: string | undefined,
        ) => {
          const found = replacementForDestination(destination, replacements);
          if (!found) return match;
          const nextDestination = found.replacement.destination + found.suffix;
          const nextAlt =
            found.replacement.alt === undefined
              ? currentAlt
              : escapeMarkdownImageAlt(found.replacement.alt);
          if (nextDestination === destination && nextAlt === currentAlt) return match;
          count += 1;
          return `![${nextAlt}]${destinationPrefix}${open ?? ""}${nextDestination}${close ?? ""}`;
        },
      );
    })
    .join("");
  return { content, replacements: count };
}

/** Rewrites ordinary inline Markdown image destinations while deliberately
 * leaving fenced examples untouched. The document's surrounding formatting is
 * preserved because only the destination token is replaced. */
export function rewriteMarkdownImageDestinations(
  body: string,
  replacements: Map<string, string>,
): { content: string; replacements: number } {
  return rewriteMarkdownImages(
    body,
    new Map(
      [...replacements].map(([oldDestination, destination]) => [oldDestination, { destination }]),
    ),
  );
}

/** Builds all content writes before the filesystem move starts. Parse errors
 * abort the operation rather than allowing an untracked broken reference. */
export async function planImageLibraryReferenceUpdates(input: {
  root: string;
  config: PagesConfig;
  groups: FileGroup[];
  library: MediaLibrary;
  relocations: ImageLibraryRelocation[];
}): Promise<ImageLibraryReferenceUpdatePlan> {
  const writes: ImageLibraryReferenceUpdatePlan["writes"] = [];
  let replacements = 0;
  const paths = new Set(input.groups.flatMap((group) => group.files.map((file) => file.path)));

  for (const path of paths) {
    const entry = entryForPath(input.config, input.root, path);
    if (!entry) continue;
    const previous = await invoke<string>("read_text_file", { path });
    if (entry.dataFile) {
      const parsed = parseDataDocument(previous, entry.dataFile.format);
      if (parsed.error) throw new Error(`Could not update references in ${path}: ${parsed.error}`);
      for (const locator of dataDocumentEntries(parsed)) {
        const values = dataEntryValues(parsed, locator);
        if (!values) continue;
        const updates = fieldUpdates(
          entry.fields,
          values,
          locator.path,
          entry,
          input.root,
          input.config,
          input.library,
          input.relocations,
        );
        for (const update of updates) setDataValue(parsed, update.path, update.value);
        replacements += updates.length;
      }
      const content = serializeDataDocument(parsed);
      if (content !== previous) writes.push({ path, previous, content });
      continue;
    }
    if (!/\.(md|mdx|markdown)$/i.test(path)) continue;
    const parsed = parseFile(previous);
    if (parsed.error) throw new Error(`Could not update references in ${path}: ${parsed.error}`);
    const values = (parsed.doc.toJS() ?? {}) as Record<string, unknown>;
    const updates = fieldUpdates(
      entry.fields,
      values,
      [],
      entry,
      input.root,
      input.config,
      input.library,
      input.relocations,
    );
    for (const update of updates) setValue(parsed.doc, update.path, update.value);
    replacements += updates.length;
    const markdown = rewriteMarkdownImages(
      parsed.body,
      markdownOutputMap(
        entry,
        values,
        input.root,
        input.config,
        input.library,
        input.relocations,
        /\.(md|mdx)$/i.test(path),
      ),
    );
    parsed.body = markdown.content;
    replacements += markdown.replacements;
    const content = serializeFile(parsed);
    if (content !== previous) writes.push({ path, previous, content });
  }
  return { writes, replacements };
}

/** Applies preplanned writes and restores earlier files if a later write fails. */
export async function applyImageLibraryReferenceUpdates(
  plan: ImageLibraryReferenceUpdatePlan,
): Promise<void> {
  const completed: typeof plan.writes = [];
  try {
    for (const write of plan.writes) {
      await invoke("write_text_file", { path: write.path, content: write.content });
      completed.push(write);
    }
  } catch (error) {
    await Promise.allSettled(
      completed.map((write) =>
        invoke("write_text_file", { path: write.path, content: write.previous }),
      ),
    );
    throw error;
  }
}

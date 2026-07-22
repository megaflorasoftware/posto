import { Document } from "yaml";

import type { FileGroup } from "@posto/ipc";
import {
  type ContentEntry,
  type PagesConfig,
  collectionExtension,
  entryFilenamePattern,
  generateFilename,
  matchCollectionForDir,
  matchEntry,
  newEntryValues,
  renamedFilename,
} from "@posto/core/pagescms/config";
import { parseFile, setValue } from "@posto/core/pagescms/frontmatter";

// The "new file" flow: files are created immediately (no dialog) with a
// filename derived from the collection's template and default field values,
// then renamed as the user edits the fields the template derives from.

type SchemaSources = {
  config: PagesConfig;
  /** Entries parsed from `.pages.yml` (before the `.posto` overlay). */
  pagesContent: ContentEntry[];
  /** Entries sourced from Astro collection schemas. */
  derivedContent: ContentEntry[];
};

/** Whether the effective entry came from an Astro collection schema. The
 * `.posto` overlay clones entries it touches, so match by name+path;
 * `.pages.yml` wins ties, matching the config's precedence order. */
function isDerivedEntry(entry: ContentEntry, sources: SchemaSources): boolean {
  const matches = (e: ContentEntry) => e.name === entry.name && e.path === entry.path;
  return !sources.pagesContent.some(matches) && sources.derivedContent.some(matches);
}

/** `name.md` → `name-2.md`, `name-3.md`, … until no sibling claims it. */
function dedupeFilename(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The path and initial content for a new file in a sidebar directory. When
 * the directory belongs to a collection, the filename comes from the
 * collection's template expanded over default field values ("Untitled" for
 * the primary field, today for date fields the template needs, schema
 * `default`s for the rest) and the content carries those defaults as
 * frontmatter. Directories without a schema get an empty-bodied
 * `untitled.md` titled "Untitled". Names are deduped against the group's
 * existing files.
 */
export function buildNewFile(
  root: string,
  group: FileGroup,
  sources: SchemaSources,
): { path: string; content: string } {
  const taken = new Set(group.files.map((file) => file.name));
  const entry = matchCollectionForDir(sources.config, root, group.path);
  if (!entry) {
    const name = dedupeFilename("untitled.md", taken);
    return { path: group.path + "/" + name, content: '---\ntitle: "Untitled"\n---\n' };
  }
  const pattern = entryFilenamePattern(entry, isDerivedEntry(entry, sources));
  const values = newEntryValues(pattern, entry);
  const generated = generateFilename(pattern, entry, values).trim();
  // A template over valueless fields can expand to a degenerate name — "",
  // "/", or a bare ".mdx", which the sidebar would hide as a dotfile,
  // leaving an invisible orphan. Those fall back to an always-visible
  // `untitled.<ext>`; only the template's extension survives.
  const usable = generated !== "" && !generated.includes("/") && !generated.startsWith(".");
  const extension = pattern.match(/\.([a-z0-9]+)\s*$/i)?.[1] ?? collectionExtension(entry) ?? "md";
  const name = dedupeFilename(usable ? generated : `untitled.${extension}`, taken);
  // Written through setValue so scalars get the same treatment as form
  // edits: strings quoted, date fields plain (so date-typed schemas like
  // Astro's `z.date()` receive a real date).
  const doc = new Document({});
  let hasValues = false;
  for (const field of entry.fields) {
    if (field.name === "body" || values[field.name] === undefined) continue;
    setValue(doc, [field.name], values[field.name], { dateField: field.type === "date" });
    hasValues = true;
  }
  const content =
    /\.(md|mdx|markdown)$/i.test(name) && hasValues
      ? `---\n${doc.toString({ lineWidth: 0 })}---\n`
      : "";
  return { path: group.path + "/" + name, content };
}

/**
 * Path a just-saved file should move to when its frontmatter no longer
 * matches its explicitly configured template-derived filename. Default
 * patterns are only used to name new files; they never opt a collection into
 * rename-on-save. Null when the file isn't a collection entry, has no
 * filename template, its template derives from no fields, the frontmatter is
 * invalid or incomplete, or the name is already right.
 */
export function renameTargetForContent(
  root: string,
  path: string,
  content: string,
  sources: SchemaSources,
): string | null {
  const entry = matchEntry(sources.config, root, path);
  if (!entry || entry.type !== "collection") return null;
  if (!entry.filename) return null;
  if (entry.fieldSchemas?.filename?.editBehavior === "manual") return null;
  const parsed = parseFile(content);
  if (parsed.error || !parsed.hadFrontmatter) return null;
  const raw = parsed.doc.toJSON() as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const values = { ...(raw as Record<string, unknown>) };
  const pattern = entry.filename;
  const currentName = path.slice(path.lastIndexOf("/") + 1);
  const next = renamedFilename(pattern, entry, values, currentName);
  if (!next) return null;
  return path.slice(0, path.lastIndexOf("/") + 1) + next;
}

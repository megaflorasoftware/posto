import YAML from "yaml";

// Types and helpers for the Pages CMS `.pages.yml` configuration format
// (https://pagescms.org/docs/configuration). Only the subset posto uses is
// modeled: media sources, content entries (collection/file/group), and field
// definitions with component reuse.

export interface Field {
  name: string;
  type: string;
  label?: string | false;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  default?: unknown;
  list?: boolean | { min?: number; max?: number };
  pattern?: string | { regex: string; message?: string };
  options?: Record<string, unknown>;
  fields?: Field[];
}

export type TemplateEditBehavior = "controlled" | "manual";

/** Collection-level Posto behavior for one item string field. `filename` is
 * represented by the same schema as frontmatter fields even though it lives
 * on disk rather than in frontmatter. */
export interface FieldTemplateSchema {
  template?: string;
  editBehavior: TemplateEditBehavior;
  /** Visible rows for this string input. One renders a single-line input. */
  rows?: number;
}

export type ImageLibraryMetadataExtension = "yaml" | "yml" | "json";

/** A local Astro glob collection that Posto can manage as paired image and
 * metadata files. Paths are repository-root-relative. */
export interface AstroImageLibrary {
  collection: string;
  base: string;
  patterns: string[];
  metadataExtensions: ImageLibraryMetadataExtension[];
  imageFieldPath: string[];
  fields: Field[];
}

export interface AstroImageLibraryDiagnostic {
  collection: string;
  code:
    | "custom-entry-ids"
    | "multiple-image-fields"
    | "missing-loader-base"
    | "unsupported-image-shape"
    | "unsupported-metadata-format";
  message: string;
}

export interface MediaEntry {
  name: string;
  label?: string;
  input: string;
  output: string;
}

export interface ContentEntry {
  name: string;
  label?: string;
  type: "collection" | "file";
  path: string;
  subfolders?: boolean;
  /** Filename template for new entries (e.g. `{year}-{month}-{day}-{primary}.md`). */
  filename?: string;
  /** Explicit file extension for the collection's entries (no leading dot). */
  extension?: string;
  /** Field named by `view.primary`; the entry's display/primary field. */
  viewPrimary?: string;
  fields: Field[];
  // `.posto` overlay settings (see posto/config.ts); never set by `.pages.yml`
  // or Astro parsing — mergePostoConfig fills them on the effective config.
  /** Sidebar position from `.posto` `collections.order` (lower first). */
  order?: number;
  /** Entry-label template over frontmatter, e.g. `{fields.title}`. */
  entryName?: string;
  /** Sidebar sort for the collection's entries. */
  sort?: { by: string; direction: "asc" | "desc" };
  /** Entry filenames pinned to the top of the collection, in order. */
  pinned?: string[];
  /** Item-level template controls, keyed by field path. `filename` is the
   * synthetic file-name field; frontmatter fields use their schema path. */
  fieldSchemas?: Record<string, FieldTemplateSchema>;
  /** Collection-scoped media source, preferred over the global list. */
  media?: MediaEntry;
  /** The glob loader has a custom `generateId`; Posto cannot derive ids from
   * file paths and must not offer an id-valued reference picker. */
  astroCustomIds?: boolean;
  /** One physical data document stores many logical entries. */
  dataFile?: {
    format: "json" | "yaml" | "toml";
    /** Repo-root-relative backing file. */
    path: string;
  };
}

/** A generated Astro collection schema used for component-prop typing. Unlike
 * ContentEntry, this also includes collections whose source Posto cannot edit
 * (`file()`, custom loaders, and non-Markdown data formats). */
export interface AstroCollectionSchema {
  name: string;
  fields: Field[];
}

export interface PagesConfig {
  media: MediaEntry[];
  content: ContentEntry[];
  astroCollections?: AstroCollectionSchema[];
  imageLibraries?: AstroImageLibrary[];
  imageLibraryDiagnostics?: AstroImageLibraryDiagnostic[];
}

// Field types the form knows how to render; anything else falls back to a
// plain multi-line text control.
const KNOWN_TYPES = new Set([
  "string",
  "text",
  "number",
  "date",
  "boolean",
  "select",
  "image",
  "reference",
  "object",
]);

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

/**
 * Default output path for a media input dir when the config doesn't set one.
 * A site's `public` folder is served from the site root, so a leading
 * `public` segment must not appear in stored content paths
 * (`public/images` → `/images`, `public` → `/`).
 */
function defaultOutput(input: string): string {
  const served = input === "public" ? "" : input.replace(/^public\//, "");
  return "/" + served;
}

function normalizeMedia(media: unknown): MediaEntry[] {
  if (typeof media === "string") {
    const input = trimSlashes(media);
    return [{ name: "default", input, output: defaultOutput(input) }];
  }
  if (Array.isArray(media)) {
    return media
      .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
      .filter((m) => typeof m.input === "string")
      .map((m, i) => ({
        name: typeof m.name === "string" ? m.name : `media-${i}`,
        label: typeof m.label === "string" ? m.label : undefined,
        input: trimSlashes(m.input as string),
        output:
          typeof m.output === "string" ? m.output : defaultOutput(trimSlashes(m.input as string)),
      }));
  }
  if (media && typeof media === "object") {
    const m = media as Record<string, unknown>;
    if (typeof m.input === "string") {
      return [
        {
          name: "default",
          input: trimSlashes(m.input),
          output: typeof m.output === "string" ? m.output : defaultOutput(trimSlashes(m.input)),
        },
      ];
    }
  }
  return [];
}

function resolveField(
  raw: Record<string, unknown>,
  components: Record<string, unknown>,
  seen: Set<string>,
): Field {
  let merged = raw;
  const componentName = raw.component;
  if (typeof componentName === "string") {
    const component = components[componentName];
    if (component && typeof component === "object" && !seen.has(componentName)) {
      seen = new Set(seen).add(componentName);
      // The field's own keys override the component definition's.
      const { component: _ignored, ...overrides } = raw;
      merged = { ...(component as Record<string, unknown>), ...overrides };
    } else {
      merged = { ...raw, type: "text" };
    }
  }

  const type = typeof merged.type === "string" ? merged.type : "text";
  const field: Field = {
    name: String(merged.name ?? ""),
    type: KNOWN_TYPES.has(type) ? type : "text",
    label: merged.label === false ? false : typeof merged.label === "string" ? merged.label : undefined,
    description: typeof merged.description === "string" ? merged.description : undefined,
    required: merged.required === true,
    hidden: merged.hidden === true,
    default: merged.default,
    list:
      merged.list === true
        ? true
        : merged.list && typeof merged.list === "object"
          ? (merged.list as { min?: number; max?: number })
          : undefined,
    pattern:
      typeof merged.pattern === "string" || (merged.pattern && typeof merged.pattern === "object")
        ? (merged.pattern as Field["pattern"])
        : undefined,
    options:
      merged.options && typeof merged.options === "object"
        ? (merged.options as Record<string, unknown>)
        : undefined,
  };
  if (Array.isArray(merged.fields)) {
    field.fields = merged.fields
      .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
      .map((f) => resolveField(f, components, seen));
  }
  return field;
}

function collectEntries(
  items: unknown,
  components: Record<string, unknown>,
  out: ContentEntry[],
): void {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === "group") {
      collectEntries(entry.items, components, out);
      continue;
    }
    if (entry.type !== "collection" && entry.type !== "file") continue;
    if (typeof entry.path !== "string") continue;
    const fields = Array.isArray(entry.fields)
      ? entry.fields
          .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
          .map((f) => resolveField(f, components, new Set()))
      : [];
    const view = entry.view && typeof entry.view === "object" ? (entry.view as Record<string, unknown>) : {};
    const filename =
      typeof entry.filename === "string"
        ? entry.filename
        : entry.filename && typeof entry.filename === "object"
          ? (entry.filename as { template?: unknown }).template
          : undefined;
    out.push({
      name: String(entry.name ?? ""),
      label: typeof entry.label === "string" ? entry.label : undefined,
      type: entry.type,
      path: trimSlashes(entry.path),
      subfolders: entry.subfolders === false ? false : undefined,
      filename: typeof filename === "string" ? filename : undefined,
      extension:
        typeof entry.extension === "string"
          ? entry.extension.replace(/^\./, "").toLowerCase()
          : undefined,
      viewPrimary: typeof view.primary === "string" ? view.primary : undefined,
      fields,
    });
  }
}

/** Parses `.pages.yml`. Throws on invalid YAML or a non-object document. */
export function parsePagesConfig(source: string): PagesConfig {
  const parsed = YAML.parse(source);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("config is not a YAML mapping");
  }
  const raw = parsed as Record<string, unknown>;
  const components =
    raw.components && typeof raw.components === "object"
      ? (raw.components as Record<string, unknown>)
      : {};
  const content: ContentEntry[] = [];
  collectEntries(raw.content, components, content);
  return { media: normalizeMedia(raw.media), content };
}

/** Fields that render in the form: everything except the special `body` key. */
export function frontmatterFields(entry: ContentEntry): Field[] {
  return entry.fields.filter((f) => f.name !== "body");
}

/**
 * Matches an absolute file path to a content entry. `file` entries match
 * exactly; `collection` entries match files under their folder (direct
 * children only when `subfolders: false`). First match wins. Entries with no
 * frontmatter fields never match — there is nothing to show in a form.
 */
export function matchEntry(
  config: PagesConfig,
  root: string,
  filePath: string,
): ContentEntry | null {
  const prefix = root.endsWith("/") ? root : root + "/";
  if (!filePath.startsWith(prefix)) return null;
  const rel = filePath.slice(prefix.length);
  for (const entry of config.content) {
    if (frontmatterFields(entry).length === 0) continue;
    if (entry.dataFile) {
      if (rel === entry.dataFile.path) return entry;
      continue;
    }
    if (entry.type === "file") {
      if (rel === entry.path) return entry;
    } else {
      if (!rel.startsWith(entry.path + "/")) continue;
      const remainder = rel.slice(entry.path.length + 1);
      if (entry.subfolders === false && remainder.includes("/")) continue;
      return entry;
    }
  }
  return null;
}

export const EMPTY_CONFIG: PagesConfig = { media: [], content: [] };

/**
 * Collection entry whose folder contains `dirPath` (an absolute directory),
 * honoring `subfolders: false`. Used by "new file" to pick the schema for a
 * sidebar directory. Unlike {@link matchEntry}, entries without frontmatter
 * fields still match — the filename pattern is useful regardless.
 */
export function matchCollectionForDir(
  config: PagesConfig,
  root: string,
  dirPath: string,
): ContentEntry | null {
  const prefix = root.endsWith("/") ? root : root + "/";
  const rel = dirPath === root ? "" : dirPath.startsWith(prefix) ? dirPath.slice(prefix.length) : null;
  if (rel === null) return null;
  for (const entry of config.content) {
    if (entry.type !== "collection") continue;
    if (rel === entry.path) return entry;
    if (rel.startsWith(entry.path + "/") && entry.subfolders !== false) return entry;
  }
  return null;
}

/**
 * File extension the collection's entries use: the explicit `extension`
 * setting, else the extension of its `filename` template. Null when neither
 * names one — callers should then accept any extension.
 */
export function collectionExtension(entry: ContentEntry): string | null {
  if (entry.extension) return entry.extension;
  const match = entry.filename?.match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * The field new-entry filenames derive from, per Pages CMS: `view.primary`,
 * else a field named `title`, else the first non-object field.
 */
export function primaryField(entry: ContentEntry): Field | null {
  if (entry.viewPrimary) {
    const named = entry.fields.find((f) => f.name === entry.viewPrimary);
    if (named) return named;
  }
  return (
    entry.fields.find((f) => f.name === "title") ??
    entry.fields.find((f) => f.type !== "object") ??
    null
  );
}

/** Pages CMS slugification: lowercase, non-alphanumerics collapsed to `-`. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Default filename pattern for collections without a `filename` setting. */
export const DEFAULT_FILENAME_PATTERN = "{year}-{month}-{day}-{primary}.md";

const DATE_TOKENS = ["year", "month", "day", "hour", "minute", "second"] as const;

function currentDateTokens(): Record<string, string> {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    year: String(now.getFullYear()),
    month: pad(now.getMonth() + 1),
    day: pad(now.getDate()),
    hour: pad(now.getHours()),
    minute: pad(now.getMinutes()),
    second: pad(now.getSeconds()),
  };
}

/**
 * Filename template for the entry's new files: the entry's `filename`
 * setting, else `{primary}.<ext>` for Astro collections (whose entries are
 * just slug-named, with no date-prefix convention), else the Pages CMS
 * date-prefixed default.
 */
export function entryFilenamePattern(entry: ContentEntry, astro: boolean): string {
  if (entry.filename) return entry.filename;
  if (astro) return `{primary}.${collectionExtension(entry) ?? "md"}`;
  return DEFAULT_FILENAME_PATTERN;
}

/**
 * Frontmatter field a filename token reads. `{primary}` and its historical
 * `{slug}` alias resolve to the entry's primary field. Null when either alias
 * can't resolve because the entry has no primary field.
 */
function filenameFieldName(
  entry: ContentEntry,
  token: string,
  explicitField = false,
): string | null {
  const primary = primaryField(entry)?.name ?? null;
  if (!explicitField && (token === "primary" || token === "slug")) return primary;
  return token;
}

const FIELD_TEMPLATE_TOKEN = /\{(?:fields\.)?([^}|]+)(\|slug)?\}/g;

/** Expands field tokens shared by filename and media-folder templates.
 * `{fields.x}` (or `{x}`) inserts the trimmed scalar; `|slug` slugifies it.
 * Returns null while any referenced field is missing or empty. */
export function expandFieldTemplate(
  template: string,
  values: Record<string, unknown>,
): string | null {
  let missing = false;
  const expanded = template.replace(
    FIELD_TEMPLATE_TOKEN,
    (_, name: string, filter?: string) => {
      let value = values[name];
      if (value === undefined && name.includes(".")) {
        value = values;
        for (const part of name.split(".")) {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            value = undefined;
            break;
          }
          value = (value as Record<string, unknown>)[part];
        }
      }
      if (value === undefined || value === null || String(value).trim() === "") {
        missing = true;
        return "";
      }
      return filter ? slugify(String(value)) : String(value).trim();
    },
  );
  return missing ? null : expanded;
}

interface FilenameFieldToken {
  name: string;
  slugged: boolean;
}

/** Field dependencies in a filename pattern. Primary/slug aliases retain
 * their legacy slugified behavior; explicit fields are raw unless `|slug`
 * is present. */
function filenameFieldTokens(pattern: string, entry: ContentEntry): FilenameFieldToken[] {
  const tokens: FilenameFieldToken[] = [];
  for (const match of pattern.matchAll(FIELD_TEMPLATE_TOKEN)) {
    const token = match[1];
    const explicitField = match[0].startsWith("{fields.");
    if (!explicitField && (DATE_TOKENS as readonly string[]).includes(token)) continue;
    const name = filenameFieldName(entry, token, explicitField);
    if (!name) continue;
    tokens.push({ name, slugged: Boolean(match[2]) || token === "primary" || token === "slug" });
  }
  return tokens;
}

/**
 * Expands a Pages CMS filename pattern: `{year}`/`{month}`/`{day}`/`{hour}`/
 * `{minute}`/`{second}` from the current time (or `dates` overrides), and
 * `{primary}`/`{slug}`/`{fields.x}`/`{x}` from `values` (resolved via
 * {@link filenameFieldName}). Explicit fields are inserted raw; adding
 * `|slug` slugifies them. The primary/slug aliases remain slugified for
 * backwards compatibility.
 */
export function generateFilename(
  pattern: string,
  entry: ContentEntry,
  values: Record<string, unknown>,
  dates?: Record<string, string>,
): string {
  const dateTokens = { ...currentDateTokens(), ...dates };
  return pattern
    .replace(/\{(year|month|day|hour|minute|second)\}/g, (_, token: string) => dateTokens[token])
    .replace(FIELD_TEMPLATE_TOKEN, (match: string, token: string, filter?: string) => {
      const explicitField = match.startsWith("{fields.");
      const name = filenameFieldName(entry, token, explicitField);
      if (name === null) return "untitled"; // `{primary}` with no primary field
      const value = values[name];
      if (value === undefined || value === null) return "";
      const slugged = Boolean(filter) || (!explicitField && (token === "primary" || token === "slug"));
      return slugged ? slugify(String(value)) : String(value).trim();
    });
}

/**
 * Frontmatter field names a filename pattern derives from (resolved via
 * {@link filenameFieldName}). Date tokens are excluded — they come from the
 * clock, not from content.
 */
export function patternFields(pattern: string, entry: ContentEntry): string[] {
  const names: string[] = [];
  for (const token of filenameFieldTokens(pattern, entry)) {
    if (!names.includes(token.name)) names.push(token.name);
  }
  return names;
}

/**
 * Initial frontmatter values for a new entry: field `default`s (from
 * `.pages.yml` or the collection's zod schema), today's date for date fields
 * the filename pattern needs, and "Untitled" for the primary field — so a
 * new file always has enough to derive a filename from.
 */
export function newEntryValues(pattern: string, entry: ContentEntry): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of entry.fields) {
    if (field.name === "body") continue;
    if (field.default !== undefined) values[field.name] = field.default;
  }
  const today = new Date().toISOString().slice(0, 10);
  const needed = patternFields(pattern, entry);
  for (const name of needed) {
    if (values[name] !== undefined) continue;
    if (entry.fields.find((f) => f.name === name)?.type === "date") values[name] = today;
  }
  const primary = primaryField(entry);
  if (primary && values[primary.name] === undefined) {
    values[primary.name] = primary.type === "date" ? today : "Untitled";
  }
  return values;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
}

/**
 * Filename a file should have after its frontmatter changed, per the
 * pattern. Date/time tokens keep the values baked into the current filename
 * when it still matches the pattern (a title edit must not move an old
 * post's date prefix to today); only when it doesn't do they fall back to
 * now. Returns null when the pattern derives from no fields, a needed field
 * is empty (mid-edit states shouldn't produce broken names), or the name is
 * already correct.
 */
export function renamedFilename(
  pattern: string,
  entry: ContentEntry,
  values: Record<string, unknown>,
  currentName: string,
): string | null {
  const fields = patternFields(pattern, entry);
  if (fields.length === 0) return null;
  for (const token of filenameFieldTokens(pattern, entry)) {
    const value = values[token.name];
    if (value === undefined || value === null || String(value).trim() === "") return null;
    if (token.slugged && slugify(String(value)) === "") return null;
  }
  const dates: Record<string, string> = {};
  const captured: string[] = [];
  let regex = "^";
  let last = 0;
  for (const match of pattern.matchAll(/\{([^}]+)\}/g)) {
    regex += escapeRegExp(pattern.slice(last, match.index));
    const token = match[1];
    if (token === "year") {
      regex += "(\\d{4})";
      captured.push(token);
    } else if ((DATE_TOKENS as readonly string[]).includes(token)) {
      regex += "(\\d{2})";
      captured.push(token);
    } else {
      regex += "(?:[^/]*?)";
    }
    last = match.index + match[0].length;
  }
  regex += escapeRegExp(pattern.slice(last)) + "$";
  const match = currentName.match(new RegExp(regex));
  if (match) {
    captured.forEach((token, i) => {
      dates[token] = match[i + 1];
    });
  }
  const next = generateFilename(pattern, entry, values, dates);
  if (next === currentName || next === "" || next.includes("/") || next.startsWith(".")) {
    return null;
  }
  return next;
}

function inferField(name: string, value: unknown): Field {
  if (Array.isArray(value)) {
    const items = value.filter((v) => v !== null && v !== undefined && !Array.isArray(v));
    if (value.length > 0 && items.length === 0) {
      // Arrays of arrays (or all-null) have no editable item shape.
      return { name, type: "text", list: true };
    }
    const objects = items.filter(
      (v): v is Record<string, unknown> => typeof v === "object" && v !== null,
    );
    if (objects.length > 0) {
      // Union of keys across items, so sparse objects stay fully editable.
      const keys: string[] = [];
      for (const item of objects) {
        for (const key of Object.keys(item)) {
          if (!keys.includes(key)) keys.push(key);
        }
      }
      return {
        name,
        type: "object",
        list: true,
        fields: keys.map((key) => inferField(key, objects[0][key])),
      };
    }
    return { ...inferField(name, items[0]), list: true };
  }
  if (value !== null && typeof value === "object") {
    return {
      name,
      type: "object",
      fields: Object.entries(value).map(([key, child]) => inferField(key, child)),
    };
  }
  if (typeof value === "boolean") return { name, type: "boolean" };
  if (typeof value === "number") return { name, type: "number" };
  if (typeof value === "string" && value.includes("\n")) return { name, type: "text" };
  return { name, type: "string" };
}

/**
 * Builds a field list from the shape of existing frontmatter, for markdown
 * files with no schema in `.pages.yml`. Every key becomes editable; no
 * validation attributes are inferred.
 */
export function inferFields(values: Record<string, unknown>): Field[] {
  return Object.entries(values).map(([name, value]) => inferField(name, value));
}

/**
 * Media source for an image field: `options.media` by name, else the entry's
 * collection-scoped source (from Pages CMS configuration), else the first global.
 */
export function resolveMedia(
  config: PagesConfig,
  field: Field,
  entry?: ContentEntry | null,
  values?: Record<string, unknown>,
): MediaEntry | null {
  const name = field.options?.media;
  let media: MediaEntry | null;
  if (typeof name === "string") {
    media = config.media.find((m) => m.name === name) ?? null;
  } else {
    media = entry?.media ?? config.media[0] ?? null;
  }
  return media && values ? expandMediaEntry(media, values) : media;
}

/** Media source that owns an existing stored output path. Explicit
 * `options.media` remains authoritative; otherwise the most specific output
 * prefix wins (`/projects` before `/`). Collection-scoped media participates
 * alongside globals and wins an equal-prefix tie. */
export function resolveMediaForValue(
  config: PagesConfig,
  field: Field,
  outputPath: string,
  entry?: ContentEntry | null,
  values: Record<string, unknown> = {},
): MediaEntry | null {
  if (typeof field.options?.media === "string") {
    return resolveMedia(config, field, entry, values);
  }
  const candidates = [entry?.media, ...config.media]
    .filter((media): media is MediaEntry => media !== undefined)
    .map((media, index) => ({ media: expandMediaEntry(media, values), index }))
    .filter((candidate): candidate is { media: MediaEntry; index: number } => candidate.media !== null);
  const value = outputPath.startsWith("/") ? outputPath : `/${outputPath}`;
  const matches = candidates
    .map(({ media, index }) => ({ media, index, output: normalizedOutput(media) }))
    .filter(({ output }) => value.startsWith(`${output}/`))
    .sort((a, b) => b.output.length - a.output.length || a.index - b.index);
  return matches[0]?.media ?? resolveMedia(config, field, entry, values);
}

/** Resolves a media source's input and public output paths for one entry.
 * Null means a field referenced by either template is not populated yet. */
export function expandMediaEntry(
  media: MediaEntry,
  values: Record<string, unknown>,
): MediaEntry | null {
  const input = expandFieldTemplate(media.input, values);
  const output = expandFieldTemplate(media.output, values);
  return input === null || output === null ? null : { ...media, input, output };
}

/**
 * Maps an absolute file path inside a media source's input dir to the public
 * output path stored in content (e.g. input `public`, output `/`,
 * `<root>/public/og.png` → `/og.png`).
 */
/**
 * Output prefixes are compared with a leading slash and no trailing slash
 * ("src/media" ≡ "/src/media"; "/" ≡ ""), matching how Pages CMS writes
 * values regardless of how the config spells the output path.
 */
function normalizedOutput(media: MediaEntry): string {
  const trimmed = media.output.replace(/\/+$/, "");
  if (trimmed === "") return "";
  return trimmed.startsWith("/") ? trimmed : "/" + trimmed;
}

export function mediaOutputPath(
  root: string,
  media: MediaEntry,
  absolutePath: string,
): string | null {
  const inputDir = root + "/" + media.input + "/";
  if (!absolutePath.startsWith(inputDir)) return null;
  const rel = absolutePath.slice(inputDir.length);
  return normalizedOutput(media) + "/" + rel;
}

/** Inverse of {@link mediaOutputPath}: public output path → absolute file path. */
export function mediaInputPath(
  root: string,
  media: MediaEntry,
  outputPath: string,
): string | null {
  const output = normalizedOutput(media);
  const value = outputPath.startsWith("/") ? outputPath : "/" + outputPath;
  if (!value.startsWith(output + "/")) return null;
  return root + "/" + media.input + "/" + value.slice(output.length + 1);
}

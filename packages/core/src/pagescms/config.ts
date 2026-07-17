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
}

export interface PagesConfig {
  media: MediaEntry[];
  content: ContentEntry[];
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

/**
 * Expands a Pages CMS filename pattern: `{year}`/`{month}`/`{day}`/`{hour}`/
 * `{minute}`/`{second}` from the current time, `{primary}` (and its `{slug}`
 * alias) from the entry's primary field, and `{fields.x}` or `{x}` from
 * `values` — all field values slugified.
 */
export function generateFilename(
  pattern: string,
  entry: ContentEntry,
  values: Record<string, unknown>,
): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const dates: Record<string, string> = {
    year: String(now.getFullYear()),
    month: pad(now.getMonth() + 1),
    day: pad(now.getDate()),
    hour: pad(now.getHours()),
    minute: pad(now.getMinutes()),
    second: pad(now.getSeconds()),
  };
  const primary = primaryField(entry)?.name;
  return pattern
    .replace(/\{(year|month|day|hour|minute|second)\}/g, (_, token: string) => dates[token])
    .replace(/\{(?:primary|slug)\}/g, primary ? `{fields.${primary}}` : "untitled")
    .replace(/\{(?:fields\.)?([^}]+)\}/g, (_, name: string) => {
      const value = values[name];
      return value === undefined || value === null ? "" : slugify(String(value));
    });
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

/** Media source for an image field: `options.media` by name, else the first. */
export function resolveMedia(config: PagesConfig, field: Field): MediaEntry | null {
  const name = field.options?.media;
  if (typeof name === "string") {
    return config.media.find((m) => m.name === name) ?? null;
  }
  return config.media[0] ?? null;
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

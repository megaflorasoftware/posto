import type {
  ContentEntry,
  FieldTemplateSchema,
  PagesConfig,
  TemplateEditBehavior,
} from "../pagescms/config";

// Types and helpers for posto's own `.posto/` config directory: user
// preferences layered on top of the derived schema config (`.pages.yml` /
// Astro collections). `.posto` never defines what exists — only how it's
// presented — so every file is a sparse overlay: absent keys mean "use the
// derived default", and settings for unknown collections are ignored.
//
// Layout:
//   .posto/index.json               workspace-level settings (version,
//                                   collection order)
//   .posto/collections/<name>.json  per-collection settings, keyed by the
//                                   collection's `name`
//
// Parsing is tolerant in the same spirit as `pagescms/config.ts`: malformed
// JSON or wrong-shaped values are dropped rather than surfaced as errors, so
// a hand-edited typo degrades to defaults instead of breaking the app.

export const POSTO_DIR = ".posto";
export const POSTO_INDEX_PATH = `${POSTO_DIR}/index.json`;
export const POSTO_COLLECTIONS_DIR = `${POSTO_DIR}/collections`;

/** Schema version written to `index.json`; readers stay tolerant of newer. */
export const POSTO_CONFIG_VERSION = 0;

export interface PostoSort {
  /** Frontmatter field the entries sort by (`fields.date` or plain `date`),
   * or LABEL_SORT for the composite entry label. */
  by: string;
  direction: "asc" | "desc";
}

export interface PostoCollectionSettings {
  /** Sidebar label for the collection, replacing the derived one. */
  displayName?: string;
  /** Entry-label template over frontmatter, e.g. `{fields.title}`. */
  entryName?: string;
  /** New-entry filename template (Pages CMS token syntax). */
  filename?: string;
  sort?: PostoSort;
  /** Entry filenames pinned to the top of the collection, in order. */
  pinned?: string[];
  /** Templates shown beside item fields, but shared by the collection. */
  fields?: Record<string, FieldTemplateSchema | null>;
}

export interface PostoConfig {
  /** Sidebar order of collections by name; unlisted ones follow. */
  collectionOrder?: string[];
  /** Per-collection settings keyed by collection name. */
  collections: Record<string, PostoCollectionSettings>;
}

export const EMPTY_POSTO_CONFIG: PostoConfig = { collections: {} };

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((v): v is string => typeof v === "string");
  return items.length > 0 ? items : undefined;
}

/** Parses `.posto/index.json`; malformed input yields no settings. */
export function parsePostoIndex(source: string): Pick<PostoConfig, "collectionOrder"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return {};
  }
  const doc = asObject(parsed);
  const collections = doc && asObject(doc.collections);
  const order = collections && stringArray(collections.order);
  return order ? { collectionOrder: order } : {};
}

function parseSort(value: unknown): PostoSort | undefined {
  const sort = asObject(value);
  const by = sort && optionalString(sort.by);
  if (!by) return undefined;
  return { by, direction: sort.direction === "asc" ? "asc" : "desc" };
}

function templateBehavior(value: unknown, fieldName: string): TemplateEditBehavior {
  if (value === "manual") return "manual";
  if (value === "controlled" || value === "disabled") return "controlled";
  // The pre-mode filename behavior was controlled automatically. New
  // arbitrary field templates are manual unless explicitly opted in.
  return fieldName === "filename" ? "controlled" : "manual";
}

function parseFields(value: unknown): Record<string, FieldTemplateSchema | null> | undefined {
  const fields = asObject(value);
  if (!fields) return undefined;
  const parsed: Record<string, FieldTemplateSchema | null> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value === null) {
      parsed[name] = null;
      continue;
    }
    const field = asObject(value);
    const template = field && optionalString(field.template);
    const rows =
      field && typeof field.rows === "number" && Number.isFinite(field.rows) && field.rows >= 1
        ? Math.floor(field.rows)
        : undefined;
    // An empty filename object is an explicit override that removes a
    // filename template inherited from Pages CMS or Astro.
    if (!template && rows === undefined && name !== "filename") continue;
    parsed[name] = {
      ...(template ? { template } : {}),
      editBehavior: templateBehavior(field?.editBehavior, name),
      ...(rows !== undefined ? { rows } : {}),
    };
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

/** Parses one `.posto/collections/<name>.json`; malformed input yields null. */
export function parsePostoCollection(source: string): PostoCollectionSettings | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  const doc = asObject(parsed);
  if (!doc) return null;
  const settings: PostoCollectionSettings = {
    displayName: optionalString(doc.displayName),
    entryName: optionalString(doc.entryName),
    filename: optionalString(doc.filename),
    sort: parseSort(doc.sort),
    pinned: stringArray(doc.pinned),
    fields: parseFields(doc.fields),
  };
  return Object.values(settings).some((v) => v !== undefined) ? settings : null;
}

/**
 * Overlays `.posto` settings onto the derived config. Entries are matched by
 * collection name; settings for names with no entry are ignored, and entries
 * without settings pass through unchanged (aside from `order`, which every
 * collection named in `collectionOrder` receives).
 */
export function mergePostoConfig(config: PagesConfig, posto: PostoConfig | null): PagesConfig {
  if (!posto) return config;
  const order = new Map((posto.collectionOrder ?? []).map((name, i) => [name, i]));
  if (order.size === 0 && Object.keys(posto.collections).length === 0) return config;
  return {
    ...config,
    content: config.content.map((entry) => {
      if (entry.type !== "collection") return entry;
      const settings = posto.collections[entry.name];
      const orderIndex = order.get(entry.name);
      if (!settings && orderIndex === undefined) return entry;
      const merged: ContentEntry = { ...entry };
      if (orderIndex !== undefined) merged.order = orderIndex;
      if (!settings) return merged;
      if (settings.displayName) merged.label = settings.displayName;
      if (settings.filename) merged.filename = settings.filename;
      if (settings.entryName) merged.entryName = settings.entryName;
      if (settings.sort) merged.sort = settings.sort;
      if (settings.pinned) merged.pinned = settings.pinned;
      if (settings.fields) {
        const active = Object.fromEntries(
          Object.entries(settings.fields).filter(
            (field): field is [string, FieldTemplateSchema] => field[1] !== null,
          ),
        );
        if (Object.keys(active).length > 0) merged.fieldSchemas = active;
        // Filename participates in the same arbitrary field-schema map while
        // the existing creation/rename pipeline continues to consume the
        // effective ContentEntry filename template.
        if (settings.fields.filename?.template) merged.filename = settings.fields.filename.template;
        else if (settings.fields.filename !== undefined) delete merged.filename;
      }
      return merged;
    }),
  };
}

// Write-back: the UI reads a file, changes the keys it owns, and rewrites.
// Unknown keys are preserved verbatim so settings written by a newer posto
// (or by hand) survive a round-trip through an older build's UI; keys the
// form cleared are removed, keeping every file a sparse overlay.

function parseSourceObject(source: string | null): Record<string, unknown> {
  if (source === null) return {};
  try {
    const parsed: unknown = JSON.parse(source);
    return asObject(parsed) ?? {};
  } catch {
    return {};
  }
}

function serialize(doc: Record<string, unknown>): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

/** Rewrites a `.posto/collections/<name>.json` source with `settings`;
 * undefined settings keys are removed from the file. */
export function updatePostoCollectionSource(
  source: string | null,
  settings: PostoCollectionSettings,
): string {
  const doc = parseSourceObject(source);
  // Templates are edited by updatePostoFieldTemplateSource; this sidebar
  // settings writer deliberately leaves both new and legacy template keys
  // untouched.
  const scalars = ["displayName", "entryName"] as const;
  for (const key of scalars) {
    if (settings[key] !== undefined) doc[key] = settings[key];
    else delete doc[key];
  }
  // Removed before release: do not retain settings written by intermediate
  // builds of these features.
  delete doc.slug;
  delete doc.mediaDir;
  if (settings.sort) doc.sort = { by: settings.sort.by, direction: settings.sort.direction };
  else delete doc.sort;
  if (settings.pinned && settings.pinned.length > 0) doc.pinned = settings.pinned;
  else delete doc.pinned;
  return serialize(doc);
}

/** Updates one item-visible field template without disturbing collection
 * settings or templates owned by other fields. Passing null removes it. */
export function updatePostoFieldTemplateSource(
  source: string | null,
  fieldName: string,
  schema: FieldTemplateSchema | null,
): string {
  const doc = parseSourceObject(source);
  const fields = asObject(doc.fields) ?? {};
  if (schema) {
    fields[fieldName] = {
      ...(schema.template ? { template: schema.template } : {}),
      editBehavior: schema.editBehavior,
      ...(schema.rows !== undefined ? { rows: schema.rows } : {}),
    };
  } else {
    fields[fieldName] = null;
  }
  doc.fields = fields;
  // Migrate the old filename-template location when the new filename schema
  // is touched. Entry-name remains readable for older hand-authored config,
  // but is no longer exposed by the collection dialog.
  if (fieldName === "filename") delete doc.filename;
  return serialize(doc);
}

/** Rewrites a `.posto/index.json` source with the collection order, stamping
 * the config version on files that don't have one. */
export function updatePostoIndexSource(source: string | null, collectionOrder: string[]): string {
  const doc = parseSourceObject(source);
  if (typeof doc.version !== "number") doc.version = POSTO_CONFIG_VERSION;
  const collections = asObject(doc.collections) ?? {};
  if (collectionOrder.length > 0) collections.order = collectionOrder;
  else delete collections.order;
  if (Object.keys(collections).length > 0) doc.collections = collections;
  else delete doc.collections;
  return serialize(doc);
}

/** Field name a sort/template token refers to (`fields.date` → `date`). */
function fieldName(token: string): string {
  return token.startsWith("fields.") ? token.slice("fields.".length) : token;
}

/**
 * Expands an entry-name template over a file's frontmatter scalars:
 * `{fields.x}` (or `{x}`) inserts the raw value, missing fields insert
 * nothing. Returns null when the result is effectively empty, so callers
 * fall back to the frontmatter title / filename.
 */
export function expandEntryName(
  template: string,
  frontmatter: Record<string, string> | null | undefined,
): string | null {
  const expanded = template
    .replace(/\{([^}]+)\}/g, (_, token: string) => frontmatter?.[fieldName(token)] ?? "")
    .trim();
  return expanded === "" ? null : expanded;
}

/** Sort token for the composite entry label (the expanded `entryName`
 * template, else the frontmatter title / filename) instead of a single
 * frontmatter field. Bare on purpose — field tokens are written
 * `fields.<name>`, so the two can't collide. */
export const LABEL_SORT = "label";

/**
 * Ordered comparison of two sort values: numbers compare numerically,
 * everything else lexically (which covers ISO dates). Missing or empty
 * values sort as the empty string — the smallest value, so they land first
 * ascending and last descending, following the direction like any other
 * value.
 */
export type SortComparisonMode = "numeric" | "lexical";

/** Chooses one comparison mode for a complete list, avoiding pairwise mode changes. */
export function sortComparisonMode(values: string[]): SortComparisonMode {
  return values.length > 0 &&
    values.every((value) => value !== "" && Number.isFinite(Number(value)))
    ? "numeric"
    : "lexical";
}

export function compareSortValues(
  va: string,
  vb: string,
  direction: "asc" | "desc",
  mode: SortComparisonMode = sortComparisonMode([va, vb]),
): number {
  const na = Number(va);
  const nb = Number(vb);
  const cmp =
    mode === "numeric"
      ? na - nb
      : va.localeCompare(vb, undefined, { sensitivity: "base", numeric: false });
  return direction === "desc" ? -cmp : cmp;
}

/** Comparator over frontmatter scalars for a collection's sort spec. */
export function compareBySort(
  a: Record<string, string> | null | undefined,
  b: Record<string, string> | null | undefined,
  sort: PostoSort,
  mode?: SortComparisonMode,
): number {
  const name = fieldName(sort.by);
  return compareSortValues(a?.[name] ?? "", b?.[name] ?? "", sort.direction, mode);
}

export function sortValue(
  frontmatter: Record<string, string> | null | undefined,
  sort: PostoSort,
): string {
  return frontmatter?.[fieldName(sort.by)] ?? "";
}

import { slug as githubSlug } from "github-slugger";
import type { ContentEntry, Field, MediaEntry, PagesConfig } from "../pagescms/config";

// Builds a PagesConfig from Astro content collections, used as a fallback
// schema source when `.pages.yml` doesn't cover a folder. Astro generates a
// JSON Schema per collection at `.astro/collections/<name>.schema.json`
// (via `astro sync`, dev, or build — posto runs the dev server, which keeps
// them fresh), so no zod/TypeScript parsing is needed. The loader base/pattern
// only exists in `content.config.ts`, which is parsed with a lightweight
// scanner; when that fails, the conventional `src/content/<name>` is assumed.
//
// Known v1 degradations (all validation still applies; only editor UX hints
// are lost, since zod has no notion of them): there are no labels, media dirs,
// or select display labels. `image()` and `reference()` are recovered from
// `content.config.ts`, since their generated schemas discard those identities.
// `reference()` becomes a reference
// field when the target collection can be recovered from `content.config.ts`
// (the generated schema drops it), else a plain string. `file()` loader
// collections are skipped — posto edits one markdown file per entry, not
// multi-entry data files.

type JsonSchema = Record<string, unknown>;

function asSchema(value: unknown): JsonSchema | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonSchema) : null;
}

/** True for the branch shapes zod-to-json-schema emits for `z.coerce.date()`:
 * string with a date format, or integer unix-time. */
function isDateBranch(schema: JsonSchema): boolean {
  const format = schema.format;
  if (schema.type === "string") return format === "date" || format === "date-time";
  return schema.type === "integer" && format === "unix-time";
}

/** True for `reference()` output: anyOf of a plain string, object shapes
 * whose required keys include "collection", and (zod 4's toJSONSchema only)
 * a plain number for numeric ids. */
function isReferenceAnyOf(branches: JsonSchema[]): boolean {
  let hasString = false;
  let hasCollectionObject = false;
  for (const branch of branches) {
    if (branch.type === "string" && !branch.format && !branch.pattern) hasString = true;
    else if (
      branch.type === "object" &&
      Array.isArray(branch.required) &&
      branch.required.includes("collection")
    ) {
      hasCollectionObject = true;
    } else if (branch.type !== "number") return false;
  }
  return hasString && hasCollectionObject;
}

/** Fallback for shapes with no useful conversion: edit as text, validate nothing. */
function textField(name: string): Field {
  return { name, type: "text" };
}

function convertSchema(name: string, schema: JsonSchema, required: boolean): Field {
  const base: Field = { name, type: "text", required: required || undefined };
  if (schema.default !== undefined) base.default = schema.default;

  // Nullable: `type: ["string", "null"]`. zod allows null, but the form's
  // required check treats null as empty — so nullable drops required.
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((t) => t !== "null");
    if (types.length === 1 && schema.type.length === 2) {
      return convertSchema(name, { ...schema, type: types[0] }, false);
    }
    return { ...textField(name), default: base.default }; // unions like string|number
  }

  const anyOf = Array.isArray(schema.anyOf) ? schema.anyOf.map(asSchema) : null;
  if (anyOf && anyOf.every((b): b is JsonSchema => b !== null) && anyOf.length > 0) {
    if (anyOf.every(isDateBranch)) return { ...base, type: "date" };
    // Marker only: the schema drops the target collection, so buildAstroConfig
    // fills it in from the `content.config.ts` scan or downgrades to string.
    if (isReferenceAnyOf(anyOf)) return { ...base, type: "reference" };
    const nullIdx = anyOf.findIndex((b) => b.type === "null");
    if (nullIdx !== -1 && anyOf.length === 2) {
      return convertSchema(name, { ...anyOf[1 - nullIdx], default: schema.default }, false);
    }
    return { ...textField(name), default: base.default };
  }

  if (Array.isArray(schema.enum) && schema.enum.every((v) => typeof v === "string")) {
    return { ...base, type: "select", options: { values: schema.enum } };
  }
  if (typeof schema.const === "string") {
    return { ...base, type: "select", options: { values: [schema.const] } };
  }

  switch (schema.type) {
    case "string": {
      if (schema.format === "date" || schema.format === "date-time") {
        return { ...base, type: "date" };
      }
      const field: Field = { ...base, type: "string" };
      if (typeof schema.pattern === "string") field.pattern = schema.pattern;
      const options: Record<string, unknown> = {};
      if (typeof schema.minLength === "number") options.minlength = schema.minLength;
      if (typeof schema.maxLength === "number") options.maxlength = schema.maxLength;
      if (Object.keys(options).length > 0) field.options = options;
      return field;
    }
    case "number":
    case "integer": {
      const field: Field = { ...base, type: "number" };
      const options: Record<string, unknown> = {};
      const min = schema.minimum ?? schema.exclusiveMinimum;
      const max = schema.maximum ?? schema.exclusiveMaximum;
      if (typeof min === "number") options.min = min;
      if (typeof max === "number") options.max = max;
      if (Object.keys(options).length > 0) field.options = options;
      return field;
    }
    case "boolean":
      return { ...base, type: "boolean" };
    case "array": {
      const items = asSchema(schema.items);
      const item = items ? convertSchema(name, items, false) : null;
      // Nested arrays have no editable item shape; degrade like inferField.
      const field: Field =
        item && !item.list ? { ...item, required: base.required, default: base.default } : { ...textField(name), required: base.required, default: base.default };
      const min = typeof schema.minItems === "number" ? schema.minItems : undefined;
      const max = typeof schema.maxItems === "number" ? schema.maxItems : undefined;
      field.list = min !== undefined || max !== undefined ? { min, max } : true;
      return field;
    }
    case "object": {
      const properties = asSchema(schema.properties);
      if (!properties) return { ...textField(name), required: base.required, default: base.default };
      const childRequired = Array.isArray(schema.required) ? schema.required : [];
      return {
        ...base,
        type: "object",
        fields: Object.entries(properties)
          .map(([key, child]) => {
            const childSchema = asSchema(child);
            return childSchema
              ? convertSchema(key, childSchema, childRequired.includes(key))
              : textField(key);
          }),
      };
    }
    default:
      // Empty schema `{}` (zod .custom()/.any()), allOf, opaque $ref, …
      return { ...textField(name), required: base.required, default: base.default };
  }
}

/**
 * Converts one generated `.astro/collections/<name>.schema.json` into form
 * fields. Two shapes exist: Astro 5 (zod 3 via zod-to-json-schema) wraps the
 * root in `{ "$ref": "#/definitions/<name>", "definitions": {...} }`, while
 * Astro 6 (zod 4's native toJSONSchema) emits the root object directly.
 * Both inject a `$schema` property that must not become a field. Returns
 * null when neither shape yields a root object with properties.
 */
export function parseCollectionSchema(name: string, source: string): Field[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  const doc = asSchema(parsed);
  const definitions = doc && asSchema(doc.definitions);
  const root = (definitions && asSchema(definitions[name])) ?? doc;
  const properties = root && asSchema(root.properties);
  if (!properties) return null;
  const required = Array.isArray(root.required) ? root.required : [];
  return Object.entries(properties)
    .filter(([key]) => key !== "$schema")
    .map(([key, child]) => {
      const childSchema = asSchema(child);
      return childSchema ? convertSchema(key, childSchema, required.includes(key)) : textField(key);
    });
}

export interface LoaderInfo {
  kind: "glob" | "file" | "legacy" | "custom" | "unknown";
  base?: string;
  /** glob() accepts a single pattern or an array of them. */
  patterns?: string[];
  /** `reference()` fields found in the schema, field name → collection. */
  references?: Record<string, string>;
  /** Field names whose schema uses Astro's `image()` helper. */
  images?: string[];
  /** A glob-loader `generateId` callback cannot be executed by the editor. */
  customIds?: boolean;
}

/** Slice out the balanced `(...)` argument list starting at `openIndex`. */
function balancedSlice(source: string, openIndex: number): string | null {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return null;
}

function stringProp(block: string, key: string): string | undefined {
  const match = block.match(new RegExp(`\\b${key}\\s*:\\s*(["'\`])([^"'\`]*)\\1`));
  return match ? match[2] : undefined;
}

/** Value of `key` when it's a string literal or an array of them. */
function stringsProp(block: string, key: string): string[] | undefined {
  const single = stringProp(block, key);
  if (single !== undefined) return [single];
  const array = block.match(new RegExp(`\\b${key}\\s*:\\s*\\[([^\\]]*)\\]`));
  if (!array) return undefined;
  const items = [...array[1].matchAll(/(["'`])([^"'`]*)\1/g)].map((m) => m[2]);
  return items.length > 0 ? items : undefined;
}

/** Source of a top-level object property in a defineCollection argument.
 * Returns the identifier itself for object shorthand (`{ loader }`). */
function topLevelObjectProp(block: string, key: string): string | undefined {
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  let quote: string | null = null;
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") braces++;
    else if (ch === "}") braces--;
    else if (ch === "(") parens++;
    else if (ch === ")") parens--;
    else if (ch === "[") brackets++;
    else if (ch === "]") brackets--;
    if (braces !== 1 || parens !== 0 || brackets !== 0 || !block.startsWith(key, i)) continue;
    if (/\w/.test(block[i - 1] ?? "") || /\w/.test(block[i + key.length] ?? "")) continue;
    let valueStart = i + key.length;
    while (/\s/.test(block[valueStart] ?? "")) valueStart++;
    if (block[valueStart] !== ":") {
      if (block[valueStart] === "," || block[valueStart] === "}") return key;
      continue;
    }
    valueStart++;
    while (/\s/.test(block[valueStart] ?? "")) valueStart++;
    const initial = { braces, parens, brackets };
    quote = null;
    for (let end = valueStart; end < block.length; end++) {
      const valueCh = block[end];
      if (quote) {
        if (valueCh === "\\") end++;
        else if (valueCh === quote) quote = null;
        continue;
      }
      if (valueCh === '"' || valueCh === "'" || valueCh === "`") quote = valueCh;
      else if (valueCh === "{") braces++;
      else if (valueCh === "}") braces--;
      else if (valueCh === "(") parens++;
      else if (valueCh === ")") parens--;
      else if (valueCh === "[") brackets++;
      else if (valueCh === "]") brackets--;
      if (
        (valueCh === "," || valueCh === "}") &&
        braces === initial.braces &&
        parens === initial.parens &&
        brackets === initial.brackets
      ) {
        return block.slice(valueStart, end).trim();
      }
    }
    return block.slice(valueStart).trim();
  }
  return undefined;
}

/**
 * Best-effort scan of `content.config.ts` for each collection's loader.
 * Returns loader info keyed by *exported* collection name (the name the
 * schema file uses). Anything unparseable simply isn't in the map — callers
 * fall back to the `src/content/<name>` convention.
 */
export function parseLoaderConfig(source: string): Map<string, LoaderInfo> {
  const byVariable = new Map<string, LoaderInfo>();
  const defRegex = /(?:const|let|var)\s+(\w+)\s*=\s*defineCollection\s*\(/g;
  for (let match = defRegex.exec(source); match; match = defRegex.exec(source)) {
    const body = balancedSlice(source, defRegex.lastIndex - 1);
    if (body === null) continue;
    let info: LoaderInfo = { kind: "legacy" };
    const loaderSource = topLevelObjectProp(body, "loader");
    const globIdx = loaderSource?.search(/\bglob\s*\(/) ?? -1;
    const fileIdx = loaderSource?.search(/\bfile\s*\(/) ?? -1;
    if (globIdx !== -1) {
      const args = loaderSource
        ? balancedSlice(loaderSource, loaderSource.indexOf("(", globIdx))
        : null;
      info = args
        ? {
            kind: "glob",
            base: stringProp(args, "base"),
            patterns: stringsProp(args, "pattern"),
            customIds: /\bgenerateId\b/.test(args),
          }
        : { kind: "glob" };
    } else if (fileIdx !== -1) {
      info = { kind: "file" };
    } else if (loaderSource !== undefined) {
      info = { kind: "custom" };
    }
    // Schema fields declared as `reference("x")`, possibly wrapped in
    // `z.array(...)`. Keyed by field name across all nesting levels — the
    // generated JSON Schema keeps the shape but drops the collection, so this
    // scan is the only source for it.
    const refRegex = /(\w+)\s*:\s*(?:z\s*\.\s*array\s*\(\s*)?reference\s*\(\s*(["'`])([^"'`]+)\2/g;
    for (let ref = refRegex.exec(body); ref; ref = refRegex.exec(body)) {
      (info.references ??= {})[ref[1]] = ref[3];
    }
    // `image()` becomes an indistinguishable string in Astro's generated JSON
    // Schema. Preserve the hint here for scalar fields, image arrays, nested
    // objects, and arrays of objects. As with references, names are resolved
    // recursively against the generated shape below.
    const imageRegex = /(?:(['"`])([^'"`]+)\1|(\w+))\s*:\s*(?:z\s*\.\s*array\s*\(\s*)?image\s*\(/g;
    for (let image = imageRegex.exec(body); image; image = imageRegex.exec(body)) {
      (info.images ??= []).push(image[2] ?? image[3]);
    }
    byVariable.set(match[1], info);
  }

  const result = new Map<string, LoaderInfo>();
  const exports = source.match(/export\s+const\s+collections\s*=\s*\{([\s\S]*?)\}/);
  if (!exports) return byVariable; // no export map found; variable names are the best guess
  // Entries are either shorthand (`blog`) or `"my-posts": blogVar`.
  const entryRegex = /(?:(["'])([^"']+)\1|(\w+))\s*(?::\s*(\w+))?\s*(?=,|$|\n|\})/g;
  for (let match = entryRegex.exec(exports[1]); match; match = entryRegex.exec(exports[1])) {
    const exported = match[2] ?? match[3];
    const variable = match[4] ?? match[3];
    if (!exported || !variable) continue;
    const info = byVariable.get(variable);
    if (info) result.set(exported, info);
  }
  return result;
}

/** Media source used when no `.pages.yml` provides one: Astro's `public` dir. */
export const DEFAULT_ASTRO_MEDIA: MediaEntry[] = [{ name: "default", input: "public", output: "/" }];

function normalizePath(base: string): string {
  return base.replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
}

/** Extension implied by a glob pattern, when unambiguous (`*.md` → `md`). */
function patternExtension(pattern: string): string | undefined {
  const match = pattern.match(/\*\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : undefined;
}

/**
 * Entry id Astro's glob-loader default `generateId` produces for a file: the
 * frontmatter `slug` when present, else the base-relative path without
 * extension, each segment slugified the way Astro does (github-slugger), with
 * a trailing `/index` dropped. Custom `generateId` functions aren't modeled.
 */
export function astroEntryId(relPath: string, slug?: string | null): string {
  if (slug) return slug;
  const withoutExt = relPath.replace(/\.[^./]+$/, "");
  return withoutExt
    .split("/")
    .map((segment) => githubSlug(segment))
    .join("/")
    .replace(/\/index$/, "");
}

/** Fills reference markers from the config scan; a reference whose target
 * collection couldn't be recovered edits as a plain string. */
function resolveReferences(
  fields: Field[],
  references: Record<string, string> | undefined,
  loaders: Map<string, LoaderInfo>,
): Field[] {
  return fields.map((field) => {
    if (field.type === "reference") {
      const collection = references?.[field.name];
      return collection
        ? loaders.get(collection)?.customIds
          ? { ...field, type: "string" }
          : { ...field, options: { collection, astroId: true } }
        : { ...field, type: "string" };
    }
    if (field.fields) {
      return { ...field, fields: resolveReferences(field.fields, references, loaders) };
    }
    return field;
  });
}

/** Restores Astro `image()` fields, which are plain strings in generated JSON
 * Schema. Traversing child fields also covers objects and object-list items. */
function resolveImages(fields: Field[], images?: string[]): Field[] {
  const names = new Set(images);
  return fields.map((field) => {
    const resolved = names.has(field.name) && (field.type === "string" || field.type === "text")
      ? { ...field, type: "image" }
      : field;
    return resolved.fields
      ? { ...resolved, fields: resolveImages(resolved.fields, images) }
      : resolved;
  });
}

/**
 * Assembles the fallback config from parsed schemas + loader info. Collections
 * loaded via `file()` are skipped (multi-entry data files aren't editable as
 * one-file-per-entry forms).
 */
export function buildAstroConfig(
  collections: { name: string; fields: Field[] }[],
  loaders: Map<string, LoaderInfo>,
): PagesConfig {
  const content: ContentEntry[] = [];
  const astroCollections = collections.map(({ name, fields }) => {
    const loader = loaders.get(name);
    return {
      name,
      fields: resolveReferences(resolveImages(fields, loader?.images), loader?.references, loaders),
    };
  });
  for (const { name, fields } of collections) {
    const loader = loaders.get(name);
    if (loader?.kind === "file" || loader?.kind === "custom") continue;
    const patterns = loader?.kind === "glob" ? (loader.patterns ?? []) : [];
    // A single unambiguous extension across all patterns; mixes (md + mdx)
    // leave it open so any extension is accepted.
    const extensions = new Set(patterns.map(patternExtension));
    const extension = extensions.size === 1 ? [...extensions][0] : undefined;
    // The current file/form pipeline reads Markdown frontmatter. Keep data and
    // Markdoc collections in the type registry below without exposing a
    // sidebar collection that Posto cannot parse or write safely.
    if (extension && !["md", "mdx", "markdown"].includes(extension)) continue;
    content.push({
      name,
      label: name.charAt(0).toUpperCase() + name.slice(1),
      type: "collection",
      path:
        loader?.kind === "glob" && loader.base
          ? normalizePath(loader.base)
          : `src/content/${name}`,
      subfolders:
        patterns.length > 0 && patterns.every((p) => !p.includes("/")) ? false : undefined,
      extension,
      fields: resolveReferences(resolveImages(fields, loader?.images), loader?.references, loaders),
      astroCustomIds: loader?.customIds || undefined,
    });
  }
  return {
    media: DEFAULT_ASTRO_MEDIA,
    content,
    astroCollections,
  };
}

import type { Document } from "yaml";
import {
  expandFieldTemplate,
  plainDateField,
  type ContentEntry,
  type Field,
} from "@posto/core/pagescms/config";
import {
  getValue,
  setValue,
  type ParsedFile,
  type ValuePath,
} from "@posto/core/pagescms/frontmatter";
import type { EntryIdSource } from "@posto/core/project/entryIds";
import type { FileEntry } from "@posto/ipc";

/** Schema field a frontmatter path lands on; numeric list indices stay on
 * the list's own field definition. Null for paths the schema doesn't know. */
export function fieldAt(fields: Field[], path: ValuePath): Field | null {
  let scope = fields;
  let found: Field | null = null;
  for (const key of path) {
    if (typeof key === "number") continue;
    found = scope.find((f) => f.name === key) ?? null;
    if (!found) return null;
    scope = found.fields ?? [];
  }
  return found;
}

export function plainValues(parsed: ParsedFile): Record<string, unknown> {
  const js = parsed.doc.toJS();
  return js && typeof js === "object" && !Array.isArray(js) ? (js as Record<string, unknown>) : {};
}

/** A document's top-level mapping as plain values; {} for anything else. */
function documentValues(doc: Document): Record<string, unknown> {
  const js = doc.toJS();
  return js && typeof js === "object" && !Array.isArray(js) ? (js as Record<string, unknown>) : {};
}

/** Writes schema defaults for absent keys (recursing into present non-list
 * objects). Forms run this on the first real edit so opening a file never
 * dirties it. */
export function materializeDefaults(doc: Document, fieldList: Field[], base: ValuePath) {
  for (const field of fieldList) {
    if (field.name === "body") continue;
    const path = [...base, field.name];
    const current = getValue(doc, path);
    if (current === undefined) {
      if (field.default !== undefined) {
        setValue(doc, path, field.default, {
          dateField: plainDateField(field),
        });
      }
    } else if (field.type === "object" && !field.list && field.fields) {
      materializeDefaults(doc, field.fields, path);
    }
  }
}

/** Recompute every controlled field after an item edit. Unrelated
 * templates resolve to their existing value, while repeated passes let
 * controlled fields feed one another without relying on fragile path-key
 * comparisons for nested schemas. */
export function applyControlledTemplates(doc: Document, entry: ContentEntry | null) {
  const schemas = entry?.fieldSchemas;
  if (!schemas) return;
  const controlled = Object.entries(schemas).filter(
    ([name, schema]) =>
      name !== "filename" && schema.template && schema.editBehavior === "controlled",
  );
  for (let pass = 0; pass <= controlled.length; pass++) {
    let changed = false;
    for (const [name, schema] of Object.entries(schemas)) {
      if (name === "filename" || !schema.template || schema.editBehavior !== "controlled") continue;
      const values = documentValues(doc);
      const expanded = expandFieldTemplate(schema.template, values);
      const path = name.split(".");
      if (expanded === null || getValue(doc, path) === expanded) continue;
      setValue(doc, path, expanded);
      changed = true;
    }
    if (!changed) break;
  }
}

export function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  return "";
}

/** Initial value for a newly added list item, built from nested defaults. */
export function newItemValue(field: Field): unknown {
  if (field.type === "object") {
    const item: Record<string, unknown> = {};
    for (const child of field.fields ?? []) {
      item[child.name] = child.default ?? (child.type === "object" ? newItemValue(child) : "");
    }
    return item;
  }
  return field.default ?? "";
}

export interface SelectValue {
  value: string;
  label: string;
}

export function selectValues(field: Field): SelectValue[] {
  const values = field.options?.values;
  if (!Array.isArray(values)) return [];
  return values.map((v) => {
    if (v && typeof v === "object") {
      const item = v as Record<string, unknown>;
      const value = asString(item.value ?? item.name);
      return { value, label: asString(item.label) || value };
    }
    return { value: asString(v), label: asString(v) };
  });
}

/**
 * Expands a Pages CMS reference `value`/`label` template for one file:
 * `{name}` (filename with extension), `{path}` (repo-root-relative),
 * `{filename}` (name without extension), `{extension}`, and `{primary}`
 * (frontmatter title when known, else the bare filename). Unknown tokens
 * expand to "" like Pages CMS.
 */
export function referenceTemplate(template: string, root: string, file: FileEntry): string {
  const dot = file.name.lastIndexOf(".");
  const bare = dot > 0 ? file.name.slice(0, dot) : file.name;
  const data: Record<string, string> = {
    name: file.name,
    path: file.path.slice(root.length + 1),
    filename: bare,
    extension: dot > 0 ? file.name.slice(dot + 1) : "",
    primary: file.title ?? bare,
  };
  return template.replace(/\{([^}]+)\}/g, (_, token: string) => data[token] ?? "");
}

/** The choices a file reference field offers, in sidebar order, deduped by
 * stored value. `files` should already carry titles and `.posto` ordering. */
export function referenceOptions(input: {
  files: FileEntry[];
  field: Field;
  collection: ContentEntry | null;
  root: string;
  entryIds: EntryIdSource | null;
}): SelectValue[] {
  const valueTemplate =
    typeof input.field.options?.value === "string" ? input.field.options.value : null;
  const labelTemplate =
    typeof input.field.options?.label === "string" ? input.field.options.label : null;
  const seen = new Set<string>();
  // Astro `reference()` frontmatter holds the entry id, not a path; ids come
  // from the same default-`generateId` rules Astro applies (frontmatter slug
  // override, slugified base-relative path).
  const frameworkBase =
    input.field.options?.idScheme === "framework" && input.entryIds && input.collection
      ? input.root + "/" + input.collection.path + "/"
      : null;
  const files = input.files.flatMap((file) => {
    const option = {
      // Pages CMS stores the repo-root-relative path by default.
      value: frameworkBase
        ? (file.dataEntry?.id ??
          input.entryIds!.derive(file.path.slice(frameworkBase.length), file.frontmatter?.slug))
        : valueTemplate
          ? referenceTemplate(valueTemplate, input.root, file)
          : file.path.slice(input.root.length + 1),
      label:
        (labelTemplate
          ? referenceTemplate(labelTemplate, input.root, file)
          : (file.title ?? file.name)) || file.name,
    };
    if (option.value === "" || seen.has(option.value)) return [];
    seen.add(option.value);
    return [option];
  });
  return files;
}

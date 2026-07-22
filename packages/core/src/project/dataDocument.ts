import { Document, parseDocument } from "yaml";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  appendListItem,
  deleteValue,
  getValue,
  moveListItem,
  removeListItem,
  setValue,
  type ValuePath,
} from "../pagescms/frontmatter";

export type DataDocumentFormat = "json" | "yaml" | "toml";

export interface DataEntryLocator {
  id: string;
  /** Path from the document root to the entry object. */
  path: ValuePath;
}

export interface ParsedDataDocument {
  format: DataDocumentFormat;
  value: unknown;
  yaml?: Document;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Entry id/slug, coerced from a primitive. Objects/arrays aren't valid ids. */
function entryId(item: Record<string, unknown>): string | null {
  const id = item.id ?? item.slug;
  if (typeof id === "string") return id === "" ? null : id;
  if (typeof id === "number" || typeof id === "bigint") return String(id);
  return null;
}

export function dataDocumentFormat(path: string): DataDocumentFormat | null {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "json") return "json";
  if (ext === "yaml" || ext === "yml") return "yaml";
  if (ext === "toml") return "toml";
  return null;
}

export function parseDataDocument(source: string, format: DataDocumentFormat): ParsedDataDocument {
  try {
    if (format === "yaml") {
      const yaml = parseDocument(source);
      const error = yaml.errors[0]?.message;
      return { format, yaml, value: error ? undefined : yaml.toJS(), error };
    }
    return {
      format,
      value: format === "json" ? JSON.parse(source) : parseToml(source),
    };
  } catch (error) {
    return {
      format,
      value: undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Entry objects accepted by Astro's file loader: a root array with id/slug,
 * a root record keyed by id, plus a single nested array (useful for TOML
 * array-of-tables paired with a custom parser).
 */
export function dataDocumentEntries(parsed: ParsedDataDocument): DataEntryLocator[] {
  const value = parsed.yaml ? parsed.yaml.toJS() : parsed.value;
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      if (!isRecord(item)) return [];
      const id = entryId(item);
      return id === null ? [] : [{ id, path: [index] }];
    });
  }
  if (!isRecord(value)) return [];
  const arrays = Object.entries(value).filter(([, item]) => Array.isArray(item));
  if (arrays.length === 1) {
    const [key, items] = arrays[0] as [string, unknown[]];
    const nested = items.flatMap((item, index) => {
      if (!isRecord(item)) return [];
      const id = entryId(item);
      return id === null ? [] : [{ id, path: [key, index] }];
    });
    if (nested.length > 0) return nested;
  }
  return Object.entries(value).flatMap(([id, item]) =>
    id === "$schema" || !isRecord(item) ? [] : [{ id, path: [id] }],
  );
}

function plainAt(parsed: ParsedDataDocument, path: ValuePath): unknown {
  if (parsed.yaml) return getValue(parsed.yaml, path);
  let value = parsed.value;
  for (const key of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}

export function dataEntryValues(
  parsed: ParsedDataDocument,
  locator: DataEntryLocator,
): Record<string, unknown> | null {
  const value = plainAt(parsed, locator.path);
  return isRecord(value) ? value : null;
}

function parentAt(
  root: unknown,
  path: ValuePath,
): { parent: Record<string | number, unknown>; key: string | number } | null {
  if (path.length === 0) return null;
  let value = root;
  for (const key of path.slice(0, -1)) {
    if (value === null || typeof value !== "object") return null;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value && typeof value === "object"
    ? { parent: value as Record<string | number, unknown>, key: path[path.length - 1] }
    : null;
}

function ensureParent(
  root: unknown,
  path: ValuePath,
): { parent: Record<string | number, unknown>; key: string | number } | null {
  if (path.length === 0 || root === null || typeof root !== "object") return null;
  let value = root as Record<string | number, unknown>;
  for (let index = 0; index < path.length - 1; index++) {
    const key = path[index];
    const nextKey = path[index + 1];
    let next = value[key];
    if (next === null || typeof next !== "object") {
      next = typeof nextKey === "number" ? [] : {};
      value[key] = next;
    }
    value = next as Record<string | number, unknown>;
  }
  return { parent: value, key: path[path.length - 1] };
}

export function setDataValue(
  parsed: ParsedDataDocument,
  path: ValuePath,
  value: unknown,
  options?: { dateField?: boolean },
): void {
  if (parsed.yaml) setValue(parsed.yaml, path, value, options);
  else {
    const target = ensureParent(parsed.value, path);
    if (target) target.parent[target.key] = value;
  }
}

export function deleteDataValue(parsed: ParsedDataDocument, path: ValuePath): void {
  if (parsed.yaml) deleteValue(parsed.yaml, path);
  else {
    const target = parentAt(parsed.value, path);
    if (target) delete target.parent[target.key];
  }
}

export function appendDataListItem(
  parsed: ParsedDataDocument,
  path: ValuePath,
  value: unknown,
): void {
  if (parsed.yaml) appendListItem(parsed.yaml, path, value);
  else {
    const current = plainAt(parsed, path);
    if (Array.isArray(current)) current.push(value);
    else setDataValue(parsed, path, [value]);
  }
}

export function removeDataListItem(
  parsed: ParsedDataDocument,
  path: ValuePath,
  index: number,
): void {
  if (parsed.yaml) removeListItem(parsed.yaml, path, index);
  else {
    const current = plainAt(parsed, path);
    if (Array.isArray(current)) current.splice(index, 1);
  }
}

export function moveDataListItem(
  parsed: ParsedDataDocument,
  path: ValuePath,
  from: number,
  to: number,
): void {
  if (parsed.yaml) moveListItem(parsed.yaml, path, from, to);
  else {
    const current = plainAt(parsed, path);
    if (!Array.isArray(current) || to < 0 || to >= current.length) return;
    const [item] = current.splice(from, 1);
    current.splice(to, 0, item);
  }
}

export function serializeDataDocument(parsed: ParsedDataDocument): string {
  if (parsed.yaml) return parsed.yaml.toString({ lineWidth: 0 });
  if (parsed.format === "json") return JSON.stringify(parsed.value, null, 2) + "\n";
  return stringifyToml(parsed.value as Record<string, unknown>);
}

export function removeDataEntry(parsed: ParsedDataDocument, locator: DataEntryLocator): void {
  const target = parentAt(parsed.yaml ? parsed.yaml.toJS() : parsed.value, locator.path);
  if (parsed.yaml) {
    const parentPath = locator.path.slice(0, -1);
    const key = locator.path[locator.path.length - 1];
    if (typeof key === "number") removeListItem(parsed.yaml, parentPath, key);
    else deleteValue(parsed.yaml, locator.path);
  } else if (target) {
    if (Array.isArray(target.parent) && typeof target.key === "number")
      target.parent.splice(target.key, 1);
    else delete target.parent[target.key];
  }
}

export function appendDataEntry(
  parsed: ParsedDataDocument,
  value: Record<string, unknown>,
): DataEntryLocator | null {
  const entries = dataDocumentEntries(parsed);
  const documentValue = parsed.yaml ? parsed.yaml.toJS() : parsed.value;
  if (Array.isArray(documentValue)) {
    const index = documentValue.length;
    appendDataListItem(parsed, [], value);
    return { id: String(value.id ?? value.slug), path: [index] };
  }
  if (!isRecord(documentValue)) return null;
  const arrays = Object.entries(documentValue).filter(([, item]) => Array.isArray(item));
  if (
    arrays.length === 1 &&
    entries.some((entry) => typeof entry.path[0] === "string" && typeof entry.path[1] === "number")
  ) {
    const key = arrays[0][0];
    const items = arrays[0][1] as unknown[];
    appendDataListItem(parsed, [key], value);
    return { id: String(value.id ?? value.slug), path: [key, items.length - 1] };
  }
  const id = String(value.id ?? value.slug);
  setDataValue(parsed, [id], value);
  return { id, path: [id] };
}

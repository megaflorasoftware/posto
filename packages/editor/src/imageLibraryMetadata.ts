import type {
  MediaLibrary,
  Field,
  MediaLibraryMetadataExtension,
} from "@posto/core/pagescms/config";
import type { ValuePath } from "@posto/core/pagescms/frontmatter";
import { imageDimensionFields } from "@posto/core/project/mediaLibrary";

export function imageLibraryMetadataFields(library: MediaLibrary): Field[] {
  // Posto fills dimensions for CDN-bound libraries, so editors never type them.
  const dimensions = library.mediaSource ? imageDimensionFields(library) : null;
  const managed = [
    library.imageFieldPath,
    ...(dimensions ? [dimensions.width, dimensions.height] : []),
  ];
  const omitImageField = (fields: Field[], prefix: string[] = []): Field[] =>
    fields.flatMap((field) => {
      const path = [...prefix, field.name];
      if (
        managed.some(
          (target) =>
            path.length === target.length && path.every((part, index) => part === target[index]),
        )
      )
        return [];
      const children = field.fields ? omitImageField(field.fields, path) : undefined;
      const imageIsInside =
        path.length <= library.imageFieldPath.length &&
        path.every((part, index) => library.imageFieldPath[index] === part);
      if (field.fields && children?.length === 0 && imageIsInside) return [];
      return [{ ...field, fields: children }];
    });

  return omitImageField(library.fields);
}

export function valueAtPath(root: unknown, path: ValuePath): unknown {
  let value = root;
  for (const key of path) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}

export function editValueAtPath(
  root: Record<string, unknown>,
  path: ValuePath,
  value: unknown,
): Record<string, unknown> {
  const next = structuredClone(root);
  let target: Record<string | number, unknown> = next;
  path.forEach((key, index) => {
    if (index === path.length - 1) {
      if (value === undefined) delete target[key];
      else target[key] = value;
      return;
    }
    const nextKey = path[index + 1];
    if (!target[key] || typeof target[key] !== "object") {
      target[key] = typeof nextKey === "number" ? [] : {};
    }
    target = target[key] as Record<string | number, unknown>;
  });
  return next;
}

export function metadataExtension(path: string): MediaLibraryMetadataExtension {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "json" || extension === "yaml" || extension === "yml") return extension;
  throw new Error(`Unsupported image metadata format: ${extension ?? "unknown"}`);
}

import type { Field } from "../pagescms/config";

// Field annotations in schema descriptions name the field a value comes from:
// `z.date().describe("image:default=capture-date")` fills the field with the
// capture date of the photo in the `image` field. Astro copies descriptions
// into its generated JSON schemas, so they work without running the site. The
// `posto:` prefix is reserved for settings, such as `posto:media=<source>`.

/** Values Posto can fill in when an import creates a library entry. */
export const FIELD_DEFAULTS = ["capture-date", "width", "height"] as const;
export type FieldDefault = (typeof FIELD_DEFAULTS)[number];

/** A field's default: one property of the image in another field. */
export interface FieldDefaultSource {
  /** Path to the image field, from the entry's root. */
  field: string[];
  value: FieldDefault;
}

const DEFAULT_ANNOTATION =
  /(?:^|\s)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*):default=([A-Za-z0-9_-]+)(?=\s|$)/g;

/** Reads `<field>:default=<value>` from a schema description. Unknown values
 * are ignored, so a typo leaves the field empty rather than guessing. */
export function fieldDefaultAnnotation(description: unknown): FieldDefaultSource | undefined {
  if (typeof description !== "string") return undefined;
  for (const [, field, value] of description.matchAll(DEFAULT_ANNOTATION)) {
    if (field === "posto") continue;
    const known = FIELD_DEFAULTS.find((candidate) => candidate === value);
    if (known) return { field: field.split("."), value: known };
  }
  return undefined;
}

export function defaultSourceOf(field: Field): FieldDefaultSource | undefined {
  const source = field.options?.defaultFrom as FieldDefaultSource | undefined;
  return source && Array.isArray(source.field) && typeof source.value === "string"
    ? source
    : undefined;
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

/** Every annotated field outside lists, with the path it's stored at. */
export function annotatedFields(
  fields: Field[],
  prefix: string[] = [],
): Array<{ path: string[]; source: FieldDefaultSource }> {
  return fields.flatMap((field) => {
    if (field.list) return [];
    const path = [...prefix, field.name];
    const source = defaultSourceOf(field);
    return [...(source ? [{ path, source }] : []), ...annotatedFields(field.fields ?? [], path)];
  });
}

/** Paths of the fields filled with `value` from the image at `imageField`. */
export function fieldsWithDefault(
  fields: Field[],
  value: FieldDefault,
  imageField: string[],
): string[][] {
  return annotatedFields(fields)
    .filter(({ source }) => source.value === value && samePath(source.field, imageField))
    .map(({ path }) => path);
}

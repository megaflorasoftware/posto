import type { Field } from "../pagescms/config";

// Annotations in schema descriptions follow `action=global.key.subkey`. The
// action is `initial` for an editable default, or `value` for a value Posto
// controls and shows locked:
//   initial=schema.image.width              default to the `image` photo's width
//   value=schema.image.width                always the `image` photo's width
//   value=schema.image.srcset               its sizes on a CDN, for `srcset`
//   value=schema.image.placeholder          a tiny copy as a `data:` URI
//   value=posto.media.bunny-photos-bucket   images live in that CDN source
// The global key says where the value comes from, so annotations can't
// collide with field names. Astro copies descriptions into its generated JSON
// schemas, so they work without running the site.

/** Values Posto can take from an entry's image. `srcset` and `placeholder`
 * are set when Publish uploads the image to a CDN. */
export const FIELD_DEFAULTS = ["capture-date", "width", "height", "srcset", "placeholder"] as const;
export type FieldDefault = (typeof FIELD_DEFAULTS)[number];

/** A value taken from the image in another field. */
export interface FieldDefaultSource {
  /** Path to the image field, from the entry's root. */
  field: string[];
  value: FieldDefault;
  /** `value=` annotations are locked; `initial=` ones are editable defaults. */
  locked: boolean;
}

interface Annotation {
  action: string;
  /** The global key, then the key path, then the subkey. */
  path: string[];
}

const ANNOTATION = /(?:^|\s)([a-z][a-z-]*)=([A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+){2,})(?=\s|$)/g;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const SOURCE_NAME = /^[A-Za-z0-9_-]+$/;

function annotations(text: string): Annotation[] {
  return [...text.matchAll(ANNOTATION)].map(([, action, path]) => ({
    action,
    path: path.split("."),
  }));
}

/** Reads `initial=schema.<image field>.<value>` or the locked
 * `value=schema.…` form from a schema description. Unknown values are
 * ignored, so a typo leaves the field empty. */
export function fieldDefaultAnnotation(description: unknown): FieldDefaultSource | undefined {
  if (typeof description !== "string") return undefined;
  for (const { action, path } of annotations(description)) {
    const [scope, ...rest] = path;
    if ((action !== "initial" && action !== "value") || scope !== "schema") continue;
    const field = rest.slice(0, -1);
    const value = FIELD_DEFAULTS.find((known) => known === rest[rest.length - 1]);
    if (value && field.length > 0 && field.every((part) => IDENTIFIER.test(part))) {
      return { field, value, locked: action === "value" };
    }
  }
  return undefined;
}

/** Reads `value=posto.media.<source>`, the CDN source that stores a field's
 * images, from description text. */
export function mediaSourceFromDescription(description: string): string | undefined {
  for (const { action, path } of annotations(description)) {
    const [scope, key, source, ...rest] = path;
    if (action === "value" && scope === "posto" && key === "media" && rest.length === 0) {
      if (SOURCE_NAME.test(source)) return source;
    }
  }
  return undefined;
}

export function defaultSourceOf(field: Field): FieldDefaultSource | undefined {
  const source = field.options?.defaultFrom as FieldDefaultSource | undefined;
  return source && Array.isArray(source.field) && typeof source.value === "string"
    ? source
    : undefined;
}

/** Whether Posto controls the field's value, so editors can't change it. */
export function isLockedField(field: Field): boolean {
  return defaultSourceOf(field)?.locked === true;
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

export interface AnnotatedField {
  path: string[];
  field: Field;
  source: FieldDefaultSource;
}

/** Every annotated field outside lists, with the path it's stored at. */
export function annotatedFields(fields: Field[], prefix: string[] = []): AnnotatedField[] {
  return fields.flatMap((field) => {
    if (field.list) return [];
    const path = [...prefix, field.name];
    const source = defaultSourceOf(field);
    return [
      ...(source ? [{ path, field, source }] : []),
      ...annotatedFields(field.fields ?? [], path),
    ];
  });
}

/** Annotated fields that take their value from the image at `imageField`. */
export function imageFields(fields: Field[], imageField: string[]): AnnotatedField[] {
  return annotatedFields(fields).filter(({ source }) => samePath(source.field, imageField));
}

/** Paths of the fields filled with `value` from the image at `imageField`. */
export function fieldsWithDefault(
  fields: Field[],
  value: FieldDefault,
  imageField: string[],
): string[][] {
  return imageFields(fields, imageField)
    .filter(({ source }) => source.value === value)
    .map(({ path }) => path);
}

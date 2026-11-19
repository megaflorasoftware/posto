// Posto annotations written into schema descriptions, such as
// `z.date().describe("posto:default=capture-date")`. Astro copies descriptions
// into its generated JSON schemas, so they work without running the site.

/** Values Posto can fill in when an import creates a library entry. */
export const FIELD_DEFAULTS = ["capture-date"] as const;
export type FieldDefault = (typeof FIELD_DEFAULTS)[number];

const DEFAULT_ANNOTATION = /(?:^|\s)posto:default=([A-Za-z0-9_-]+)(?=\s|$)/;

/** Reads `posto:default=<value>` from a schema description. Unknown values are
 * ignored, so a typo leaves the field empty rather than guessing. */
export function fieldDefaultAnnotation(description: unknown): FieldDefault | undefined {
  if (typeof description !== "string") return undefined;
  const value = description.match(DEFAULT_ANNOTATION)?.[1];
  return FIELD_DEFAULTS.find((known) => known === value);
}

/**
 * Schema fields shaped for native rendering. Each field carries the widget
 * decisions FieldEditor makes inline (locks, templates, select values, the
 * "choose image" affordance) so SwiftUI can render without re-deriving them.
 */
import type { ContentEntry, Field, PagesConfig } from "@posto/core/pagescms/config";
import { isLockedField } from "@posto/core/posto/annotations";
import {
  newItemValue,
  selectValues,
  type SelectValue,
} from "../../../../packages/editor/src/formModel";

export interface FieldView {
  name: string;
  /** The schema's type; unknown types render as multi-line text. */
  type: string;
  label: string;
  showLabel: boolean;
  description: string | null;
  required: boolean;
  hidden: boolean;
  list: boolean;
  listMin: number | null;
  listMax: number | null;
  /** Dotted schema path without list indices, e.g. `images.alt`. */
  schemaPath: string;
  fields: FieldView[];
  locked: boolean;
  /** Field templates from `.posto` (developer settings). */
  template: { template: string | null; controlled: boolean; rows: number | null } | null;
  selectValues: SelectValue[];
  numberMin: number | null;
  numberMax: number | null;
  /** Date fields that store a time of day. */
  dateTime: boolean;
  /** Text fields named like an image get a picker beside the input. */
  chooseImage: boolean;
  /** Reference target collection. */
  referenceCollection: string | null;
  /** Set when the reference points at an image library (framework ids). */
  imageLibrary: string | null;
  /** The field's default for a new list item, built from nested defaults. */
  newItem: unknown;
}

function numberOption(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function fieldViews(
  fields: Field[],
  entry: ContentEntry | null,
  config: PagesConfig,
  hasEntryIds: boolean,
  base: string[] = [],
): FieldView[] {
  return fields
    .filter((field) => field.name !== "body" || base.length > 0)
    .map((field) => {
      const path = [...base, field.name];
      const schemaPath = path.join(".");
      const schema = entry?.fieldSchemas?.[schemaPath];
      const limits = typeof field.list === "object" ? field.list : null;
      const referenceCollection =
        field.type === "reference" && typeof field.options?.collection === "string"
          ? field.options.collection
          : null;
      const library =
        referenceCollection && field.options?.idScheme === "framework" && hasEntryIds
          ? (config.mediaLibraries?.find(
              (candidate) => candidate.collection === referenceCollection,
            )?.collection ?? null)
          : null;
      return {
        name: field.name,
        type: field.type,
        label: typeof field.label === "string" ? field.label : field.name,
        showLabel: field.label !== false,
        description: field.description ?? null,
        required: field.required === true,
        hidden: field.hidden === true,
        list: Boolean(field.list),
        listMin: numberOption(limits?.min),
        listMax: numberOption(limits?.max),
        schemaPath,
        fields: field.fields ? fieldViews(field.fields, entry, config, hasEntryIds, path) : [],
        locked: isLockedField(field),
        template: schema
          ? {
              template: schema.template ?? null,
              controlled: schema.editBehavior === "controlled",
              rows: schema.rows ?? null,
            }
          : null,
        selectValues: field.type === "select" ? selectValues(field) : [],
        numberMin: numberOption(field.options?.min),
        numberMax: numberOption(field.options?.max),
        dateTime: field.type === "date" && field.options?.time === true,
        // As desktop's imagePickable; a prop edited as source text (a raw
        // row, like a video path type) gets no picker there either.
        chooseImage:
          !field.list &&
          (field.type === "string" || field.type === "text") &&
          /^(src|image|img|imgsrc)$/i.test(field.name) &&
          !field.options?.mdxRawType &&
          !field.options?.mdxRawField,
        referenceCollection,
        imageLibrary: library,
        newItem: newItemValue(field),
      };
    });
}

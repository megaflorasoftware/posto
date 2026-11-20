/**
 * Date fields round-trip through native date pickers in the document's own
 * spelling ("Jul 08 2022", "2022-07-08T10:00:00Z", …). The engine gives Swift
 * a control value per date path and writes picked values back with
 * dateValues.ts, exactly as the web date inputs do.
 */
import type { Field } from "@posto/core/pagescms/config";
import type { ValuePath } from "@posto/core/pagescms/frontmatter";
import {
  dateControlValue,
  dateTimeControlValue,
  dateTimeValueFromControl,
  dateValueFromControl,
  hasTimeOfDay,
} from "../../../../packages/editor/src/dateValues";

export interface DateControl {
  /** `YYYY-MM-DD`, or "" when the stored value can't be read as a date. */
  date: string;
  /** `YYYY-MM-DDTHH:MM[:SS]`, or "". */
  dateTime: string;
  hasTime: boolean;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value instanceof Date ? value.toISOString() : "";
}

/** Control values for every date in `values` that `fields` declares. */
export function dateControls(
  fields: Field[],
  values: unknown,
  base: ValuePath = [],
  out: Record<string, DateControl> = {},
): Record<string, DateControl> {
  if (!values || typeof values !== "object") return out;
  for (const field of fields) {
    const value = (values as Record<string, unknown>)[field.name];
    const path = [...base, field.name];
    const items = field.list ? (Array.isArray(value) ? value : []) : [value];
    items.forEach((item, index) => {
      const itemPath = field.list ? [...path, index] : path;
      if (field.type === "date" && item !== undefined && item !== null) {
        const raw = text(item);
        out[itemPath.join(".")] = {
          date: dateControlValue(raw),
          dateTime: dateTimeControlValue(raw),
          hasTime: hasTimeOfDay(raw),
        };
      } else if (field.type === "object" && field.fields) {
        dateControls(field.fields, item, itemPath, out);
      }
    });
  }
  return out;
}

/** The stored value for a picked control value, in the existing spelling. */
export function dateFromControl(control: string, current: unknown, time: boolean): string {
  const template = text(current);
  return time
    ? dateTimeValueFromControl(control, template)
    : dateValueFromControl(control, template);
}

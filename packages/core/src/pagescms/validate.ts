import type { Field } from "./config";

// Validates plain frontmatter values (doc.toJS() output) against the schema.
// Keys are dotted paths ("author.email", "images.1.alt") so the form can show
// errors next to the offending control.

export type Errors = Map<string, string>;

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

function fieldLabel(field: Field): string {
  return typeof field.label === "string" ? field.label : field.name;
}

function validateScalar(field: Field, value: unknown, key: string, errors: Errors): void {
  if (isEmpty(value)) {
    if (field.required) errors.set(key, `${fieldLabel(field)} is required`);
    return;
  }
  if (typeof value === "string" && field.pattern) {
    const regex = typeof field.pattern === "string" ? field.pattern : field.pattern.regex;
    const message =
      typeof field.pattern === "object" && field.pattern.message
        ? field.pattern.message
        : `Must match pattern ${regex}`;
    try {
      if (!new RegExp(regex).test(value)) {
        errors.set(key, message);
        return;
      }
    } catch {
      // Invalid regex in the config; don't block the user's content on it.
    }
  }
  const options = field.options ?? {};
  // A select's value must be one of its options (zod enums enforce this at
  // build time; the dropdown only constrains *new* input, not existing data).
  if (field.type === "select" && Array.isArray(options.values)) {
    const allowed = options.values.map((v) => {
      if (v && typeof v === "object") {
        const rec = v as Record<string, unknown>;
        const opt = rec.value ?? rec.name;
        if (typeof opt === "string") return opt;
        return typeof opt === "number" || typeof opt === "boolean" || typeof opt === "bigint"
          ? String(opt)
          : "";
      }
      return String(v);
    });
    if (!allowed.includes(String(value))) {
      errors.set(key, `${fieldLabel(field)} must be one of the allowed options`);
      return;
    }
  }
  if (typeof value === "string") {
    const minlength = options.minlength;
    const maxlength = options.maxlength;
    if (typeof minlength === "number" && value.length < minlength) {
      errors.set(key, `Must be at least ${minlength} characters`);
    } else if (typeof maxlength === "number" && value.length > maxlength) {
      errors.set(key, `Must be at most ${maxlength} characters`);
    }
  }
  if (field.type === "number" && typeof value === "number") {
    const min = options.min;
    const max = options.max;
    if (typeof min === "number" && value < min) {
      errors.set(key, `Must be at least ${min}`);
    } else if (typeof max === "number" && value > max) {
      errors.set(key, `Must be at most ${max}`);
    }
  }
}

function validateOne(field: Field, value: unknown, key: string, errors: Errors): void {
  if (field.type === "object") {
    if (isEmpty(value)) {
      if (field.required) errors.set(key, `${fieldLabel(field)} is required`);
      return;
    }
    const record =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    for (const child of field.fields ?? []) {
      validateField(child, record[child.name], `${key}.${child.name}`, errors);
    }
    return;
  }
  validateScalar(field, value, key, errors);
}

function validateField(field: Field, value: unknown, key: string, errors: Errors): void {
  if (!field.list) {
    validateOne(field, value, key, errors);
    return;
  }
  const items = Array.isArray(value) ? value : isEmpty(value) ? [] : [value];
  if (items.length === 0) {
    if (field.required) errors.set(key, `${fieldLabel(field)} is required`);
    return;
  }
  if (typeof field.list === "object") {
    const { min, max } = field.list;
    if (typeof min === "number" && items.length < min) {
      errors.set(key, `Needs at least ${min} item${min === 1 ? "" : "s"}`);
    } else if (typeof max === "number" && items.length > max) {
      errors.set(key, `Allows at most ${max} item${max === 1 ? "" : "s"}`);
    }
  }
  items.forEach((item, i) => validateOne(field, item, `${key}.${i}`, errors));
}

/** Validates all frontmatter fields against `values` (plain doc.toJS()). */
export function validateForm(fields: Field[], values: Record<string, unknown>): Errors {
  const errors: Errors = new Map();
  for (const field of fields) {
    if (field.name === "body") continue;
    validateField(field, values[field.name], field.name, errors);
  }
  return errors;
}

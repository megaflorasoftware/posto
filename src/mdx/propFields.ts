import type { Field } from "../pagescms/config";
import type { AstroPropDef, MdxProp } from "./mdx";

// Bridges Astro `Props` declarations and MDX prop attributes to the Pages CMS
// field model, so component cards render the same controls as the frontmatter
// form. Types that don't map to a form control (generics, object shapes,
// imported types, …) return null and fall back to a raw expression input.

/** Marker for prop values that are dynamic expressions, not literal data. */
export const UNPARSED: unique symbol = Symbol("unparsed-expression");

/** Splits a type string on top-level `|`, respecting brackets and quotes. */
function splitUnion(type: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of type) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
    } else if ("<([{".includes(ch)) {
      depth++;
      current += ch;
    } else if (">)]}".includes(ch)) {
      depth--;
      current += ch;
    } else if (ch === "|" && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/** Inner text of a string-literal type member, or null when it isn't one. */
function literalValue(member: string): string | null {
  const match = /^(["'])([\s\S]*)\1$/.exec(member);
  return match ? match[2] : null;
}

function typeField(name: string, type: string): Field | null {
  const members = splitUnion(type).filter((m) => m !== "undefined" && m !== "null");
  if (members.length === 0) return null;
  if (members.length > 1) {
    const literals = members.map(literalValue);
    return literals.every((v): v is string => v !== null)
      ? { name, type: "select", options: { values: literals } }
      : null;
  }
  const single = members[0];
  const literal = literalValue(single);
  if (literal !== null) return { name, type: "select", options: { values: [literal] } };
  if (single === "string") return { name, type: "string" };
  if (single === "number") return { name, type: "number" };
  if (single === "boolean") return { name, type: "boolean" };
  let item: string | null = null;
  if (single.endsWith("[]")) item = single.slice(0, -2).trim();
  else {
    const array = /^(?:Readonly)?Array<([\s\S]+)>$/.exec(single);
    if (array) item = array[1].trim();
  }
  if (item !== null) {
    if (item.startsWith("(") && item.endsWith(")")) item = item.slice(1, -1).trim();
    const itemField = typeField(name, item);
    if (!itemField || itemField.list) return null; // nested arrays have no control
    return { ...itemField, list: true };
  }
  return null;
}

/** Form field for a declared Astro prop, or null when the type has no
 * matching control and the prop should edit as a raw expression. */
export function astroPropField(def: AstroPropDef): Field | null {
  const field = typeField(def.name, def.type);
  if (!field) return null;
  if (!def.optional) field.required = true;
  return field;
}

/**
 * JS value carried by a prop: strings verbatim, shorthand booleans as true,
 * expressions through a tolerant JSON parse (single-quoted arrays are common
 * in authored MDX). Anything dynamic comes back as UNPARSED.
 */
export function propJsValue(prop: MdxProp): unknown {
  if (prop.kind === "string") return prop.value;
  if (prop.kind === "boolean") return true;
  if (prop.kind === "spread") return UNPARSED;
  const text = prop.value.trim();
  try {
    return JSON.parse(text);
  } catch {
    // not strict JSON
  }
  if (!text.includes('"')) {
    try {
      return JSON.parse(text.replace(/'/g, '"'));
    } catch {
      // not JSON with normalized quotes either
    }
  }
  return UNPARSED;
}

/**
 * Prop attribute for an edited JS value; null removes the prop. `false` on an
 * optional prop removes it (absent ≈ false), but a required prop keeps an
 * explicit `{false}`.
 */
export function jsValueProp(name: string, value: unknown, required: boolean): MdxProp | null {
  if (value === undefined || value === null || value === "") return null;
  if (value === true) return { name, value: "true", kind: "boolean" };
  if (value === false) return required ? { name, value: "false", kind: "expression" } : null;
  if (typeof value === "string") return { name, value, kind: "string" };
  if (typeof value === "number") return { name, value: String(value), kind: "expression" };
  if (Array.isArray(value) && value.length === 0 && !required) return null;
  return { name, value: JSON.stringify(value), kind: "expression" };
}

function scalarFits(field: Field, value: unknown): boolean {
  switch (field.type) {
    case "string":
    case "select":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    default:
      return true;
  }
}

/** True when a parsed prop value is shaped for the field's control, so the
 * form can edit it without mangling (mismatches keep the expression input). */
export function valueFits(field: Field, value: unknown): boolean {
  if (value === undefined) return true;
  if (field.list) {
    return Array.isArray(value) && value.every((item) => scalarFits(field, item));
  }
  return scalarFits(field, value);
}

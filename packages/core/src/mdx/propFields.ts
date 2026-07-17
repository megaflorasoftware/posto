import type { Field } from "../pagescms/config";
import { type AstroPropDef, type MdxProp, parseTypeMembers } from "./mdx";

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
  if (single.startsWith("{") && single.endsWith("}")) {
    const children: Field[] = [];
    for (const member of parseTypeMembers(single.slice(1, -1))) {
      const child = typeField(member.name, member.type);
      // Any unmappable member sends the whole prop to raw expression editing;
      // a partial form would drop the members it can't render.
      if (!child) return null;
      if (!member.optional) child.required = true;
      children.push(child);
    }
    if (children.length === 0) return null;
    return { name, type: "object", fields: children };
  }
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
 * Parses a JS literal expression — JSON plus what authored MDX actually
 * contains: single-quoted strings, bare object keys, trailing commas,
 * `undefined`. Throws on anything dynamic (identifiers, calls, templates).
 */
function parseLiteral(src: string): unknown {
  let i = 0;
  const fail = () => new Error("not a literal");
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const str = (): string => {
    const quote = src[i++];
    let out = "";
    while (i < src.length) {
      const ch = src[i++];
      if (ch === quote) return out;
      if (ch === "\\") {
        const esc = src[i++];
        out += esc === "n" ? "\n" : esc === "t" ? "\t" : esc;
      } else {
        out += ch;
      }
    }
    throw fail();
  };
  const value = (): unknown => {
    ws();
    const ch = src[i];
    if (ch === "{") {
      i++;
      const out: Record<string, unknown> = {};
      ws();
      if (src[i] === "}") {
        i++;
        return out;
      }
      for (;;) {
        ws();
        let key: string;
        if (src[i] === '"' || src[i] === "'") {
          key = str();
        } else {
          const ident = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
          if (!ident) throw fail();
          key = ident[0];
          i += ident[0].length;
        }
        ws();
        if (src[i] !== ":") throw fail();
        i++;
        out[key] = value();
        ws();
        if (src[i] === ",") {
          i++;
          ws();
          if (src[i] !== "}") continue;
        }
        if (src[i] !== "}") throw fail();
        i++;
        return out;
      }
    }
    if (ch === "[") {
      i++;
      const out: unknown[] = [];
      ws();
      if (src[i] === "]") {
        i++;
        return out;
      }
      for (;;) {
        out.push(value());
        ws();
        if (src[i] === ",") {
          i++;
          ws();
          if (src[i] !== "]") continue;
        }
        if (src[i] !== "]") throw fail();
        i++;
        return out;
      }
    }
    if (ch === '"' || ch === "'") return str();
    const num = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const word = /^[a-z]+/.exec(src.slice(i));
    if (word) {
      i += word[0].length;
      if (word[0] === "true") return true;
      if (word[0] === "false") return false;
      if (word[0] === "null") return null;
      if (word[0] === "undefined") return undefined;
    }
    throw fail();
  };
  const result = value();
  ws();
  if (i !== src.length) throw fail();
  return result;
}

/**
 * JS value carried by a prop: strings verbatim, shorthand booleans as true,
 * literal expressions parsed into plain data. Anything dynamic comes back as
 * UNPARSED.
 */
export function propJsValue(prop: MdxProp): unknown {
  if (prop.kind === "string") return prop.value;
  if (prop.kind === "boolean") return true;
  if (prop.kind === "spread") return UNPARSED;
  try {
    return parseLiteral(prop.value.trim());
  } catch {
    return UNPARSED;
  }
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
  // Empty slots fit anything: absent members, and the "" placeholders the
  // form's add-item flow writes for every new list entry.
  if (value === undefined || value === null || value === "") return true;
  switch (field.type) {
    case "string":
    case "select":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "object":
      if (typeof value !== "object" || Array.isArray(value)) return false;
      return (field.fields ?? []).every((child) =>
        valueFits(child, (value as Record<string, unknown>)[child.name]),
      );
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

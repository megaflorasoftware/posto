import { isScalar } from "yaml";
import { parseFile } from "./frontmatter";

/**
 * Returns non-empty top-level scalar frontmatter values in their sidebar
 * representation. YAML numbers and booleans are normalized with `String`;
 * maps, sequences, nulls, and invalid frontmatter are omitted.
 */
export function scalarFrontmatter(content: string): Record<string, string> | null {
  const parsed = parseFile(content);
  if (parsed.error || !parsed.hadFrontmatter) return null;
  const values = parsed.doc.toJSON() as unknown;
  if (!values || typeof values !== "object" || Array.isArray(values)) return null;

  const pairs: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string" && value.trim() !== "") {
      pairs[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      const node = parsed.doc.get(key, true);
      // The YAML package accepts leading-zero integers as numbers even though
      // the editor's filename/sort metadata treats that spelling as an ID.
      if (
        typeof value === "number" &&
        isScalar(node) &&
        typeof node.source === "string" &&
        /^[+-]?0\d+$/.test(node.source)
      ) {
        pairs[key] = node.source;
      } else {
        pairs[key] = String(value);
      }
    }
  }
  return Object.keys(pairs).length > 0 ? pairs : null;
}

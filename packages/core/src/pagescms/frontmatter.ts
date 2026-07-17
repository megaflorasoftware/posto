import { Document, Scalar, YAMLSeq, isSeq, parseDocument, visit } from "yaml";

// Frontmatter round-tripping. Edits go through the retained YAML Document so
// comments, key order, quoting style, and keys the schema doesn't know about
// all survive a form edit.

export interface ParsedFile {
  doc: Document;
  body: string;
  hadFrontmatter: boolean;
  /** Set when a frontmatter block exists but is not valid YAML. */
  error?: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n?---(\r?\n|$)/;

export function parseFile(content: string): ParsedFile {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { doc: new Document({}), body: content, hadFrontmatter: false };
  }
  const doc = parseDocument(match[1]);
  const body = content.slice(match[0].length);
  const error = doc.errors.length > 0 ? doc.errors[0].message : undefined;
  return { doc, body, hadFrontmatter: true, error };
}

export function serializeFile(parsed: ParsedFile): string {
  const empty =
    parsed.doc.contents == null ||
    (typeof (parsed.doc.contents as { items?: unknown[] }).items !== "undefined" &&
      (parsed.doc.contents as { items: unknown[] }).items.length === 0);
  if (!parsed.hadFrontmatter && empty) return parsed.body;
  // lineWidth: 0 disables wrapping so long scalar values stay on one line.
  const yamlText = empty ? "" : parsed.doc.toString({ lineWidth: 0 });
  return `---\n${yamlText}---\n${parsed.body}`;
}

export type ValuePath = (string | number)[];

export function getValue(doc: Document, path: ValuePath): unknown {
  const node = doc.getIn(path, true);
  if (node == null) return undefined;
  return (node as { toJS?: (doc: Document) => unknown }).toJS?.(doc) ?? doc.getIn(path);
}

/** Node for `value` with every string scalar double-quoted (map keys stay
 * plain). Explicit quotes keep saved strings from being reparsed as YAML
 * numbers, booleans, or dates. */
function quotedNode(doc: Document, value: unknown) {
  const node = doc.createNode(value);
  visit(node, {
    Scalar(key, scalar) {
      if (key !== "key" && typeof scalar.value === "string") {
        scalar.type = Scalar.QUOTE_DOUBLE;
      }
    },
  });
  return node;
}

export function setValue(doc: Document, path: ValuePath, value: unknown): void {
  doc.setIn(path, quotedNode(doc, value));
}

export function deleteValue(doc: Document, path: ValuePath): void {
  doc.deleteIn(path);
}

function seqAt(doc: Document, path: ValuePath): YAMLSeq | null {
  const node = doc.getIn(path, true);
  return isSeq(node) ? node : null;
}

/** Number of items in the list at `path` (0 when absent or not a list). */
export function listLength(doc: Document, path: ValuePath): number {
  return seqAt(doc, path)?.items.length ?? 0;
}

export function appendListItem(doc: Document, path: ValuePath, value: unknown): void {
  const seq = seqAt(doc, path);
  if (seq) {
    seq.items.push(quotedNode(doc, value));
  } else {
    doc.setIn(path, quotedNode(doc, [value]));
  }
}

export function removeListItem(doc: Document, path: ValuePath, index: number): void {
  seqAt(doc, path)?.items.splice(index, 1);
}

/** Swaps adjacent items; moving nodes wholesale keeps their comments. */
export function moveListItem(doc: Document, path: ValuePath, from: number, to: number): void {
  const seq = seqAt(doc, path);
  if (!seq || to < 0 || to >= seq.items.length) return;
  const [item] = seq.items.splice(from, 1);
  seq.items.splice(to, 0, item);
}

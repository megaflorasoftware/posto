/**
 * MDX-specific parsing for the rich body editor: ESM import statements, JSX
 * component blocks, and the raw constructs we preserve verbatim (exports,
 * block-level expressions, inline JSX). Everything here is plain string
 * scanning — no real JS parser — tuned for how components are written in
 * markdown content, not for arbitrary code.
 */

export interface MdxProp {
  name: string;
  /** Raw value text: unquoted for strings, brace-inner for expressions. */
  value: string;
  kind: "string" | "expression" | "boolean" | "spread";
}

export interface JsxBlock {
  raw: string;
  name: string;
  /** Text between the component name and the tag close, verbatim. */
  propsSource: string;
  /** Verbatim children source, or null for self-closing tags. */
  children: string | null;
}

/** Scans `{…}` starting at `i` (which must be `{`), respecting strings. */
function scanBraces(src: string, i: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Scans an opening tag from `<Name`; returns null if it never closes. */
function scanOpenTagWith(
  src: string,
  namePattern: RegExp,
): {
  end: number;
  selfClosing: boolean;
  name: string;
  propsSource: string;
} | null {
  const nameMatch = namePattern.exec(src);
  if (!nameMatch) return null;
  let quote: string | null = null;
  for (let i = nameMatch[0].length; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "{") {
      const end = scanBraces(src, i);
      if (end === -1) return null;
      i = end - 1;
    } else if (ch === ">") {
      const selfClosing = src[i - 1] === "/";
      return {
        end: i + 1,
        selfClosing,
        name: nameMatch[1],
        propsSource: src.slice(nameMatch[0].length, selfClosing ? i - 1 : i),
      };
    }
  }
  return null;
}

/** Component tags start with a capital; any-element scanning also takes
 * lowercase HTML tags (used when splitting children into slots). */
const COMPONENT_NAME = /^<([A-Z][\w.]*)/;
const ANY_TAG_NAME = /^<([A-Za-z][\w.-]*)/;

/**
 * Scans a full JSX element (`<Name …/>` or `<Name …>…</Name>`) at the start
 * of `src`, tracking nesting of same-named tags inside the children.
 */
function scanElementWith(src: string, namePattern: RegExp): JsxBlock | null {
  const open = scanOpenTagWith(src, namePattern);
  if (!open) return null;
  if (open.selfClosing) {
    return {
      raw: src.slice(0, open.end),
      name: open.name,
      propsSource: open.propsSource,
      children: null,
    };
  }
  const tagRe = new RegExp(`<${open.name}(?=[\\s/>])|</${open.name}\\s*>`, "g");
  tagRe.lastIndex = open.end;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(src))) {
    if (match[0].startsWith("</")) {
      depth--;
      if (depth === 0) {
        const end = match.index + match[0].length;
        return {
          raw: src.slice(0, end),
          name: open.name,
          propsSource: open.propsSource,
          children: src.slice(open.end, match.index),
        };
      }
    } else {
      const inner = scanOpenTagWith(src.slice(match.index), namePattern);
      if (inner) {
        if (!inner.selfClosing) depth++;
        tagRe.lastIndex = match.index + inner.end;
      }
    }
  }
  return null;
}

export function scanJsxBlock(src: string): JsxBlock | null {
  return scanElementWith(src, COMPONENT_NAME);
}

/** Like `scanJsxBlock`, but also matches lowercase HTML elements. */
export function scanAnyElement(src: string): JsxBlock | null {
  return scanElementWith(src, ANY_TAG_NAME);
}

/** HTML elements with no closing tag, per the HTML spec. */
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Elements that read as standalone blocks when they open a line; anything
 * else (`<kbd>`, `<abbr>`, …) stays inline even at a line start, matching how
 * CommonMark distinguishes HTML blocks from inline HTML. */
export const BLOCK_HTML_TAGS = new Set([
  "address",
  "article",
  "aside",
  "audio",
  "blockquote",
  "details",
  "dialog",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "iframe",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "script",
  "section",
  "style",
  "table",
  "ul",
  "video",
]);

/** Scans a lowercase HTML element at the start of `src`: paired tags (with
 * nesting), self-closing tags, and void elements written without a slash. */
export function scanHtmlElement(src: string): JsxBlock | null {
  if (!/^<[a-z]/.test(src)) return null;
  const el = scanAnyElement(src);
  if (el) return el;
  const open = scanOpenTagWith(src, ANY_TAG_NAME);
  if (open && VOID_ELEMENTS.has(open.name)) {
    return {
      raw: src.slice(0, open.end),
      name: open.name,
      propsSource: open.propsSource,
      children: null,
    };
  }
  return null;
}

/** Value of a tag's `slot="…"` attribute, or null when absent/dynamic. */
export function slotAttr(propsSource: string): string | null {
  const match = /(?:^|\s)slot\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(propsSource);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

/**
 * One extractable chunk of a named slot's content. `markdown` pieces are
 * editable rich content (Fragment innards, or a component element that
 * carries the slot attribute itself); `raw` pieces are HTML elements with a
 * slot attribute, preserved verbatim.
 */
export interface SlotPiece {
  kind: "markdown" | "raw";
  text: string;
}

export interface SlotBuckets {
  /** Default-slot markdown source (everything not routed to a named slot). */
  defaultContent: string;
  named: { name: string; pieces: SlotPiece[] }[];
}

/**
 * Splits a component's children source into the default slot and named-slot
 * buckets. Top-level elements with a literal `slot="…"` attribute feed the
 * named buckets: `<Fragment slot="x">` contributes its children as markdown,
 * a capitalized component contributes its whole tag as markdown (it keeps its
 * slot prop), and a lowercase HTML element is preserved verbatim. Everything
 * else stays in the default flow.
 */
export function splitSlots(children: string | null): SlotBuckets {
  const buckets: SlotBuckets = { defaultContent: "", named: [] };
  if (children === null) return buckets;
  const bucket = (name: string) => {
    let entry = buckets.named.find((n) => n.name === name);
    if (!entry) {
      entry = { name, pieces: [] };
      buckets.named.push(entry);
    }
    return entry;
  };
  let i = 0;
  while (i < children.length) {
    const offset = children.slice(i).search(/<[A-Za-z]/);
    if (offset === -1) {
      buckets.defaultContent += children.slice(i);
      break;
    }
    buckets.defaultContent += children.slice(i, i + offset);
    i += offset;
    const el = scanAnyElement(children.slice(i));
    const name = el ? slotAttr(el.propsSource) : null;
    if (!el || name === null) {
      // No slot attribute (or not a well-formed element): default flow.
      const len = el ? el.raw.length : 1;
      buckets.defaultContent += children.slice(i, i + len);
      i += len;
      continue;
    }
    if (el.name === "Fragment") {
      bucket(name).pieces.push({ kind: "markdown", text: el.children ?? "" });
    } else if (/^[A-Z]/.test(el.name)) {
      bucket(name).pieces.push({ kind: "markdown", text: el.raw });
    } else {
      bucket(name).pieces.push({ kind: "raw", text: el.raw });
    }
    i += el.raw.length;
  }
  return buckets;
}

/**
 * Removes the common leading indentation from every non-empty line. Slot
 * children are usually written indented inside their component tag; markdown
 * would read 4+ spaces as a code block and keep `  <Tag>` lines out of block
 * tokenizers (which only match at line starts), so slot content is dedented
 * before tokenizing. Nested components dedent their own children in turn.
 */
export function dedent(text: string): string {
  const lines = text.split("\n");
  let indent: number | null = null;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const width = /^[ \t]*/.exec(line)![0].length;
    indent = indent === null ? width : Math.min(indent, width);
  }
  if (indent === null || indent === 0) return text;
  return lines.map((line) => (line.trim() === "" ? line : line.slice(indent!))).join("\n");
}

/**
 * Rebuilds a children string from per-slot sources (inline-chip editing).
 * Named content already shaped as a single element carrying its own
 * `slot="…"` attribute is kept as-is; anything else wraps in
 * `<Fragment slot="…">`. Returns null when every slot is empty.
 */
export function assembleSlotChildren(
  defaultContent: string,
  named: { name: string; text: string }[],
): string | null {
  const parts: string[] = [];
  if (defaultContent.trim() !== "") parts.push(defaultContent);
  for (const { name, text } of named) {
    if (text.trim() === "") continue;
    const el = scanAnyElement(text.trim());
    if (el && el.raw === text.trim() && slotAttr(el.propsSource) === name) {
      parts.push(text.trim());
    } else {
      parts.push(`<Fragment slot="${name}">${text}</Fragment>`);
    }
  }
  return parts.length === 0 ? null : parts.join("");
}

/** Parses a tag's props source into fields; null when it isn't form-safe. */
export function parseProps(source: string): MdxProp[] | null {
  const props: MdxProp[] = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) {
      i++;
      continue;
    }
    if (source[i] === "{") {
      const end = scanBraces(source, i);
      if (end === -1) return null;
      const inner = source.slice(i + 1, end - 1).trim();
      if (!inner.startsWith("...")) return null;
      props.push({ name: "", value: inner, kind: "spread" });
      i = end;
      continue;
    }
    const name = /^[A-Za-z_][\w:-]*/.exec(source.slice(i));
    if (!name) return null;
    i += name[0].length;
    while (i < source.length && /\s/.test(source[i])) i++;
    if (source[i] !== "=") {
      props.push({ name: name[0], value: "true", kind: "boolean" });
      continue;
    }
    i++;
    while (i < source.length && /\s/.test(source[i])) i++;
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      const close = source.indexOf(ch, i + 1);
      if (close === -1) return null;
      props.push({ name: name[0], value: source.slice(i + 1, close), kind: "string" });
      i = close + 1;
    } else if (ch === "{") {
      const end = scanBraces(source, i);
      if (end === -1) return null;
      props.push({ name: name[0], value: source.slice(i + 1, end - 1), kind: "expression" });
      i = end;
    } else {
      return null;
    }
  }
  return props;
}

function serializeProp(prop: MdxProp): string {
  switch (prop.kind) {
    case "spread":
      return `{${prop.value}}`;
    case "boolean":
      return prop.value === "true" ? prop.name : `${prop.name}={${prop.value}}`;
    case "string":
      return prop.value.includes('"')
        ? `${prop.name}='${prop.value}'`
        : `${prop.name}="${prop.value}"`;
    default:
      return `${prop.name}={${prop.value}}`;
  }
}

/** Rebuilds a component's source after form edits. */
export function serializeJsx(name: string, props: MdxProp[], children: string | null): string {
  const kept = props.filter((p) => p.kind === "boolean" || p.kind === "spread" || p.value !== "");
  const propsPart = kept.length ? " " + kept.map(serializeProp).join(" ") : "";
  if (children === null) return `<${name}${propsPart} />`;
  return `<${name}${propsPart}>${children}</${name}>`;
}

export interface ImportInfo {
  /** Imported bindings (default and named, using local alias names). */
  names: string[];
  /** Module specifier, e.g. `../components/CaptionedImage.astro`. */
  spec: string | null;
}

export function importInfo(statement: string): ImportInfo {
  const match =
    /^import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*(?:from\s+)?['"]([^'"]+)['"]/.exec(
      statement.replace(/\s+/g, " "),
    );
  if (!match) return { names: [], spec: null };
  const names: string[] = [];
  if (match[1]) names.push(match[1]);
  if (match[2]) {
    for (const part of match[2].split(",")) {
      const binding = part.trim();
      if (binding === "") continue;
      const alias = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(binding);
      names.push(alias ? alias[1] : binding);
    }
  }
  return { names, spec: match[3] };
}

/** Collects import statements (including multi-line named imports). */
export function extractImports(markdown: string): string[] {
  const statements: string[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^import\s/.test(lines[i])) continue;
    let statement = lines[i];
    while (
      (statement.match(/\{/g)?.length ?? 0) > (statement.match(/\}/g)?.length ?? 0) &&
      i + 1 < lines.length
    ) {
      statement += "\n" + lines[++i];
    }
    statements.push(statement);
  }
  return statements;
}

/**
 * Splits the leading import block from an MDX body: import statements (and
 * blank lines between them) up to the first other content. Mid-document
 * imports stay in the body — restricting to the leading block means fenced
 * code that happens to contain `import` lines is never touched.
 */
export function splitLeadingImports(markdown: string): { imports: string[]; body: string } {
  const lines = markdown.split("\n");
  const imports: string[] = [];
  let consumed = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (!/^import\s/.test(lines[i])) break;
    let statement = lines[i];
    while (
      (statement.match(/\{/g)?.length ?? 0) > (statement.match(/\}/g)?.length ?? 0) &&
      i + 1 < lines.length
    ) {
      statement += "\n" + lines[++i];
    }
    imports.push(statement);
    consumed = i + 1;
  }
  if (imports.length === 0) return { imports, body: markdown };
  return { imports, body: lines.slice(consumed).join("\n").replace(/^\n+/, "") };
}

/** Resolves `./x` / `../x` against the directory of `filePath`; null for bare
 * or aliased specifiers we can't locate. */
export function resolveImportPath(filePath: string, spec: string): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const segments = filePath.split("/").slice(0, -1);
  for (const part of spec.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

/** Relative module specifier importing `toFile` from `fromFile`'s directory. */
export function relativeImportPath(fromFile: string, toFile: string): string {
  const from = fromFile.split("/").slice(0, -1);
  const to = toFile.split("/");
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  const ups = from.length - common;
  const down = to.slice(common).join("/");
  return ups === 0 ? `./${down}` : `${"../".repeat(ups)}${down}`;
}

/** Component name for a file: `captioned-image.astro` → `CaptionedImage`. */
export function componentNameFromFile(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "");
  return base
    .split(/[-_. ]+/)
    .filter((part) => part !== "")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

export interface AstroPropDef {
  name: string;
  type: string;
  optional: boolean;
}

/** Prop and slot declarations read from an Astro component's source. */
export interface AstroComponentSchema {
  props: AstroPropDef[];
  /** A non-object-literal `type Props = …` resolved to canonical Astro type
   * names. The editor can expand collection `data` aliases using its schemas. */
  propsType?: string;
  /** Named slots (`<slot name="…">`) declared in the template, in order. */
  slots: string[];
  /** Whether the template declares a default (unnamed) `<slot>`. */
  hasDefaultSlot: boolean;
}

/**
 * Slots declared in an Astro component's template: named slots in source
 * order, plus whether an unnamed (default) slot exists. Components without
 * any `<slot>` take no children, so their cards render no slot sections.
 */
export function parseAstroSlots(source: string): { named: string[]; hasDefault: boolean } {
  const fence = source.match(/^---\r?\n[\s\S]*?\r?\n---/);
  const template = fence ? source.slice(fence[0].length) : source;
  const named: string[] = [];
  let hasDefault = false;
  for (const tag of template.matchAll(/<slot\b([^>]*)>/g)) {
    const name = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag[1]);
    const value = name?.[1] ?? name?.[2];
    if (value === undefined) hasDefault = true;
    else if (!named.includes(value)) named.push(value);
  }
  return { named, hasDefault };
}

/**
 * Parses the members of a TypeScript object-type body (the text between the
 * braces) into prop definitions. Members split on top-level `;`, `,`, or
 * newline; methods are skipped. Used for the `Props` interface and,
 * recursively, for inline object types inside prop declarations.
 */
export function parseTypeMembers(body: string): AstroPropDef[] {
  const defs: AstroPropDef[] = [];
  let depth = 0;
  let quote: string | null = null;
  let member = "";
  const flush = () => {
    const m = /^\s*(?:readonly\s+)?([A-Za-z_]\w*)(\?)?\s*:\s*([\s\S]+?)[;,]?\s*$/.exec(member);
    if (m) {
      defs.push({ name: m[1], optional: m[2] === "?", type: m[3].trim() });
    }
    member = "";
  };
  for (const ch of body) {
    if (quote) {
      member += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{" || ch === "(" || ch === "<") depth++;
    else if (ch === "}" || ch === ")" || ch === ">") depth--;
    if (depth === 0 && (ch === ";" || ch === "\n" || ch === ",")) flush();
    else member += ch;
  }
  flush();
  return defs;
}

const ASTRO_CONTENT_TYPES = new Set(["CollectionEntry", "CollectionKey", "SchemaContext"]);

/** Canonical names for `astro:content` type imports, including aliases and a
 * namespace import. This lets the field resolver operate on one spelling. */
function astroContentTypeAliases(script: string): {
  aliases: Map<string, string>;
  namespaces: string[];
} {
  const aliases = new Map<string, string>();
  const namespaces: string[] = [];
  const named = /import\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+["']astro:content["']/g;
  for (const statement of script.matchAll(named)) {
    for (const raw of statement[1].split(",")) {
      const part = raw.trim().replace(/^type\s+/, "");
      const match = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(part);
      if (!match || !ASTRO_CONTENT_TYPES.has(match[1])) continue;
      aliases.set(match[2] ?? match[1], match[1]);
    }
  }
  const namespace = /import\s+(?:type\s+)?\*\s+as\s+(\w+)\s+from\s+["']astro:content["']/g;
  for (const statement of script.matchAll(namespace)) namespaces.push(statement[1]);
  return { aliases, namespaces };
}

function replaceTypeName(source: string, from: string, to: string): string {
  return source.replace(new RegExp(`\\b${from}\\b`, "g"), to);
}

function canonicalAstroContentType(
  type: string,
  aliases: Map<string, string>,
  namespaces: string[],
): string {
  let resolved = type.replace(
    /import\s*\(\s*["']astro:content["']\s*\)\s*\.\s*(CollectionEntry|CollectionKey|SchemaContext)/g,
    "$1",
  );
  for (const namespace of namespaces) {
    resolved = resolved.replace(
      new RegExp(`\\b${namespace}\\s*\\.\\s*(CollectionEntry|CollectionKey|SchemaContext)\\b`, "g"),
      "$1",
    );
  }
  // Local aliases may point at an imported alias, so repeat to a fixed point.
  for (let pass = 0; pass < aliases.size + 1; pass++) {
    const before = resolved;
    for (const [from, to] of aliases) resolved = replaceTypeName(resolved, from, to);
    if (resolved === before) break;
  }
  return resolved;
}

/** Non-generic local aliases such as
 * `type PostData = CollectionEntry<'posts'>['data']`. */
function localTypeAliases(
  script: string,
  aliases: Map<string, string>,
  namespaces: string[],
): void {
  const declaration = /(?:export\s+)?type\s+(\w+)\s*=\s*/g;
  for (let match = declaration.exec(script); match; match = declaration.exec(script)) {
    let depth = 0;
    let quote: string | null = null;
    let end = match.index + match[0].length;
    for (; end < script.length; end++) {
      const ch = script[end];
      if (quote) {
        if (ch === "\\") end++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
      } else if ("<([{".includes(ch)) {
        depth++;
      } else if (">)]}".includes(ch)) {
        depth--;
      } else if (ch === ";" && depth === 0) {
        break;
      }
    }
    if (end >= script.length) continue;
    const value = script.slice(match.index + match[0].length, end).trim();
    if (value !== "") aliases.set(match[1], canonicalAstroContentType(value, aliases, namespaces));
    declaration.lastIndex = end + 1;
  }
}

/**
 * Extracts the `Props` interface (or `type Props = {…}`) from an Astro
 * component's frontmatter script. Only top-level members are read as
 * definitions; inline object types stay in the member's type text.
 */
export function parseAstroProps(
  source: string,
  importedTypes: Record<string, string> = {},
): AstroPropDef[] {
  const fence = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const script = fence ? fence[1] : source;
  const { aliases, namespaces } = astroContentTypeAliases(script);
  for (const [name, type] of Object.entries(importedTypes)) aliases.set(name, type);
  localTypeAliases(script, aliases, namespaces);
  const head =
    /(?:export\s+)?(?:interface\s+Props(?:\s+extends\s+[^{]+)?\s*|type\s+Props\s*=\s*)\{/.exec(
      script,
    );
  if (!head) return [];
  const bodyStart = head.index + head[0].length;
  const end = scanBraces(script, head.index + head[0].length - 1);
  if (end === -1) return [];
  return parseTypeMembers(script.slice(bodyStart, end - 1)).map((def) => ({
    ...def,
    type: canonicalAstroContentType(def.type, aliases, namespaces),
  }));
}

/** Returns a non-object-literal `type Props = …` expression. This covers the
 * common `type Props = CollectionEntry<'posts'>['data']` shape, whose members
 * can only be expanded once generated collection schemas are available. */
export function parseAstroPropsType(
  source: string,
  importedTypes: Record<string, string> = {},
): string | null {
  const fence = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const script = fence ? fence[1] : source;
  const { aliases, namespaces } = astroContentTypeAliases(script);
  for (const [name, type] of Object.entries(importedTypes)) aliases.set(name, type);
  localTypeAliases(script, aliases, namespaces);
  const alias = aliases.get("Props");
  if (!alias || alias.trim().startsWith("{")) return null;
  return canonicalAstroContentType(alias, aliases, namespaces);
}

/** Resolves one exported interface/type from an Astro frontmatter script.
 * Used by component schema loading to follow relative `import type` aliases. */
export function parseAstroExportedType(source: string, name: string): string | null {
  const fence = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const script = fence ? fence[1] : source;
  const { aliases, namespaces } = astroContentTypeAliases(script);
  localTypeAliases(script, aliases, namespaces);

  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const interfaceHead = new RegExp(
    `export\\s+interface\\s+${escaped}(?:\\s+extends\\s+[^\\{]+)?\\s*\\{`,
  ).exec(script);
  if (interfaceHead) {
    const open = interfaceHead.index + interfaceHead[0].lastIndexOf("{");
    const end = scanBraces(script, open);
    if (end !== -1) {
      return canonicalAstroContentType(script.slice(open, end), aliases, namespaces);
    }
  }

  const exportedType = new RegExp(`export\\s+type\\s+${escaped}\\s*=`).test(script);
  const alias = exportedType ? aliases.get(name) : null;
  return alias ? canonicalAstroContentType(alias, aliases, namespaces) : null;
}

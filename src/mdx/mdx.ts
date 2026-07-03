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
function scanOpenTag(src: string): {
  end: number;
  selfClosing: boolean;
  name: string;
  propsSource: string;
} | null {
  const nameMatch = /^<([A-Z][\w.]*)/.exec(src);
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

/**
 * Scans a full JSX element (`<Name …/>` or `<Name …>…</Name>`) at the start
 * of `src`, tracking nesting of same-named tags inside the children.
 */
export function scanJsxBlock(src: string): JsxBlock | null {
  const open = scanOpenTag(src);
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
      const inner = scanOpenTag(src.slice(match.index));
      if (inner) {
        if (!inner.selfClosing) depth++;
        tagRe.lastIndex = match.index + inner.end;
      }
    }
  }
  return null;
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

/**
 * Extracts the `Props` interface (or `type Props = {…}`) from an Astro
 * component's frontmatter script. Only top-level members are read; nested
 * object types and methods are skipped.
 */
export function parseAstroProps(source: string): AstroPropDef[] {
  const fence = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const script = fence ? fence[1] : source;
  const head = /(?:export\s+)?(?:interface\s+Props(?:\s+extends\s+[^{]+)?\s*|type\s+Props\s*=\s*)\{/.exec(
    script,
  );
  if (!head) return [];
  const bodyStart = head.index + head[0].length;
  const end = scanBraces(script, head.index + head[0].length - 1);
  if (end === -1) return [];
  const body = script.slice(bodyStart, end - 1);

  const defs: AstroPropDef[] = [];
  let depth = 0;
  let member = "";
  const flush = () => {
    const m = /^\s*(?:readonly\s+)?([A-Za-z_]\w*)(\?)?\s*:\s*([\s\S]+?)[;,]?\s*$/.exec(member);
    if (m && !m[3].includes("(")) {
      defs.push({ name: m[1], optional: m[2] === "?", type: m[3].trim() });
    }
    member = "";
  };
  for (const ch of body) {
    if (ch === "{" || ch === "(" || ch === "<") depth++;
    else if (ch === "}" || ch === ")" || ch === ">") depth--;
    if (depth === 0 && (ch === ";" || ch === "\n")) flush();
    else member += ch;
  }
  flush();
  return defs;
}

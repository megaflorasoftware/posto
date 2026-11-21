/**
 * The parts of a markdown or MDX body that the native editor shows as cards
 * or pills instead of text: the same elements the desktop body editor turns
 * into custom nodes (packages/editor MdxNodes, HtmlNodes, EditableImage).
 *
 * - MDX components: a card when the tag opens a line, a pill inside text
 * - import statements: a pill
 * - raw MDX blocks (exports, block expressions): a code card
 * - HTML elements: a pill (block elements stand on their own line)
 * - images: a thumbnail, full width when the image is its own paragraph
 *
 * Headings, emphasis, lists, links and code stay styled text. Fenced and
 * indented code and inline code spans are never scanned. Offsets are UTF-16
 * code units, as UITextView counts them.
 */
import {
  BLOCK_HTML_TAGS,
  importInfo,
  parseProps,
  scanHtmlElement,
  scanJsxBlock,
  splitSlots,
  type JsxBlock,
} from "@posto/core/mdx/mdx";

export type BodyEmbedKind = "component" | "import" | "raw" | "html" | "image";

export interface BodyEmbed {
  kind: BodyEmbedKind;
  start: number;
  end: number;
  /** Stands on its own lines (a card), rather than inside a paragraph. */
  block: boolean;
  /** Component or tag name, imported names, "Export", or the image's alt. */
  label: string;
  /** Props summary for components; a source excerpt for everything else. */
  detail: string | null;
  /** Plain-text children, for components. */
  preview: string | null;
  /** Images: the markdown `src` and alt text. */
  src?: string;
  alt?: string;
}

const IMAGE = /^!\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^\s)\n]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/;

export function scanBodyEmbeds(text: string, mdx: boolean): BodyEmbed[] {
  const embeds: BodyEmbed[] = [];
  let fence: string | null = null;
  let previousBlank = true;
  let pos = 0;
  while (pos < text.length) {
    const lineEnd = lineEndAt(text, pos);
    const line = text.slice(pos, lineEnd);
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        if (line.trim() === fenceMatch[1]) fence = null;
      }
      pos = lineEnd + 1;
      previousBlank = false;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      pos = lineEnd + 1;
      previousBlank = false;
      continue;
    }
    if (line.trim() === "") {
      previousBlank = true;
      pos = lineEnd + 1;
      continue;
    }
    // An indented code block starts after a blank line.
    if (previousBlank && /^( {4}|\t)/.test(line)) {
      pos = lineEnd + 1;
      continue;
    }
    const block = blockEmbedAt(text, pos, lineEnd, mdx, previousBlank);
    let from = pos;
    if (block) {
      embeds.push(block);
      from = block.end;
    }
    // Inline content: the rest of the line (after a block that ended mid-line,
    // or the whole line). Inline elements may run onto later lines.
    const scanTo = from <= lineEnd ? lineEnd : lineEndAt(text, from);
    const stopped = scanInline(text, from, scanTo, mdx, embeds);
    pos = stopped + 1;
    previousBlank = false;
  }
  return embeds;
}

function lineEndAt(text: string, pos: number): number {
  const end = text.indexOf("\n", pos);
  return end === -1 ? text.length : end;
}

function blockEmbedAt(
  text: string,
  pos: number,
  lineEnd: number,
  mdx: boolean,
  previousBlank: boolean,
): BodyEmbed | null {
  const rest = text.slice(pos);
  if (mdx && /^import\s/.test(rest)) {
    const raw = extendLines(rest, (s) => count(s, /\{/g) > count(s, /\}/g));
    const names = importInfo(raw).names;
    return embed(
      "import",
      pos,
      raw,
      true,
      names.length > 0 ? names.join(", ") : "Import",
      excerpt(raw),
    );
  }
  if (mdx && /^export\s/.test(rest)) {
    const raw = extendLines(rest, (s) => count(s, /[{(]/g) > count(s, /[})]/g));
    return embed("raw", pos, raw, true, "Export", excerpt(raw));
  }
  if (mdx && rest.startsWith("{")) {
    const end = balancedBraceEnd(rest);
    if (end === -1) return null;
    const raw = rest.slice(0, end);
    return embed("raw", pos, raw, true, "Expression", excerpt(raw));
  }
  if (mdx && /^<[A-Z]/.test(rest)) {
    const block = scanJsxBlock(rest);
    return block ? componentEmbed(pos, block, true) : null;
  }
  if (/^<[A-Za-z_:]/.test(rest)) {
    const element = scanHtmlElement(rest);
    if (
      element &&
      (BLOCK_HTML_TAGS.has(element.name.toLowerCase()) ||
        /^[ \t\r]*(\n|$)/.test(rest.slice(element.raw.length)))
    ) {
      return htmlEmbed(pos, element.raw, true);
    }
    return null;
  }
  // A paragraph that is only an image is a block image.
  const line = text.slice(pos, lineEnd);
  const image = IMAGE.exec(line.trimStart());
  if (previousBlank && image && line.trim() === image[0]) {
    const next = text.slice(lineEnd + 1, lineEndAt(text, lineEnd + 1));
    if (lineEnd >= text.length || next.trim() === "") {
      const start = pos + (line.length - line.trimStart().length);
      return imageEmbed(start, image, true);
    }
  }
  return null;
}

/** Scans inline content from `from` to `to`; returns where it stopped (at or
 * past `to`, when an element ran onto later lines). */
function scanInline(
  text: string,
  from: number,
  to: number,
  mdx: boolean,
  out: BodyEmbed[],
): number {
  let i = from;
  let end = to;
  while (i < end) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      const run = /^`+/.exec(text.slice(i, end))![0];
      const close = text.indexOf(run, i + run.length);
      i = close !== -1 && close < end ? close + run.length : i + run.length;
      continue;
    }
    if (ch === "!" && text[i + 1] === "[") {
      const image = IMAGE.exec(text.slice(i, end));
      if (image) {
        out.push(imageEmbed(i, image, false));
        i += image[0].length;
        continue;
      }
    }
    if (ch === "<") {
      const rest = text.slice(i);
      if (mdx && /^<[A-Z]/.test(rest)) {
        const block = scanJsxBlock(rest);
        if (block) {
          out.push(componentEmbed(i, block, false));
          i += block.raw.length;
          if (i > end) end = lineEndAt(text, i);
          continue;
        }
      } else if (/^<[A-Za-z_:]/.test(rest)) {
        const element = scanHtmlElement(rest);
        if (element) {
          out.push(htmlEmbed(i, element.raw, false));
          i += element.raw.length;
          if (i > end) end = lineEndAt(text, i);
          continue;
        }
      }
    }
    i++;
  }
  return Math.max(i, end);
}

function embed(
  kind: BodyEmbedKind,
  start: number,
  raw: string,
  block: boolean,
  label: string,
  detail: string | null,
  preview: string | null = null,
): BodyEmbed {
  return { kind, start, end: start + raw.length, block, label, detail, preview };
}

function componentEmbed(start: number, block: JsxBlock, isBlock: boolean): BodyEmbed {
  return embed(
    "component",
    start,
    block.raw,
    isBlock,
    block.name,
    propsSummary(block.propsSource),
    childrenPreview(block.children),
  );
}

function htmlEmbed(start: number, raw: string, block: boolean): BodyEmbed {
  // The tag name when the source is one element (as on desktop).
  const element = scanHtmlElement(raw.trim());
  const label = element && element.raw === raw.trim() ? element.name : "HTML";
  return embed("html", start, raw, block, label, excerpt(plainText(raw)) || excerpt(raw));
}

function imageEmbed(start: number, match: RegExpExecArray, block: boolean): BodyEmbed {
  const alt = match[1];
  const src = match[2].replace(/^<|>$/g, "");
  const name = src.slice(src.lastIndexOf("/") + 1) || "Image";
  return { ...embed("image", start, match[0], block, alt || name, null), src, alt };
}

/** `kind: tip · width: {640}`, or the raw props when they don't parse. */
export function propsSummary(propsSource: string): string | null {
  const props = parseProps(propsSource);
  if (props === null) return clip(propsSource.trim().replace(/\s+/g, " "), 160) || null;
  const parts = props.map((prop) => {
    switch (prop.kind) {
      case "boolean":
        return prop.value === "true" ? prop.name : `${prop.name}: ${prop.value}`;
      case "spread":
        return `{${prop.value}}`;
      case "string":
        return `${prop.name}: ${prop.value}`;
      default:
        return `${prop.name}: {${prop.value.replace(/\s+/g, " ")}}`;
    }
  });
  return parts.length > 0 ? clip(parts.join(" · "), 160) : null;
}

function childrenPreview(children: string | null): string | null {
  if (children === null) return null;
  const buckets = splitSlots(children);
  const source =
    buckets.defaultContent.trim() !== ""
      ? buckets.defaultContent
      : buckets.named.flatMap((slot) => slot.pieces.map((piece) => piece.text)).join(" ");
  return clip(plainText(source), 200) || null;
}

/** Markdown and markup reduced to the words a reader sees. */
function plainText(source: string): string {
  return source
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function excerpt(source: string): string {
  return clip(source.trim(), 400);
}

function clip(text: string, length: number): string {
  return text.length > length ? text.slice(0, length - 1).trimEnd() + "…" : text;
}

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/** The first line, extended a line at a time while `open` holds. */
function extendLines(src: string, open: (raw: string) => boolean): string {
  let raw = /^[^\n]*/.exec(src)![0];
  let rest = src.slice(raw.length);
  while (open(raw) && rest.startsWith("\n")) {
    const line = /^\n[^\n]*/.exec(rest)![0];
    raw += line;
    rest = rest.slice(line.length);
  }
  return raw;
}

function balancedBraceEnd(src: string): number {
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

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

// Alt text may hold escaped brackets; a bare source may hold balanced
// parentheses (`foo(1).png`), as CommonMark allows.
const IMAGE =
  /^!\[((?:\\.|[^\]\\\n])*)\]\(\s*(<[^>\n]*>|(?:[^\s()\n]|\([^\s()\n]*\))+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/;

/** Blockquote markers and a list item marker before a line's content: code
 * fences inside quotes and list items still fence. */
const CONTAINER = /^(?:[ \t]*>[ \t]?)*(?:[ \t]*(?:[-*+]|\d+[.)])[ \t]+)?/;

export function scanBodyEmbeds(text: string, mdx: boolean): BodyEmbed[] {
  const embeds: BodyEmbed[] = [];
  const scan = new Scan(text, mdx);
  let fence: string | null = null;
  let previousBlank = true;
  let pos = 0;
  while (pos < text.length) {
    const lineEnd = lineEndAt(text, pos);
    const line = text.slice(pos, lineEnd);
    const content = line.replace(CONTAINER, "");
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(content);
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        if (content.trim() === fenceMatch[1]) fence = null;
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
    const block = blockEmbedAt(scan, pos, lineEnd);
    let from = pos;
    if (block) {
      embeds.push(block);
      from = block.end;
    }
    // Inline content: the rest of the line (after a block that ended mid-line,
    // or the whole line). Inline elements may run onto later lines.
    const scanTo = from <= lineEnd ? lineEnd : lineEndAt(text, from);
    const stopped = scanInline(scan, from, scanTo, embeds);
    pos = stopped + 1;
    previousBlank = false;
  }
  return embeds;
}

function lineEndAt(text: string, pos: number): number {
  const end = text.indexOf("\n", pos);
  return end === -1 ? text.length : end;
}

/** One scan of a body: the text, plus where each tag name last closes, so
 * an element that never closes isn't searched for to the end of the body
 * at every occurrence (thousands of unclosed `<p>`s would be quadratic). */
class Scan {
  private lastClose = new Map<string, number>();

  constructor(
    readonly text: string,
    readonly mdx: boolean,
  ) {}

  /** The element (or component) at `at`, scanned no further than it can
   * reach: when its tag never closes after `at`, only to the paragraph's
   * end, where a self-closing tag still ends. */
  element(at: number, component: boolean): JsxBlock | null {
    const name = /^<([A-Za-z_:][\w:.-]*)/.exec(this.text.slice(at, at + 200))?.[1];
    if (!name) return null;
    let close = this.lastClose.get(name);
    if (close === undefined) {
      close = this.text.lastIndexOf(`</${name}`);
      this.lastClose.set(name, close);
    }
    const limit = close > at ? this.text.length : paragraphEnd(this.text, at);
    const source = this.text.slice(at, limit);
    return component ? scanJsxBlock(source) : scanHtmlElement(source);
  }
}

/** Where the paragraph holding `at` ends: its next blank line. */
function paragraphEnd(text: string, at: number): number {
  const blank = /\n[ \t\r]*(?:\n|$)/g;
  blank.lastIndex = at;
  return blank.exec(text)?.index ?? text.length;
}

function blockEmbedAt(scan: Scan, pos: number, lineEnd: number): BodyEmbed | null {
  const { text, mdx } = scan;
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
    const block = scan.element(pos, true);
    return block ? componentEmbed(pos, block, true) : null;
  }
  if (/^<[A-Za-z_:]/.test(rest)) {
    const element = scan.element(pos, false);
    if (
      element &&
      (BLOCK_HTML_TAGS.has(element.name.toLowerCase()) ||
        /^[ \t\r]*(\n|$)/.test(rest.slice(element.raw.length)))
    ) {
      return htmlEmbed(pos, element.raw, true);
    }
    return null;
  }
  // A line that is only an image is a block image, as on desktop (marked
  // ends a paragraph where the image line starts).
  const line = text.slice(pos, lineEnd);
  const image = IMAGE.exec(line.trimStart());
  if (image && line.trim() === image[0]) {
    const start = pos + (line.length - line.trimStart().length);
    return imageEmbed(start, image, true);
  }
  return null;
}

/** Scans inline content from `from` to `to`; returns where it stopped (at or
 * past `to`, when an element ran onto later lines). */
function scanInline(scan: Scan, from: number, to: number, out: BodyEmbed[]): number {
  const { text, mdx } = scan;
  let i = from;
  let end = to;
  while (i < end) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      // A code span may run onto the paragraph's later lines.
      const run = /^`+/.exec(text.slice(i, end))![0];
      const close = text.indexOf(run, i + run.length);
      if (close !== -1 && close < paragraphEnd(text, i)) {
        i = close + run.length;
        if (i > end) end = lineEndAt(text, i);
      } else {
        i += run.length;
      }
      continue;
    }
    if (text.startsWith("<!--", i)) {
      // Comments are hidden source, not elements.
      const close = text.indexOf("-->", i + 4);
      i = close === -1 ? text.length : close + 3;
      if (i > end) end = lineEndAt(text, i);
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
      const next = text[i + 1] ?? "";
      if (mdx && /[A-Z]/.test(next)) {
        const block = scan.element(i, true);
        if (block) {
          out.push(componentEmbed(i, block, false));
          i += block.raw.length;
          if (i > end) end = lineEndAt(text, i);
          continue;
        }
      } else if (/[A-Za-z_:]/.test(next)) {
        const element = scan.element(i, false);
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
  const alt = match[1].replace(/\\(.)/g, "$1");
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

/** At most `length` UTF-16 units, never splitting a surrogate pair (a lone
 * half doesn't survive JSON decoding on the Swift side). */
function clip(text: string, length: number): string {
  if (text.length <= length) return text;
  let cut = length - 1;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut--;
  return text.slice(0, cut).trimEnd() + "…";
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

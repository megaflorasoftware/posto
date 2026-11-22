// Search and social metadata from a rendered page's HTML, read without a DOM
// so it runs where there is no DOMParser (the iOS engine's JavaScriptCore).
// It answers the way DOMParser + querySelector do for the tags the previews
// read: the first matching element in document order wins, comments and the
// contents of scripts, styles and templates are not markup, and the values
// are the decoded attribute and title text.

export interface SeoData {
  title: string | null;
  description: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  ogUrl: string | null;
  ogSiteName: string | null;
  twitterCard: string | null;
  twitterTitle: string | null;
  twitterDescription: string | null;
  twitterImage: string | null;
  canonical: string | null;
  favicon: string | null;
}

type Attributes = Record<string, string>;

interface Element {
  name: string;
  attributes: Attributes;
  /** Decoded text, for `<title>` (the only element whose text is read). */
  text?: string;
}

/** Elements whose contents are text up to their end tag, not markup.
 * `title` and `textarea` decode character references; the rest don't. */
const RAW_TEXT = new Set([
  "script",
  "style",
  "title",
  "textarea",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "template",
]);

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isSpace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r" || char === "\f";
}

/** Every start tag in document order, with its attributes. */
function* elements(html: string): Generator<Element> {
  const length = html.length;
  let index = 0;
  while (index < length) {
    const open = html.indexOf("<", index);
    if (open === -1) return;
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      index = close === -1 ? length : close + 3;
      continue;
    }
    const next = html[open + 1];
    if (next === "!" || next === "?" || next === "/") {
      // Doctype, bogus comment or end tag.
      const close = html.indexOf(">", open + 2);
      index = close === -1 ? length : close + 1;
      continue;
    }
    if (next === undefined || !isAsciiLetter(next.charCodeAt(0))) {
      index = open + 1;
      continue;
    }
    // Tag name.
    let cursor = open + 1;
    while (
      cursor < length &&
      !isSpace(html[cursor]) &&
      html[cursor] !== "/" &&
      html[cursor] !== ">"
    ) {
      cursor++;
    }
    const name = html.slice(open + 1, cursor).toLowerCase();
    // Attributes, up to the `>` that isn't inside a quoted value.
    const attributes: Attributes = {};
    while (cursor < length && html[cursor] !== ">") {
      const char = html[cursor];
      if (isSpace(char) || char === "/") {
        cursor++;
        continue;
      }
      const nameStart = cursor;
      cursor++;
      while (
        cursor < length &&
        !isSpace(html[cursor]) &&
        html[cursor] !== "/" &&
        html[cursor] !== ">" &&
        html[cursor] !== "="
      ) {
        cursor++;
      }
      const attributeName = html.slice(nameStart, cursor).toLowerCase();
      let value = "";
      let lookahead = cursor;
      while (lookahead < length && isSpace(html[lookahead])) lookahead++;
      if (html[lookahead] === "=") {
        cursor = lookahead + 1;
        while (cursor < length && isSpace(html[cursor])) cursor++;
        const quote = html[cursor];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, cursor + 1);
          const stop = end === -1 ? length : end;
          value = html.slice(cursor + 1, stop);
          cursor = end === -1 ? length : end + 1;
        } else {
          const valueStart = cursor;
          while (cursor < length && !isSpace(html[cursor]) && html[cursor] !== ">") cursor++;
          value = html.slice(valueStart, cursor);
        }
      }
      // A repeated attribute is dropped; the first one counts.
      if (!(attributeName in attributes)) attributes[attributeName] = decodeEntities(value);
    }
    const tagEnd = Math.min(cursor + 1, length);
    if (RAW_TEXT.has(name)) {
      const closing = findEndTag(html, name, tagEnd);
      const raw = html.slice(tagEnd, closing.start);
      yield name === "title"
        ? { name, attributes, text: decodeEntities(raw) }
        : { name, attributes };
      index = closing.end;
    } else {
      yield { name, attributes };
      index = tagEnd;
    }
  }
}

/** Where a raw-text element's end tag starts and ends (case-insensitive). */
function findEndTag(html: string, name: string, from: number): { start: number; end: number } {
  const lower = html.toLowerCase();
  let search = from;
  for (;;) {
    const start = lower.indexOf(`</${name}`, search);
    if (start === -1) return { start: html.length, end: html.length };
    const after = html[start + 2 + name.length];
    if (after === undefined || after === ">" || after === "/" || isSpace(after)) {
      const close = html.indexOf(">", start);
      return { start, end: close === -1 ? html.length : close + 1 };
    }
    search = start + 2;
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  lsaquo: "‹",
  rsaquo: "›",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  times: "×",
  divide: "÷",
  deg: "°",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  iexcl: "¡",
  iquest: "¿",
  shy: "\u00ad",
  zwj: "\u200d",
  zwnj: "\u200c",
  thinsp: "\u2009",
  ensp: "\u2002",
  emsp: "\u2003",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  hearts: "♥",
  agrave: "à",
  aacute: "á",
  acirc: "â",
  atilde: "ã",
  auml: "ä",
  aring: "å",
  aelig: "æ",
  ccedil: "ç",
  egrave: "è",
  eacute: "é",
  ecirc: "ê",
  euml: "ë",
  igrave: "ì",
  iacute: "í",
  icirc: "î",
  iuml: "ï",
  ntilde: "ñ",
  ograve: "ò",
  oacute: "ó",
  ocirc: "ô",
  otilde: "õ",
  ouml: "ö",
  oslash: "ø",
  ugrave: "ù",
  uacute: "ú",
  ucirc: "û",
  uuml: "ü",
  yacute: "ý",
  yuml: "ÿ",
  szlig: "ß",
  Agrave: "À",
  Aacute: "Á",
  Acirc: "Â",
  Atilde: "Ã",
  Auml: "Ä",
  Aring: "Å",
  AElig: "Æ",
  Ccedil: "Ç",
  Egrave: "È",
  Eacute: "É",
  Ecirc: "Ê",
  Euml: "Ë",
  Igrave: "Ì",
  Iacute: "Í",
  Icirc: "Î",
  Iuml: "Ï",
  Ntilde: "Ñ",
  Ograve: "Ò",
  Oacute: "Ó",
  Ocirc: "Ô",
  Otilde: "Õ",
  Ouml: "Ö",
  Oslash: "Ø",
  Ugrave: "Ù",
  Uacute: "Ú",
  Ucirc: "Û",
  Uuml: "Ü",
  Yacute: "Ý",
};

/** References HTML still recognizes without their semicolon. */
const LEGACY_ENTITIES = new Set(["amp", "lt", "gt", "quot", "nbsp", "copy", "reg"]);

/** What `&#128;`–`&#159;` mean in HTML (windows-1252), as browsers decode them. */
const WINDOWS_1252: Record<number, number> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178,
};

function codePoint(value: number): string {
  if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return "�";
  return String.fromCodePoint(WINDOWS_1252[value] ?? value);
}

/** Decodes numeric references and the common named ones (the HTML a site
 * generator escapes: `&amp;`, `&quot;`, `&#39;`, typographic punctuation,
 * Latin-1 letters). Unknown names stay as written. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*))(;?)/g,
    (
      match,
      decimal: string | undefined,
      hex: string | undefined,
      name: string | undefined,
      semicolon: string,
      offset: number,
    ) => {
      if (decimal !== undefined) return codePoint(Number.parseInt(decimal, 10));
      if (hex !== undefined) return codePoint(Number.parseInt(hex, 16));
      const decoded = name !== undefined ? NAMED_ENTITIES[name] : undefined;
      if (decoded === undefined) return match;
      if (!semicolon) {
        // Without a semicolon only the legacy names count, and not before
        // `=` (a query string's `&copy=1`).
        if (!LEGACY_ENTITIES.has(name!) || text[offset + match.length] === "=") return match;
      }
      return decoded;
    },
  );
}

/** `rel` values compare ASCII case-insensitively in HTML, as in selectors. */
function relIs(attributes: Attributes, value: string): boolean {
  return attributes.rel !== undefined && attributes.rel.toLowerCase() === value;
}

/** The search and social metadata in a page's HTML. */
export function parseSeoHead(html: string): SeoData {
  let title: string | null | undefined;
  const metas: Attributes[] = [];
  let canonical: string | null | undefined;
  let favicon: string | null | undefined;
  for (const element of elements(html)) {
    switch (element.name) {
      case "title":
        if (title === undefined) title = element.text?.trim() || null;
        break;
      case "meta":
        metas.push(element.attributes);
        break;
      case "link":
        if (canonical === undefined && relIs(element.attributes, "canonical")) {
          canonical = element.attributes.href || null;
        }
        if (
          favicon === undefined &&
          (relIs(element.attributes, "icon") || relIs(element.attributes, "shortcut icon"))
        ) {
          favicon = element.attributes.href || null;
        }
        break;
    }
  }
  const meta = (key: "name" | "property", value: string): string | null => {
    const found = metas.find((attributes) => attributes[key] === value);
    return found?.content?.trim() || null;
  };
  return {
    title: title ?? null,
    description: meta("name", "description"),
    ogTitle: meta("property", "og:title"),
    ogDescription: meta("property", "og:description"),
    ogImage: meta("property", "og:image"),
    ogUrl: meta("property", "og:url"),
    ogSiteName: meta("property", "og:site_name"),
    twitterCard: meta("name", "twitter:card"),
    twitterTitle: meta("name", "twitter:title"),
    twitterDescription: meta("name", "twitter:description"),
    twitterImage: meta("name", "twitter:image"),
    canonical: canonical ?? null,
    favicon: favicon ?? null,
  };
}

/** Shortens text the way the search and social cards clip it. */
export function truncateSeoText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

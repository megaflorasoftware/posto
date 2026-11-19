import { mediaSourceFromDescription } from "../posto/annotations";

// CDN-backed media sources. A site's schema declares that a field or library
// uses a source by name; `.posto/index.json` supplies that source's connection
// details. Secrets are never part of this model: they stay in each device's
// keychain.

export type CdnProvider = "bunny" | "s3";

export interface CdnSource {
  /** Name referenced by schemas, e.g. `value=posto.media.cdn`. */
  name: string;
  label?: string;
  provider: CdnProvider;
  /** Bunny storage zone name or S3 bucket. */
  bucket: string;
  /** Bunny primary region code or S3 signing region. */
  region?: string;
  /** Folder inside the bucket that holds this source's objects. */
  prefix?: string;
  /** Public base URL stored in content, without a trailing slash. */
  publicUrl: string;
  /** S3 API endpoint. Required for the `s3` provider. */
  endpoint?: string;
  /** Addresses S3 buckets by path instead of by subdomain. */
  pathStyle?: boolean;
}

/** Whether a stored media value is an absolute URL rather than a local path. */
export function isRemoteMediaUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function safeKeySegment(segment: string): string {
  return segment
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
}

/** Builds a stable object key. The content hash gives replaced images a new URL,
 * so CDN caches can't serve stale files and retries reuse finished uploads. */
export function cdnObjectKey(
  source: Pick<CdnSource, "prefix">,
  folder: string,
  filename: string,
  sha256: string,
): string {
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? safeKeySegment(filename.slice(dot + 1)).toLowerCase() : "";
  const name = `${safeKeySegment(stem) || "image"}-${sha256.slice(0, 8)}`;
  return [
    ...(source.prefix ? [source.prefix] : []),
    ...folder.split(/[\\/]/).map(safeKeySegment).filter(Boolean),
    extension ? `${name}.${extension}` : name,
  ].join("/");
}

/** Public URL stored in content for an object key. */
export function cdnObjectUrl(source: Pick<CdnSource, "publicUrl">, key: string): string {
  return `${source.publicUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

/** The source and object key behind a public CDN URL, when it is one of ours. */
export function cdnObjectForUrl(
  sources: CdnSource[],
  url: string,
): { source: CdnSource; key: string } | null {
  for (const source of sources) {
    const base = `${source.publicUrl}/`;
    if (!url.startsWith(base)) continue;
    let key: string;
    try {
      key = url.slice(base.length).split("/").map(decodeURIComponent).join("/");
    } catch {
      return null;
    }
    const safe = key
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..");
    const inPrefix = !source.prefix || key.startsWith(`${source.prefix}/`);
    return safe && inPrefix ? { source, key } : null;
  }
  return null;
}

const SOURCE_NAME = /^[A-Za-z0-9_-]+$/;
const DESCRIBE_CALL = /\.describe\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

/** Reads the CDN source named by a schema expression's `.describe()` text, as
 * in `image().describe("value=posto.media.cdn")`. */
export function mediaSourceAnnotation(expression: string): string | undefined {
  for (const call of expression.matchAll(DESCRIBE_CALL)) {
    const source = mediaSourceFromDescription(call[2]);
    if (source) return source;
  }
  return undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Normalizes an https base URL. Embedded credentials, queries, and fragments
 * are rejected because the value is committed and prefixed onto stored paths. */
function httpsBaseUrl(value: unknown): string | undefined {
  const source = text(value);
  if (!source) return undefined;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    return undefined;
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** Returns the normalized object prefix, or null when it could escape the
 * configured folder. An absent or empty prefix means the bucket root. */
function objectPrefix(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.includes("\\")) return null;
  const prefix = value.trim().replace(/^\/+|\/+$/g, "");
  if (prefix === "") return undefined;
  const safe = prefix
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
  return safe ? prefix : null;
}

function parseSource(value: unknown): CdnSource | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const doc = value as Record<string, unknown>;
  const name = text(doc.name);
  const bucket = text(doc.bucket);
  const publicUrl = httpsBaseUrl(doc.publicUrl);
  const prefix = objectPrefix(doc.prefix);
  const provider = doc.provider;
  if (!name || !SOURCE_NAME.test(name) || !bucket || !publicUrl || prefix === null) return null;
  if (provider !== "bunny" && provider !== "s3") return null;

  const label = text(doc.label);
  const region = text(doc.region);
  const shared = {
    name,
    ...(label ? { label } : {}),
    bucket,
    ...(region ? { region } : {}),
    ...(prefix ? { prefix } : {}),
    publicUrl,
  };
  if (provider === "bunny") return { ...shared, provider };

  const endpoint = httpsBaseUrl(doc.endpoint);
  if (!endpoint) return null;
  return {
    ...shared,
    provider,
    endpoint,
    ...(typeof doc.pathStyle === "boolean" ? { pathStyle: doc.pathStyle } : {}),
  };
}

/** Parses `media.sources` tolerantly, like the rest of `.posto`: invalid entries
 * are dropped and the first definition of a repeated name wins. */
export function parseCdnSources(value: unknown): CdnSource[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sources = new Map<string, CdnSource>();
  for (const item of value) {
    const source = parseSource(item);
    if (source && !sources.has(source.name)) sources.set(source.name, source);
  }
  return sources.size > 0 ? [...sources.values()] : undefined;
}

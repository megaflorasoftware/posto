// CDN-backed media sources. A site's schema declares that a field or library
// uses a source by name; `.posto/index.json` supplies that source's connection
// details. Secrets are never part of this model: they stay in each device's
// keychain.

export type CdnProvider = "bunny" | "s3";

export interface CdnSource {
  /** Name referenced by schemas, e.g. `posto:media=cdn`. */
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

const SOURCE_NAME = /^[A-Za-z0-9_-]+$/;
const DESCRIBE_CALL = /\.describe\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
const MEDIA_ANNOTATION = /(?:^|\s)posto:media=([A-Za-z0-9_-]+)(?=\s|$)/;

/** Reads the CDN source named by a schema expression's `.describe()` text, as
 * in `image().describe("posto:media=cdn")`. */
export function mediaSourceAnnotation(expression: string): string | undefined {
  for (const call of expression.matchAll(DESCRIBE_CALL)) {
    const source = call[2].match(MEDIA_ANNOTATION)?.[1];
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

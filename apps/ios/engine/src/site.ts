/**
 * The live site: its address, where the open file is on it, and the search
 * and social previews of a deployed page. Swift fetches pages itself
 * (JavaScriptCore has no fetch); the engine works out the URLs and reads
 * the HTML.
 */
import type { ChangedFile } from "@posto/ipc";
import { scalarFrontmatter } from "@posto/core/pagescms/frontmatterScalars";
import type { ProjectAdapter } from "@posto/core/project/adapter";
import { parseSeoHead, truncateSeoText, type SeoData } from "@posto/core/seo/head";
import { invoke } from "./host";
import type { RepoSession } from "./repo";

function normalizeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withProtocol).toString();
  } catch {
    return null;
  }
}

/** The site's live URL: the adapter's config (Astro `site`), `public/CNAME`,
 * then package.json `homepage` — the same order as useSiteUrl. */
export async function resolveSiteUrl(
  root: string,
  adapter: ProjectAdapter,
): Promise<string | null> {
  const read = (path: string) => invoke<string | null>("read_text_file_optional", { path });
  for (const candidate of adapter.siteUrlSources(root)) {
    const source = await read(candidate.path);
    if (source) {
      const url = normalizeUrl(candidate.extract(source) ?? "");
      if (url) return url;
    }
  }
  const cname = await read(`${root}/public/CNAME`);
  if (cname) {
    const host = cname.split(/\r?\n/).find((line) => line.trim() !== "");
    const url = host ? normalizeUrl(host) : null;
    if (url) return url;
  }
  const pkg = await read(`${root}/package.json`);
  if (pkg) {
    try {
      const homepage = (JSON.parse(pkg) as { homepage?: unknown }).homepage;
      if (typeof homepage === "string") return normalizeUrl(homepage);
    } catch {
      // Malformed package.json — nothing to learn from it.
    }
  }
  return null;
}

/** GitHub Pages addresses, looked up once per repository (a GitHub API
 * call), as the desktop app does. Failed lookups are retried next time. */
const pagesUrls = new Map<string, string | null>();

async function githubPagesUrl(repo: RepoSession): Promise<string | null> {
  const identity = repo.repo;
  if (!identity) return null;
  const key = `${identity.owner}/${identity.name}`;
  if (pagesUrls.has(key)) return pagesUrls.get(key) ?? null;
  try {
    const url = await invoke<string | null>("github_pages_url", {
      owner: identity.owner,
      name: identity.name,
    });
    pagesUrls.set(key, url ?? null);
    return url ?? null;
  } catch {
    return null;
  }
}

/** The live site: the project's own address, else its GitHub Pages one. */
export async function siteUrl(repo: RepoSession): Promise<string | null> {
  const local = await resolveSiteUrl(repo.root, repo.adapter).catch(() => null);
  return local ?? (await githubPagesUrl(repo));
}

/** A route on the site, under the site URL's own path (a GitHub Pages
 * project site lives at `/<repo>/`). */
export function pageUrl(site: string, route: string): string | null {
  let base: URL;
  try {
    base = new URL(site);
  } catch {
    return null;
  }
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  const relative = route.replace(/^\/+/, "");
  // Routes come from file names and slugs: encode what a URL can't hold,
  // leaving anything already encoded alone.
  const encoded = /%[0-9a-f]{2}/i.test(relative) ? relative : encodeURI(relative);
  return `${base.protocol}//${base.host}${basePath}${encoded}`;
}

/** Where the open file is on the live site, and why it might not be there
 * yet: a route guessed from a collection and slug, a file that hasn't been
 * published (new or renamed), or a draft. */
export async function pageOnSite(repo: RepoSession) {
  const document = repo.document;
  const route = repo.previewRoute();
  const [site, published] = await Promise.all([
    siteUrl(repo),
    document ? publishState(repo, document.path) : Promise.resolve(null),
  ]);
  return {
    siteUrl: site,
    route: route?.route ?? null,
    certain: route?.certain ?? false,
    url: site && route ? pageUrl(site, route.route) : null,
    /** `new`: not on the site yet; `modified`: the site has an older version. */
    localChanges: published,
    draft: document ? scalarFrontmatter(document.content)?.draft === "true" : false,
  };
}

async function publishState(repo: RepoSession, path: string): Promise<"new" | "modified" | null> {
  if (!path.startsWith(`${repo.repoRoot}/`)) return null;
  const relative = path.slice(repo.repoRoot.length + 1);
  try {
    return changeKind(await invoke<ChangedFile[]>("changed_files", { root: repo.root }), relative);
  } catch {
    return null;
  }
}

/** How git sees a file (repository-relative path) against what was last
 * published: untracked, added and renamed files aren't on the site yet. */
export function changeKind(changed: ChangedFile[], relative: string): "new" | "modified" | null {
  const file = changed.find(
    (candidate) => candidate.path === relative || candidate.path.endsWith(` -> ${relative}`),
  );
  if (!file) return null;
  return file.status === "??" || file.status === "A" || file.status.startsWith("R")
    ? "new"
    : "modified";
}

function displayUrl(canonical: string | null, pageAddress: string) {
  for (const candidate of [canonical, pageAddress]) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      const path = url.pathname === "/" ? "" : url.pathname.replace(/\//g, " › ");
      return { host: url.hostname, breadcrumb: url.hostname + path };
    } catch {
      // Not a URL; try the next one.
    }
  }
  return { host: "", breadcrumb: "" };
}

function clip(text: string | null, max: number): string | null {
  return text ? truncateSeoText(text, max) : null;
}

/** The search and social cards for a deployed page's HTML, with the same
 * fallbacks and lengths as the desktop preview. Images and the favicon
 * resolve against the page's URL; missing text is null. */
export function seoPreview(html: string, pageAddress: string) {
  const seo: SeoData = parseSeoHead(html);
  const resolve = (src: string | null): string | null => {
    if (!src) return null;
    try {
      return new URL(src, pageAddress).toString();
    } catch {
      return null;
    }
  };
  const shown = displayUrl(seo.canonical ?? seo.ogUrl, pageAddress);
  return {
    host: shown.host,
    breadcrumb: shown.breadcrumb,
    siteName: seo.ogSiteName ?? shown.host,
    favicon: resolve(seo.favicon ?? "/favicon.ico"),
    image: resolve(seo.twitterImage ?? seo.ogImage),
    twitterCard: seo.twitterCard,
    google: {
      title: clip(seo.title ?? seo.ogTitle, 60),
      description: clip(seo.description ?? seo.ogDescription, 160),
    },
    card: {
      title: clip(seo.twitterTitle ?? seo.ogTitle ?? seo.title, 70),
      description: clip(seo.twitterDescription ?? seo.ogDescription ?? seo.description, 125),
    },
    facebook: {
      title: clip(seo.ogTitle ?? seo.title, 90),
      description: clip(seo.ogDescription ?? seo.description, 110),
    },
  };
}

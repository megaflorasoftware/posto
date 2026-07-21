function frontmatterSlug(content: string): string | null {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const line = fm[1].split(/\r?\n/).find((l) => l.startsWith("slug:"));
  if (!line) return null;
  const value = line
    .slice("slug:".length)
    .trim()
    .replace(/^["']|["']$/g, "");
  return value || null;
}

export interface FileRoute {
  route: string;
  /**
   * `true` only for Astro file-based routes under `src/pages` with no dynamic
   * segments — the one file→URL mapping Astro guarantees. A collection entry's
   * URL is instead defined by whatever `[...].astro` page renders it (via
   * `getStaticPaths`), so it can't be derived from the file path: e.g. a
   * `src/content/weeks/2026-29.mdx` rendered by `src/pages/[year]/[week].astro`
   * lives at `/2026/29`, not `/weeks/2026-29`. Those get a best-effort guess
   * (`certain: false`) that must be confirmed against the dev server before the
   * preview trusts it.
   */
  certain: boolean;
}

// File-based routing (Astro-style): a file under src/pages maps to the
// route its slug implies — src/pages/about.mdx → /about,
// src/pages/blog/index.astro → /blog. Dynamic segments ([slug]) can't be
// resolved from the filename, so those keep the current route.
// Markdown in a content collection (src/<coll>/post.mdx or
// src/content/<coll>/post.mdx) maps to a guessed /<coll>/<slug>, where the
// slug comes from frontmatter when present, else the filename — a guess,
// since the real route depends on the page that renders the collection.
export function routeForFile(path: string, content: string): FileRoute | null {
  const marker = "/src/pages/";
  const idx = path.indexOf(marker);
  if (idx !== -1) {
    let rel = path.slice(idx + marker.length).replace(/\.[^/.]+$/, "");
    if (rel.includes("[")) return null;
    if (rel === "index" || rel.endsWith("/index")) rel = rel.slice(0, -"index".length);
    const route = "/" + rel;
    const normalized = route.length > 1 && route.endsWith("/") ? route.slice(0, -1) : route;
    return { route: normalized, certain: true };
  }
  const collection = path.match(/\/src\/(?:content\/)?([^/]+)\/([^/]+)\.(?:md|mdx|markdown)$/);
  if (!collection) return null;
  const [, name, file] = collection;
  // "content" as the collection name means the file sits directly in
  // src/content (e.g. src/content/home.md) — data files, not pages.
  if (["pages", "components", "layouts", "assets", "styles", "content"].includes(name)) {
    return null;
  }
  return { route: `/${name}/${frontmatterSlug(content) ?? file}`, certain: false };
}

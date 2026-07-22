import type { ProjectAdapter } from "./adapter";
import { PROJECT_MARKERS } from "./detect";

export const genericAdapter: ProjectAdapter = {
  type: "generic",
  async loadDerivedConfig() {
    return null;
  },
  invalidations(root) {
    return [
      ...PROJECT_MARKERS.map((path) => ({
        paths: [{ exact: `${root}/${path}` }],
        refresh: "projectType" as const,
      })),
      {
        paths: [{ exact: `${root}/.astro` }, { prefix: `${root}/.astro/` }],
        refresh: "projectType",
      },
    ];
  },
  routeForFile() {
    return null;
  },
  siteUrlSources() {
    return [];
  },
  watchIgnores() {
    return [];
  },
  capabilities: {
    imageLibraries: false,
    dataDocuments: false,
    componentBlocks: null,
    entryIds: null,
  },
};

export const eleventyAdapter: ProjectAdapter = {
  ...genericAdapter,
  type: "eleventy",
  routeForFile(root, path) {
    if (!/\.(?:md|markdown)$/i.test(path) || !path.startsWith(`${root}/`)) return null;
    let rel = path.slice(root.length + 1).replace(/\.(?:md|markdown)$/i, "");
    if (rel === "index" || rel.endsWith("/index")) rel = rel.slice(0, -"index".length);
    return { route: `/${rel}`.replace(/\/$/, "") || "/", certain: false };
  },
};

/** Hugo detection is reserved; unsupported versions deliberately behave generically. */
export const hugoAdapter: ProjectAdapter = { ...genericAdapter, type: "hugo" };

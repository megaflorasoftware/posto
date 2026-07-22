import type { ProjectAdapter } from "./adapter";

export const genericAdapter: ProjectAdapter = {
  type: "generic",
  async loadDerivedConfig() {
    return null;
  },
  invalidations() {
    return [];
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

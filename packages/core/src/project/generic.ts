import type { ProjectAdapter } from "./adapter";
import { PROJECT_MARKERS } from "./detect";
import { DEFAULT_MEDIA } from "../pagescms/config";

export const genericAdapter: ProjectAdapter = {
  type: "generic",
  defaultMedia: DEFAULT_MEDIA,
  async loadDerivedConfig() {
    return null;
  },
  invalidations(root) {
    return [
      ...PROJECT_MARKERS.map((marker) => ({
        paths: [{ exact: `${root}/${marker.path}` }],
        refresh: "projectType" as const,
      })),
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
    mediaLibraries: false,
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

import { slug as githubSlug } from "github-slugger";

export interface EntryIdSource {
  derive(relPath: string, slug?: string | null): string;
}

/** Path-based IDs used by Astro's default glob loader. */
export function pathEntryId(relPath: string, slug?: string | null): string {
  if (slug) return slug;
  const withoutExt = relPath.replace(/\.[^./]+$/, "");
  return withoutExt
    .split("/")
    .map((segment) => githubSlug(segment))
    .join("/")
    .replace(/\/index$/, "");
}

export const pathEntryIds: EntryIdSource = { derive: pathEntryId };

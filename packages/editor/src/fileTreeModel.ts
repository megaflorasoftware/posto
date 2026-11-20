import type { ContentEntry } from "@posto/core/pagescms/config";
import { expandEntryName } from "@posto/core/posto/config";
import type { FileEntry, FileGroup } from "@posto/ipc";

/** Public media is managed through the media library, not this text-file tree. */
export function canCreateFileInGroup(root: string, group: FileGroup): boolean {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedGroup = group.path.replace(/\\/g, "/").replace(/\/+$/, "");
  return group.kind !== "styles" && normalizedGroup !== `${normalizedRoot}/public`;
}

/** A custom collection entry-label template wins; otherwise show the filename. */
export function sidebarFileLabel(file: FileEntry, collection: ContentEntry | null): string {
  if (!collection?.entryName) return file.name;
  return expandEntryName(collection.entryName, file.frontmatter) ?? file.name;
}

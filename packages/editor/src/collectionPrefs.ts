import type { FileEntry } from "@posto/ipc";
import type { ContentEntry } from "@posto/core/pagescms/config";
import {
  LABEL_SORT,
  compareBySort,
  compareSortValues,
  expandEntryName,
} from "@posto/core/posto/config";

/** Applies the collection's `.posto` preferences to a set of its files:
 * templated entry labels, frontmatter sort, then pinned entries on top
 * (stable sorts keep the frontmatter order among unpinned files). Shared by
 * the sidebar and by dropdowns offering the collection's entries, so every
 * list of a collection shows the same labels in the same order. */
export function applyCollectionPrefs(files: FileEntry[], collection: ContentEntry): FileEntry[] {
  const { entryName, sort, pinned } = collection;
  if (!entryName && !sort && !pinned?.length) return files;
  let result = files;
  if (entryName) {
    result = result.map((file) => {
      const label = expandEntryName(entryName, file.frontmatter);
      return label ? { ...file, title: label } : file;
    });
  }
  if (sort) {
    // Label sort runs after the entry-name expansion above, so it orders by
    // what each entry actually displays as.
    result = [...result].sort((a, b) =>
      sort.by === LABEL_SORT
        ? compareSortValues(a.title ?? a.name, b.title ?? b.name, sort.direction)
        : compareBySort(a.frontmatter, b.frontmatter, sort),
    );
  }
  if (pinned?.length) {
    const rank = new Map(pinned.map((name, i) => [name, i]));
    result = [...result].sort(
      (a, b) => (rank.get(a.name) ?? Infinity) - (rank.get(b.name) ?? Infinity),
    );
  }
  return result;
}

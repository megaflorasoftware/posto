import type { ImageLibraryAsset } from "@posto/core/project/mediaLibrary";

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function relative(root: string, path: string): string | null {
  const base = normalize(root);
  const target = normalize(path);
  if (target === base) return "";
  return target.startsWith(`${base}/`) ? target.slice(base.length + 1) : null;
}

function dirname(path: string): string {
  const normalized = normalize(path);
  return normalized.slice(0, normalized.lastIndexOf("/"));
}

/** The folders and selectable entries shown in one folder of a library. */
export function imageLibraryItemsIn(
  rootDirectory: string,
  currentDirectory: string,
  directories: string[],
  assets: ImageLibraryAsset[],
): { folders: Array<{ name: string; path: string }>; assets: ImageLibraryAsset[] } {
  const root = normalize(rootDirectory);
  const current = currentDirectory ? `${root}/${currentDirectory}` : root;
  return {
    folders: directories
      .flatMap((directory) => {
        const location = relative(current, directory);
        return location && !location.includes("/") ? [{ name: location, path: directory }] : [];
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    assets: assets.filter((asset) => normalize(dirname(asset.metadataPath)) === normalize(current)),
  };
}

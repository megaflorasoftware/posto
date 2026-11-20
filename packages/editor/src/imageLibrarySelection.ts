import type { ImageLibraryAsset } from "@posto/core/project/mediaLibrary";
import { imageLibraryItemsIn } from "./imageLibraryItems";

export interface LibraryItems {
  assetIds: string[];
  folders: string[];
}

/** The folders and selectable entries shown in one folder of a library. */
export function visibleLibraryItems(
  libraryRoot: string,
  currentDirectory: string,
  directories: string[],
  assets: ImageLibraryAsset[],
): LibraryItems {
  const items = imageLibraryItemsIn(libraryRoot, currentDirectory, directories, assets);
  return {
    assetIds: items.assets
      .filter((asset) => asset.health.includes("valid"))
      .map((asset) => asset.metadataPath),
    folders: items.folders.map((folder) => folder.path),
  };
}

export function allItemsSelected(
  visible: LibraryItems,
  selected: Set<string>,
  selectedDirectories: Set<string>,
): boolean {
  return (
    visible.assetIds.length + visible.folders.length > 0 &&
    visible.assetIds.every((id) => selected.has(id)) &&
    visible.folders.every((folder) => selectedDirectories.has(folder))
  );
}

/** Adds every visible item to the selection. A selected folder already covers
 * its contents, so items inside it are dropped from the selection. */
export function selectAllItems(
  visible: LibraryItems,
  selected: Set<string>,
  selectedDirectories: Set<string>,
): { selected: Set<string>; selectedDirectories: Set<string> } {
  const folders = new Set([...selectedDirectories, ...visible.folders]);
  const inside = (path: string) =>
    [...folders].some((folder) => path !== folder && path.startsWith(`${folder}/`));
  return {
    selected: new Set([...selected, ...visible.assetIds].filter((id) => !inside(id))),
    selectedDirectories: new Set([...folders].filter((folder) => !inside(folder))),
  };
}

/** Entries chosen directly or inside a chosen folder. */
export function selectedLibraryAssets(
  assets: ImageLibraryAsset[],
  selected: Set<string>,
  selectedDirectories: Set<string>,
): ImageLibraryAsset[] {
  const folders = [...selectedDirectories];
  return assets.filter(
    (asset) =>
      selected.has(asset.metadataPath) ||
      folders.some((folder) => asset.metadataPath.startsWith(`${folder}/`)),
  );
}

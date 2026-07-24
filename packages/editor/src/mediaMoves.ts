import type { MediaLibrary, PagesConfig } from "@posto/core/pagescms/config";
import { pathEntryId } from "@posto/core/project/entryIds";
import type { ImageLibraryAsset } from "@posto/core/project/mediaLibrary";
import {
  invoke,
  moveFileMediaDirectory,
  moveFileMediaItem,
  type FileEntry,
  type FileGroup,
} from "@posto/ipc";
import { filePathBasename, filePathDirname, normalizeFilePath } from "./filePaths";
import {
  applyImageLibraryReferenceUpdates,
  planImageLibraryReferenceUpdates,
  planMarkdownMediaReferenceUpdates,
  type ImageLibraryRelocation,
} from "./imageLibraryReferences";
import { publicMediaOutputPath } from "./markdownMedia";

function markdownReferenceReplacements(
  root: string,
  relocations: Array<{ from: string; to: string }>,
): Map<string, string> {
  const replacements = new Map<string, string>();
  for (const relocation of relocations) {
    const from = publicMediaOutputPath(root, relocation.from);
    const to = publicMediaOutputPath(root, relocation.to);
    if (!from || !to || from === to) continue;
    replacements.set(from, to);
    replacements.set(from.replace(/^\//, ""), to.replace(/^\//, ""));
  }
  return replacements;
}

function metadataAlt(metadata: Record<string, unknown>): string | undefined {
  return Object.prototype.hasOwnProperty.call(metadata, "alt") && typeof metadata.alt === "string"
    ? metadata.alt
    : undefined;
}

export async function moveFileMediaItems(input: {
  root: string;
  mediaRoot: string;
  groups: FileGroup[];
  directories: string[];
  files: FileEntry[];
  movingFiles: FileEntry[];
  movingDirectories?: string[];
  destinationDirectory: string;
  onBeforeChange: () => Promise<void>;
}): Promise<void> {
  const destination = normalizeFilePath(input.destinationDirectory).replace(/\/+$/, "");
  const movingDirectories = input.movingDirectories ?? [];
  const fileOperations = input.movingFiles.map((file) => ({
    from: normalizeFilePath(file.path),
    to: `${destination}/${filePathBasename(file.path)}`,
  }));
  const directoryOperations = movingDirectories.map((from) => ({
    from: normalizeFilePath(from).replace(/\/+$/, ""),
    to: `${destination}/${filePathBasename(from)}`,
  }));
  const movingFilePaths = new Set(input.movingFiles.map((file) => normalizeFilePath(file.path)));
  const existingFilePaths = new Set(input.files.map((file) => normalizeFilePath(file.path)));
  const existingDirectories = input.directories.map((directory) =>
    normalizeFilePath(directory).replace(/\/+$/, ""),
  );
  const movingDirectoryPaths = directoryOperations.map((operation) => operation.from);
  const targets = new Set<string>();
  for (const operation of fileOperations) {
    if (operation.from === operation.to) {
      throw new Error("One or more selected files are already in that folder.");
    }
    if (
      targets.has(operation.to) ||
      existingDirectories.includes(operation.to) ||
      (existingFilePaths.has(operation.to) && !movingFilePaths.has(operation.to))
    ) {
      throw new Error("A file or folder with that name already exists in the destination.");
    }
    targets.add(operation.to);
  }

  const directoryTargets = new Set<string>();
  for (const operation of directoryOperations) {
    if (destination === operation.from || destination.startsWith(`${operation.from}/`)) {
      throw new Error("A folder cannot be moved into itself.");
    }
    if (operation.from === operation.to) {
      throw new Error("One or more selected folders are already in that folder.");
    }
    if (
      directoryTargets.has(operation.to) ||
      existingFilePaths.has(operation.to) ||
      existingDirectories.some(
        (directory) =>
          directory === operation.to &&
          !movingDirectoryPaths.some(
            (movingDirectory) =>
              directory === movingDirectory || directory.startsWith(`${movingDirectory}/`),
          ),
      )
    ) {
      throw new Error("A file or folder with that name already exists in the destination.");
    }
    directoryTargets.add(operation.to);
  }

  await input.onBeforeChange();
  const relocationTargets = new Map(
    fileOperations.map((operation) => [operation.from, operation.to]),
  );
  const orderedDirectories = [...directoryOperations].sort(
    (left, right) => right.from.length - left.from.length,
  );
  for (const file of input.files) {
    const filePath = normalizeFilePath(file.path);
    if (relocationTargets.has(filePath)) continue;
    const directory = orderedDirectories.find((operation) =>
      filePath.startsWith(`${operation.from}/`),
    );
    if (directory) {
      relocationTargets.set(filePath, `${directory.to}${filePath.slice(directory.from.length)}`);
    }
  }
  const referencePlan = await planMarkdownMediaReferenceUpdates({
    groups: input.groups,
    replacements: markdownReferenceReplacements(
      input.root,
      [...relocationTargets].map(([from, to]) => ({ from, to })),
    ),
  });
  const completedFiles: typeof fileOperations = [];
  const completedDirectories: typeof directoryOperations = [];
  try {
    for (const operation of fileOperations) {
      await moveFileMediaItem({
        mediaRoot: input.mediaRoot,
        path: operation.from,
        destinationDirectory: destination,
      });
      completedFiles.push(operation);
    }
    for (const operation of directoryOperations) {
      await moveFileMediaDirectory({
        mediaRoot: input.mediaRoot,
        path: operation.from,
        destinationDirectory: destination,
      });
      completedDirectories.push(operation);
    }
    await applyImageLibraryReferenceUpdates(referencePlan);
  } catch (caught) {
    for (const operation of completedDirectories.reverse()) {
      await moveFileMediaDirectory({
        mediaRoot: input.mediaRoot,
        path: operation.to,
        destinationDirectory: filePathDirname(operation.from),
      }).catch(() => undefined);
    }
    for (const operation of completedFiles.reverse()) {
      await moveFileMediaItem({
        mediaRoot: input.mediaRoot,
        path: operation.to,
        destinationDirectory: filePathDirname(operation.from),
      }).catch(() => undefined);
    }
    throw caught;
  }
}

export async function moveImageLibraryItems(input: {
  root: string;
  library: MediaLibrary;
  config: PagesConfig;
  groups: FileGroup[];
  libraryRoot: string;
  directories: string[];
  assets: ImageLibraryAsset[];
  movingAssets: ImageLibraryAsset[];
  movingDirectories?: string[];
  destinationDirectory: string;
  onBeforeMove: () => Promise<void>;
}): Promise<void> {
  const movingDirectories = input.movingDirectories ?? [];
  const destinationDirectory = normalizeFilePath(input.destinationDirectory).replace(/\/+$/, "");
  const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const dirname = (path: string) => path.slice(0, path.lastIndexOf("/"));
  const assetTargets = input.movingAssets.map((asset) => ({
    asset,
    imagePath: `${destinationDirectory}/${basename(asset.imagePath ?? "")}`,
    metadataPath: `${destinationDirectory}/${basename(asset.metadataPath)}`,
  }));
  const directoryTargets = movingDirectories.map((directoryPath) => ({
    directoryPath,
    target: `${destinationDirectory}/${basename(directoryPath)}`,
  }));
  const relocationFor = (asset: ImageLibraryAsset): ImageLibraryRelocation | null => {
    if (!asset.imagePath) return null;
    const direct = assetTargets.find(
      (operation) => operation.asset.metadataPath === asset.metadataPath,
    );
    let newImagePath: string;
    let newMetadataPath: string;
    if (direct) {
      newImagePath = direct.imagePath;
      newMetadataPath = direct.metadataPath;
    } else {
      const directory = directoryTargets.find(
        (operation) =>
          asset.metadataPath.startsWith(`${operation.directoryPath}/`) &&
          asset.imagePath?.startsWith(`${operation.directoryPath}/`),
      );
      if (!directory) return null;
      newImagePath = `${directory.target}${asset.imagePath.slice(directory.directoryPath.length)}`;
      newMetadataPath = `${directory.target}${asset.metadataPath.slice(directory.directoryPath.length)}`;
    }
    return {
      oldEntryId: asset.entryId,
      newEntryId: pathEntryId(newMetadataPath.slice(input.libraryRoot.length + 1)),
      oldImagePath: asset.imagePath,
      newImagePath,
      newAlt: metadataAlt(asset.metadata),
    };
  };

  const existingPaths = new Set(
    input.assets.flatMap((asset) =>
      asset.imagePath ? [asset.imagePath, asset.metadataPath] : [asset.metadataPath],
    ),
  );
  const sourcePaths = new Set(
    input.movingAssets.flatMap((asset) =>
      asset.imagePath ? [asset.imagePath, asset.metadataPath] : [asset.metadataPath],
    ),
  );
  const targetPaths = new Set<string>();
  for (const asset of input.movingAssets) {
    if (!asset.imagePath) throw new Error(`${asset.entryId} has no image to move.`);
    const targets = [asset.imagePath, asset.metadataPath].map(
      (path) => `${destinationDirectory}/${path.split("/").pop()}`,
    );
    if (targets.some((path) => sourcePaths.has(path))) {
      throw new Error("One or more selected images are already in that folder.");
    }
    if (
      targets.some(
        (path) => targetPaths.has(path) || (existingPaths.has(path) && !sourcePaths.has(path)),
      )
    ) {
      throw new Error("A file with that name already exists in the destination folder.");
    }
    targets.forEach((path) => targetPaths.add(path));
  }
  const directoryTargetPaths = new Set<string>();
  for (const directoryPath of movingDirectories) {
    if (
      destinationDirectory === directoryPath ||
      destinationDirectory.startsWith(`${directoryPath}/`)
    ) {
      throw new Error("A folder cannot be moved into itself.");
    }
    const target = `${destinationDirectory}/${directoryPath.split("/").pop()}`;
    if (target === directoryPath) {
      throw new Error("One or more selected folders are already in that folder.");
    }
    if (
      directoryTargetPaths.has(target) ||
      input.directories.some(
        (directory) =>
          directory === target &&
          !movingDirectories.some(
            (movingDirectory) =>
              directory === movingDirectory || directory.startsWith(`${movingDirectory}/`),
          ),
      )
    ) {
      throw new Error("A folder with that name already exists in the destination folder.");
    }
    directoryTargetPaths.add(target);
  }

  await input.onBeforeMove();
  const relocations = input.assets.flatMap((asset) => {
    const relocation = relocationFor(asset);
    return relocation ? [relocation] : [];
  });
  const referencePlan = await planImageLibraryReferenceUpdates({
    root: input.root,
    config: input.config,
    groups: input.groups,
    library: input.library,
    relocations,
  });
  const completedAssets: typeof assetTargets = [];
  const completedDirectories: typeof directoryTargets = [];
  try {
    for (const operation of assetTargets) {
      await invoke("move_image_library_asset", {
        libraryRoot: input.libraryRoot,
        imagePath: operation.asset.imagePath,
        metadataPath: operation.asset.metadataPath,
        destinationDirectory,
      });
      completedAssets.push(operation);
    }
    for (const operation of directoryTargets) {
      await invoke("move_image_library_directory", {
        libraryRoot: input.libraryRoot,
        directoryPath: operation.directoryPath,
        destinationDirectory,
      });
      completedDirectories.push(operation);
    }
    await applyImageLibraryReferenceUpdates(referencePlan);
  } catch (caught) {
    for (const operation of completedDirectories.reverse()) {
      await invoke("move_image_library_directory", {
        libraryRoot: input.libraryRoot,
        directoryPath: operation.target,
        destinationDirectory: dirname(operation.directoryPath),
      }).catch(() => undefined);
    }
    for (const operation of completedAssets.reverse()) {
      await invoke("move_image_library_asset", {
        libraryRoot: input.libraryRoot,
        imagePath: operation.imagePath,
        metadataPath: operation.metadataPath,
        destinationDirectory: dirname(operation.asset.metadataPath),
      }).catch(() => undefined);
    }
    throw caught;
  }
}

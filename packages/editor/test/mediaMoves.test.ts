import { beforeEach, expect, test, vi } from "vitest";
import type { MediaLibrary, PagesConfig } from "@posto/core/pagescms/config";
import type { ImageLibraryAsset } from "@posto/core/project/mediaLibrary";
import { moveFileMediaDirectory, moveFileMediaItem, invoke, type FileEntry } from "@posto/ipc";
import {
  applyImageLibraryReferenceUpdates,
  planImageLibraryReferenceUpdates,
  planMarkdownMediaReferenceUpdates,
} from "../src/imageLibraryReferences";
import { moveFileMediaItems, moveImageLibraryItems } from "../src/mediaMoves";

vi.mock("@posto/ipc", () => ({
  invoke: vi.fn(),
  moveFileMediaDirectory: vi.fn(),
  moveFileMediaItem: vi.fn(),
}));

vi.mock("../src/imageLibraryReferences", () => ({
  applyImageLibraryReferenceUpdates: vi.fn(),
  planImageLibraryReferenceUpdates: vi.fn().mockResolvedValue([]),
  planMarkdownMediaReferenceUpdates: vi.fn().mockResolvedValue([]),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(planImageLibraryReferenceUpdates).mockResolvedValue([]);
  vi.mocked(planMarkdownMediaReferenceUpdates).mockResolvedValue([]);
});

test("moves a selected public-media batch and updates Markdown references", async () => {
  const files: FileEntry[] = [
    { name: "one.jpg", path: "/repo/public/one.jpg" },
    { name: "two.jpg", path: "/repo/public/two.jpg" },
  ];
  const before = vi.fn().mockResolvedValue(undefined);

  await moveFileMediaItems({
    root: "/repo",
    mediaRoot: "/repo/public",
    groups: [],
    directories: ["/repo/public/albums"],
    files,
    movingFiles: files,
    destinationDirectory: "/repo/public/albums",
    onBeforeChange: before,
  });

  expect(before).toHaveBeenCalledOnce();
  expect(moveFileMediaItem).toHaveBeenCalledTimes(2);
  expect(moveFileMediaDirectory).not.toHaveBeenCalled();
  expect(moveFileMediaItem).toHaveBeenNthCalledWith(1, {
    mediaRoot: "/repo/public",
    path: "/repo/public/one.jpg",
    destinationDirectory: "/repo/public/albums",
  });
  const replacements = vi.mocked(planMarkdownMediaReferenceUpdates).mock.calls[0]?.[0].replacements;
  expect(replacements?.get("/one.jpg")).toBe("/albums/one.jpg");
  expect(replacements?.get("/two.jpg")).toBe("/albums/two.jpg");
  expect(applyImageLibraryReferenceUpdates).toHaveBeenCalledOnce();
});

test("moves mixed public-media files and directories as one batch", async () => {
  const files: FileEntry[] = [
    { name: "one.jpg", path: "/repo/public/one.jpg" },
    { name: "two.jpg", path: "/repo/public/albums/two.jpg" },
  ];

  await moveFileMediaItems({
    root: "/repo",
    mediaRoot: "/repo/public",
    groups: [],
    directories: ["/repo/public/albums", "/repo/public/archive"],
    files,
    movingFiles: [files[0]!],
    movingDirectories: ["/repo/public/albums"],
    destinationDirectory: "/repo/public/archive",
    onBeforeChange: vi.fn().mockResolvedValue(undefined),
  });

  expect(moveFileMediaItem).toHaveBeenCalledWith({
    mediaRoot: "/repo/public",
    path: "/repo/public/one.jpg",
    destinationDirectory: "/repo/public/archive",
  });
  expect(moveFileMediaDirectory).toHaveBeenCalledWith({
    mediaRoot: "/repo/public",
    path: "/repo/public/albums",
    destinationDirectory: "/repo/public/archive",
  });
  const replacements = vi.mocked(planMarkdownMediaReferenceUpdates).mock.calls[0]?.[0].replacements;
  expect(replacements?.get("/one.jpg")).toBe("/archive/one.jpg");
  expect(replacements?.get("/albums/two.jpg")).toBe("/archive/albums/two.jpg");
});

test("moves a selected image-library batch and plans entry and image relocations", async () => {
  const library: MediaLibrary = {
    collection: "photos",
    base: "src/content/photos",
    patterns: ["**/*.yml"],
    metadataExtensions: ["yml"],
    imageFieldPath: ["image"],
    fields: [],
  };
  const assets = ["one", "two"].map(
    (name): ImageLibraryAsset => ({
      entryId: name,
      metadataPath: `/repo/src/content/photos/${name}.yml`,
      imagePath: `/repo/src/content/photos/${name}.jpg`,
      metadata: { image: `./${name}.jpg` },
      metadataSource: `image: ./${name}.jpg\n`,
      health: ["valid"],
    }),
  );

  await moveImageLibraryItems({
    root: "/repo",
    library,
    config: { media: [], content: [], mediaLibraries: [library] } as PagesConfig,
    groups: [],
    libraryRoot: "/repo/src/content/photos",
    directories: ["/repo/src/content/photos/albums"],
    assets,
    movingAssets: assets,
    destinationDirectory: "/repo/src/content/photos/albums",
    onBeforeMove: vi.fn().mockResolvedValue(undefined),
  });

  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenNthCalledWith(1, "move_image_library_asset", {
    libraryRoot: "/repo/src/content/photos",
    imagePath: "/repo/src/content/photos/one.jpg",
    metadataPath: "/repo/src/content/photos/one.yml",
    destinationDirectory: "/repo/src/content/photos/albums",
  });
  const relocations = vi.mocked(planImageLibraryReferenceUpdates).mock.calls[0]?.[0].relocations;
  expect(relocations).toMatchObject([
    {
      oldEntryId: "one",
      newEntryId: "albums/one",
      oldImagePath: "/repo/src/content/photos/one.jpg",
      newImagePath: "/repo/src/content/photos/albums/one.jpg",
    },
    {
      oldEntryId: "two",
      newEntryId: "albums/two",
      oldImagePath: "/repo/src/content/photos/two.jpg",
      newImagePath: "/repo/src/content/photos/albums/two.jpg",
    },
  ]);
  expect(applyImageLibraryReferenceUpdates).toHaveBeenCalledOnce();
});

test("moves mixed image-library assets and directories as one batch", async () => {
  const library: MediaLibrary = {
    collection: "photos",
    base: "src/content/photos",
    patterns: ["**/*.yml"],
    metadataExtensions: ["yml"],
    imageFieldPath: ["image"],
    fields: [],
  };
  const assets: ImageLibraryAsset[] = [
    {
      entryId: "one",
      metadataPath: "/repo/src/content/photos/one.yml",
      imagePath: "/repo/src/content/photos/one.jpg",
      metadata: { image: "./one.jpg" },
      health: ["valid"],
    },
    {
      entryId: "albums/two",
      metadataPath: "/repo/src/content/photos/albums/two.yml",
      imagePath: "/repo/src/content/photos/albums/two.jpg",
      metadata: { image: "./two.jpg" },
      health: ["valid"],
    },
  ];

  await moveImageLibraryItems({
    root: "/repo",
    library,
    config: { media: [], content: [], mediaLibraries: [library] } as PagesConfig,
    groups: [],
    libraryRoot: "/repo/src/content/photos",
    directories: ["/repo/src/content/photos/albums", "/repo/src/content/photos/archive"],
    assets,
    movingAssets: [assets[0]!],
    movingDirectories: ["/repo/src/content/photos/albums"],
    destinationDirectory: "/repo/src/content/photos/archive",
    onBeforeMove: vi.fn().mockResolvedValue(undefined),
  });

  expect(invoke).toHaveBeenCalledWith("move_image_library_asset", {
    libraryRoot: "/repo/src/content/photos",
    imagePath: "/repo/src/content/photos/one.jpg",
    metadataPath: "/repo/src/content/photos/one.yml",
    destinationDirectory: "/repo/src/content/photos/archive",
  });
  expect(invoke).toHaveBeenCalledWith("move_image_library_directory", {
    libraryRoot: "/repo/src/content/photos",
    directoryPath: "/repo/src/content/photos/albums",
    destinationDirectory: "/repo/src/content/photos/archive",
  });
  const relocations = vi.mocked(planImageLibraryReferenceUpdates).mock.calls[0]?.[0].relocations;
  expect(relocations).toMatchObject([
    { oldEntryId: "one", newEntryId: "archive/one" },
    { oldEntryId: "albums/two", newEntryId: "archive/albums/two" },
  ]);
});

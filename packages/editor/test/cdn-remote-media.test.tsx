// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MediaLibrary, PagesConfig } from "@posto/core/pagescms/config";
import type { ImageLibraryAsset } from "@posto/core/project/mediaLibrary";
import { deleteFileMediaItem, invoke, thumbnailUrl } from "@posto/ipc";
import { CachedImage } from "../src/components/CachedImage";
import { ImageLibraryBrowser } from "../src/components/ImageLibraryBrowser";
import {
  DeleteImageLibraryAssetsDialog,
  ImageLibraryEditDialog,
} from "../src/components/ImageLibraryManageDialogs";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

vi.mock("@posto/ipc", () => ({
  createFileMediaDirectory: vi.fn(),
  deleteFileMediaItem: vi.fn().mockResolvedValue(undefined),
  invoke: vi.fn().mockResolvedValue(null),
  onFileDrop: vi.fn().mockReturnValue(() => undefined),
  onFsChanged: vi.fn().mockReturnValue(() => undefined),
  openPath: vi.fn(),
  thumbnailUrl: vi.fn().mockResolvedValue(null),
}));

const url = "https://media.example.com/images/harbor-1a2b3c4d.jpg";
const library: MediaLibrary = {
  collection: "photos",
  base: "src/data/photos",
  patterns: ["**/*.yaml"],
  metadataExtensions: ["yaml"],
  imageFieldPath: ["src"],
  fields: [],
};
const published: ImageLibraryAsset = {
  libraryId: "photos",
  entryId: "harbor",
  metadataPath: "/repo/src/data/photos/harbor.yaml",
  imagePath: null,
  imageUrl: url,
  metadata: { src: url, alt: "Harbor" },
  metadataSource: `src: ${url}\nalt: Harbor\n`,
  health: ["valid"],
};

function renderWithTheme(element: React.ReactElement) {
  return render(<MantineProvider forceColorScheme="light">{element}</MantineProvider>);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

test("a CDN image loads directly without the local thumbnailer", async () => {
  render(<CachedImage path={url} alt="Harbor" />);
  expect(await screen.findByAltText("Harbor")).toHaveProperty("src", url);
  expect(thumbnailUrl).not.toHaveBeenCalled();
});

test("the library browser previews published images", async () => {
  renderWithTheme(
    <ImageLibraryBrowser
      rootDirectory="/repo/src/data/photos"
      currentDirectory=""
      directories={[]}
      assets={[published]}
      onDirectoryChange={vi.fn()}
    />,
  );
  expect(await screen.findByAltText("Harbor")).toHaveProperty("src", url);
});

test("deleting a published image removes only its metadata entry", async () => {
  const onDeleted = vi.fn();
  renderWithTheme(
    <DeleteImageLibraryAssetsDialog
      libraryRoot="/repo/src/data/photos"
      assets={[published]}
      onClose={vi.fn()}
      onDeleted={onDeleted}
    />,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Delete item" }));

  await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
  expect(deleteFileMediaItem).toHaveBeenCalledWith({
    mediaRoot: "/repo/src/data/photos",
    path: published.metadataPath,
  });
  expect(invoke).not.toHaveBeenCalledWith("delete_image_library_asset", expect.anything());
});

test("the edit dialog shows the CDN URL and can't rename the object", async () => {
  renderWithTheme(
    <ImageLibraryEditDialog
      root="/repo"
      library={library}
      config={{ media: [], content: [] } as PagesConfig}
      groups={[]}
      asset={published}
      onBeforeChange={vi.fn().mockResolvedValue(undefined)}
      onClose={vi.fn()}
      onChanged={vi.fn()}
    />,
  );

  const field = await screen.findByLabelText("CDN URL");
  expect(field).toHaveProperty("value", url);
  expect(field).toHaveProperty("readOnly", true);
  expect(screen.queryByLabelText("Filename")).toBeNull();
  expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", false);
});

// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, expect, test, vi } from "vitest";
import type { MediaLibrary } from "@posto/core/pagescms/config";
import type { ImageLibraryAsset } from "@posto/core/project/mediaLibrary";
import { ImageLibraryBrowser } from "../src/components/ImageLibraryBrowser";
import { ImageLibraryImportDialog } from "../src/components/ImageLibraryImportDialog";
import { ImageLibraryPickerDialog } from "../src/components/ImageLibraryPickerDialog";

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
  importImageLibraryAsset: vi.fn(),
  importPublicMediaFile: vi.fn(),
  invoke: vi.fn().mockResolvedValue([]),
  onFileDrop: vi.fn().mockReturnValue(() => undefined),
  onFsChanged: vi.fn().mockReturnValue(() => undefined),
  openImageFiles: vi.fn().mockResolvedValue([]),
  openPath: vi.fn(),
  prepareImageSources: vi.fn(async (paths: string[]) => paths),
  thumbnailUrl: vi.fn().mockResolvedValue(null),
}));

afterEach(cleanup);

const library: MediaLibrary = {
  collection: "photos",
  base: "src/content/photos",
  patterns: ["**/*.yml"],
  metadataExtensions: ["yml"],
  imageFieldPath: ["image"],
  fields: [],
};

function picker(onClear?: () => void) {
  return render(
    <MantineProvider forceColorScheme="light">
      <ImageLibraryPickerDialog
        root="/repo"
        library={library}
        assets={[]}
        directories={[]}
        onClose={vi.fn()}
        onPick={vi.fn()}
        onImport={vi.fn()}
        onClear={onClear}
      />
    </MantineProvider>,
  );
}

test("replaces the directory action with a clear action for selected library images", () => {
  const onClear = vi.fn();
  picker(onClear);

  expect(screen.queryByRole("button", { name: "Open Media Library" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Clear Image Selection" }));
  expect(onClear).toHaveBeenCalledOnce();
});

test("keeps the directory action when the picker has no field selection", () => {
  picker();

  expect(screen.getByRole("button", { name: "Open Media Library" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Clear Image Selection" })).toBeNull();
});

test("selects desktop library assets and directories from inline card actions", () => {
  const asset: ImageLibraryAsset = {
    entryId: "portrait",
    metadataPath: "/repo/src/content/photos/portrait.yml",
    imagePath: "/repo/src/content/photos/portrait.jpg",
    metadata: {},
    health: ["valid"],
  };
  const toggleAsset = vi.fn();
  const toggleDirectory = vi.fn();
  const openDirectory = vi.fn();
  render(
    <MantineProvider forceColorScheme="light">
      <ImageLibraryBrowser
        rootDirectory="/repo/src/content/photos"
        currentDirectory=""
        directories={["/repo/src/content/photos/albums"]}
        assets={[asset]}
        inlineSelection
        selectedAssetIds={new Set()}
        selectedDirectoryPaths={new Set()}
        onDirectoryChange={openDirectory}
        onToggleSelection={toggleAsset}
        onToggleDirectorySelection={toggleDirectory}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    </MantineProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Select portrait" }));
  fireEvent.click(screen.getByRole("button", { name: "Select albums" }));

  expect(toggleAsset).toHaveBeenCalledWith(asset);
  expect(toggleDirectory).toHaveBeenCalledWith("/repo/src/content/photos/albums");
  expect(openDirectory).not.toHaveBeenCalled();
});

test("shift-clicks desktop library asset and directory cards to toggle selection", () => {
  const asset: ImageLibraryAsset = {
    entryId: "portrait",
    metadataPath: "/repo/src/content/photos/portrait.yml",
    imagePath: "/repo/src/content/photos/portrait.jpg",
    metadata: {},
    health: ["valid"],
  };
  const toggleAsset = vi.fn();
  const toggleDirectory = vi.fn();
  const editAsset = vi.fn();
  const openDirectory = vi.fn();
  const { container } = render(
    <MantineProvider forceColorScheme="light">
      <ImageLibraryBrowser
        rootDirectory="/repo/src/content/photos"
        currentDirectory=""
        directories={["/repo/src/content/photos/albums"]}
        assets={[asset]}
        inlineSelection
        selectedAssetIds={new Set()}
        selectedDirectoryPaths={new Set()}
        onDirectoryChange={openDirectory}
        onToggleSelection={toggleAsset}
        onToggleDirectorySelection={toggleDirectory}
        onEdit={editAsset}
        onDelete={vi.fn()}
      />
    </MantineProvider>,
  );

  fireEvent.click(container.querySelector('.picker-card[aria-label="Edit portrait"]')!, {
    shiftKey: true,
  });
  fireEvent.click(container.querySelector('.picker-directory[aria-label="Open albums"]')!, {
    shiftKey: true,
  });

  expect(toggleAsset).toHaveBeenCalledWith(asset);
  expect(toggleDirectory).toHaveBeenCalledWith("/repo/src/content/photos/albums");
  expect(editAsset).not.toHaveBeenCalled();
  expect(openDirectory).not.toHaveBeenCalled();
});

test("opens a filesystem directory drop directly on image metadata details", () => {
  render(
    <MantineProvider forceColorScheme="light">
      <ImageLibraryImportDialog
        root="/repo"
        library={library}
        config={{ media: [], content: [], mediaLibraries: [library] }}
        groups={[]}
        sourcePaths={["/tmp/portrait.jpg"]}
        initialFolder="albums/portraits"
        skipLocationSelection
        onClose={vi.fn()}
        onImported={vi.fn()}
      />
    </MantineProvider>,
  );

  expect((screen.getByLabelText("Filename (framework ID)") as HTMLInputElement).value).toBe(
    "portrait",
  );
  expect(screen.getByText("Importing into albums/portraits")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Import image" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Choose location" })).toBeNull();
});

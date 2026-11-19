// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Field, MediaLibrary } from "@posto/core/pagescms/config";
import type { ImageLibraryAsset } from "@posto/core/project/mediaLibrary";
import { invoke, readImageDetails, readRemoteImageDetails } from "@posto/ipc";
import { ValidateImageLibraryAssetsDialog } from "../src/components/ImageLibraryManageDialogs";
import { validateImageLibraryAssets } from "../src/imageLibraryValidation";
import {
  allItemsSelected,
  selectAllItems,
  selectedLibraryAssets,
  visibleLibraryItems,
} from "../src/imageLibrarySelection";

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
  invoke: vi.fn(),
  readImageDetails: vi.fn(),
  readRemoteImageDetails: vi.fn(),
}));

const from = (value: string, locked: boolean) => ({
  defaultFrom: { field: ["image"], value, locked },
});

function library(fields: Field[]): MediaLibrary {
  return {
    collection: "photos",
    base: "src/media/photos",
    patterns: ["**/*.yml"],
    metadataExtensions: ["yml"],
    imageFieldPath: ["image"],
    fields: [{ name: "image", type: "image" }, ...fields],
  };
}

const locked = library([
  { name: "taken_at", type: "date", options: from("capture-date", false) },
  { name: "width", type: "number", options: from("width", true) },
  { name: "height", type: "number", options: from("height", true) },
]);

const root = "/site/src/media/photos";
function asset(name: string, source: string, image: Partial<ImageLibraryAsset> = {}) {
  return {
    libraryId: "photos",
    entryId: name,
    metadataPath: `${root}/${name}.yml`,
    imagePath: `${root}/${name}.jpg`,
    metadata: YAML.parse(source, { schema: "core" }) as Record<string, unknown>,
    metadataSource: source,
    health: ["valid"],
    ...image,
  } as ImageLibraryAsset;
}

const writes = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "write_text_file")
    .map(([, args]) => args as { path: string; content: string });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockReset().mockResolvedValue(null);
  vi.mocked(readImageDetails)
    .mockReset()
    .mockResolvedValue({
      captureDate: "2026-10-07T13:26:04",
      dimensions: { width: 1600, height: 900 },
    });
  vi.mocked(readRemoteImageDetails)
    .mockReset()
    .mockResolvedValue({
      captureDate: null,
      dimensions: { width: 4128, height: 6192 },
    });
});

afterEach(cleanup);

describe("validating library entries", () => {
  test("sets locked fields from the image and leaves editable ones alone", async () => {
    const wrong = asset("harbor", "# Dawn\nimage: ./harbor.jpg\ntaken_at: 2020-01-01\nwidth: 10\n");

    const result = await validateImageLibraryAssets({ library: locked, assets: [wrong] });

    expect(result).toEqual({ updated: ["harbor"], unchanged: 0, failed: [] });
    const [write] = writes();
    expect(write.path).toBe(`${root}/harbor.yml`);
    expect(write.content).toContain("# Dawn");
    expect(write.content).toContain("taken_at: 2020-01-01");
    expect(write.content).toContain("width: 1600");
    expect(write.content).toContain("height: 900");
  });

  test("fills initial fields whose key is missing, but not empty ones", async () => {
    const missing = asset("harbor", "image: ./harbor.jpg\nwidth: 1600\nheight: 900\n");
    const cleared = asset("dock", "image: ./dock.jpg\ntaken_at:\nwidth: 1600\nheight: 900\n");

    const result = await validateImageLibraryAssets({
      library: locked,
      assets: [missing, cleared],
    });

    expect(result).toEqual({ updated: ["harbor"], unchanged: 1, failed: [] });
    expect(writes().map((write) => write.content)).toEqual([
      "image: ./harbor.jpg\nwidth: 1600\nheight: 900\ntaken_at: 2026-10-07T13:26:04\n",
    ]);
  });

  test("entries that already match aren't rewritten", async () => {
    const right = asset(
      "harbor",
      "image: ./harbor.jpg\ntaken_at: 2020-01-01\nwidth: 1600\nheight: 900\n",
    );

    const result = await validateImageLibraryAssets({ library: locked, assets: [right] });

    expect(result).toEqual({ updated: [], unchanged: 1, failed: [] });
    expect(writes()).toEqual([]);
  });

  test("an entry with nothing to fill isn't read", async () => {
    const editable = library([{ name: "width", type: "number", options: from("width", false) }]);

    const result = await validateImageLibraryAssets({
      library: editable,
      assets: [asset("harbor", "image: ./harbor.jpg\nwidth: 10\n")],
    });

    expect(result.unchanged).toBe(1);
    expect(readImageDetails).not.toHaveBeenCalled();
  });

  test("CDN images are measured from their URL", async () => {
    const url = "https://www.example.com/photo/harbor-1a2b3c4d.jpg";
    const published = asset("harbor", `image: ${url}\ntaken_at: 2020-01-01\n`, {
      imagePath: null,
      imageUrl: url,
    });

    await validateImageLibraryAssets({ library: locked, assets: [published] });

    expect(readRemoteImageDetails).toHaveBeenCalledWith(url, false);
    expect(writes()[0].content).toContain("width: 4128");
  });

  test("a capture date to fill asks for the date too", async () => {
    const url = "https://www.example.com/photo/harbor-1a2b3c4d.jpg";
    const dated = library([
      { name: "taken_at", type: "date", options: from("capture-date", true) },
    ]);
    const published = asset("harbor", `image: ${url}\n`, { imagePath: null, imageUrl: url });

    await validateImageLibraryAssets({ library: dated, assets: [published] });

    expect(readRemoteImageDetails).toHaveBeenCalledWith(url, true);
  });

  test("one failure doesn't stop the others", async () => {
    vi.mocked(readImageDetails)
      .mockRejectedValueOnce(new Error("Could not read the image"))
      .mockResolvedValue({ captureDate: null, dimensions: { width: 1600, height: 900 } });
    const progress = vi.fn();

    const result = await validateImageLibraryAssets({
      library: locked,
      assets: [
        asset("broken", "image: ./broken.jpg\n"),
        asset("harbor", "image: ./harbor.jpg\n"),
        asset("missing", "image: ./missing.jpg\n", { imagePath: null }),
      ],
      onProgress: progress,
    });

    expect(result.updated).toEqual(["harbor"]);
    expect(result.failed).toEqual([
      { entryId: "broken", message: "Could not read the image" },
      { entryId: "missing", message: "This entry has no image." },
    ]);
    expect(progress).toHaveBeenLastCalledWith(3, 3);
  });
});

describe("the Validate items dialog", () => {
  const onBeforeChange = vi.fn(() => Promise.resolve());
  function dialog(target: MediaLibrary, assets: ImageLibraryAsset[]) {
    const onValidated = vi.fn();
    render(
      <MantineProvider forceColorScheme="light">
        <ValidateImageLibraryAssetsDialog
          library={target}
          assets={assets}
          onBeforeChange={onBeforeChange}
          onClose={vi.fn()}
          onValidated={onValidated}
        />
      </MantineProvider>,
    );
    return onValidated;
  }

  test("reports what changed and refreshes the library", async () => {
    const onValidated = dialog(locked, [
      asset("harbor", "image: ./harbor.jpg\n"),
      asset("dock", "image: ./dock.jpg\ntaken_at: 2020-01-01\nwidth: 1600\nheight: 900\n"),
    ]);

    expect(await screen.findByText(/Updated 1 item\. 1 item was already correct\./)).toBeTruthy();
    expect(onBeforeChange).toHaveBeenCalledOnce();
    expect(onValidated).toHaveBeenCalledOnce();
  });

  test("explains when no fields come from the image", async () => {
    const plain = library([{ name: "width", type: "number" }]);
    const onValidated = dialog(plain, [asset("harbor", "image: ./harbor.jpg\n")]);

    expect(screen.getByText(/no fields that take a value from its image/)).toBeTruthy();
    await waitFor(() => expect(readImageDetails).not.toHaveBeenCalled());
    expect(onValidated).not.toHaveBeenCalled();
  });
});

describe("selecting library items", () => {
  const assets = [
    asset("harbor", "image: ./harbor.jpg\n"),
    asset("dock", "image: ./dock.jpg\n"),
    asset("broken", "image: ./broken.jpg\n", { health: ["missing-image"] }),
    { ...asset("trips/boat", "image: ./boat.jpg\n"), metadataPath: `${root}/trips/boat.yml` },
  ];
  const directories = [`${root}/trips`, `${root}/trips/2026`];
  const visible = visibleLibraryItems(root, "", directories, assets);

  test("select all covers the folders and valid entries in view", () => {
    expect(visible).toEqual({
      assetIds: [`${root}/harbor.yml`, `${root}/dock.yml`],
      folders: [`${root}/trips`],
    });
    const next = selectAllItems(visible, new Set(), new Set());
    expect(allItemsSelected(visible, next.selected, next.selectedDirectories)).toBe(true);
    expect(allItemsSelected(visible, new Set([`${root}/harbor.yml`]), new Set())).toBe(false);
    expect(allItemsSelected({ assetIds: [], folders: [] }, new Set(), new Set())).toBe(false);
  });

  test("selecting a folder drops selections inside it", () => {
    const next = selectAllItems(
      visible,
      new Set([`${root}/trips/boat.yml`]),
      new Set([`${root}/trips/2026`]),
    );
    expect([...next.selected].sort()).toEqual([`${root}/dock.yml`, `${root}/harbor.yml`]);
    expect([...next.selectedDirectories]).toEqual([`${root}/trips`]);
  });

  test("selected folders include their entries", () => {
    const chosen = selectedLibraryAssets(
      assets,
      new Set([`${root}/harbor.yml`]),
      new Set([`${root}/trips`]),
    );
    expect(chosen.map((item) => item.entryId)).toEqual(["harbor", "trips/boat"]);
  });
});

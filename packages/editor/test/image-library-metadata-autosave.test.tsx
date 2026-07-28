// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, expect, test, vi } from "vitest";
import type { MediaLibrary } from "@posto/core/pagescms/config";
import type { ImageLibraryAsset } from "@posto/core/project/mediaLibrary";
import { ImageLibraryReferenceField } from "../src/components/ImageLibraryReferenceField";
import type { FieldContext } from "../src/components/FieldEditor";
import { MediaDragDropProvider } from "../src/components/MediaDragDrop";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const assets: ImageLibraryAsset[] = [
  {
    entryId: "a",
    metadataPath: "/repo/photos/a.yml",
    imagePath: "/repo/photos/a.jpg",
    metadata: { image: "./a.jpg", alt: "Old A" },
    health: ["valid"],
  },
  {
    entryId: "b",
    metadataPath: "/repo/photos/b.yml",
    imagePath: "/repo/photos/b.jpg",
    metadata: { image: "./b.jpg", alt: "Old B" },
    health: ["valid"],
  },
];
let currentAssets = assets;

vi.mock("@posto/ipc", () => ({
  invoke: mocks.invoke,
  thumbnailUrl: vi.fn().mockResolvedValue(null),
}));

vi.mock("../src/hooks/useImageLibraryAssets", () => ({
  useImageLibraryAssets: () => ({
    assets: currentAssets,
    directories: [],
    error: null,
    loading: false,
    refresh: vi.fn(),
  }),
}));

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

afterEach(() => {
  cleanup();
  currentAssets = assets;
  mocks.invoke.mockClear();
});

const library: MediaLibrary = {
  collection: "photos",
  base: "photos",
  patterns: ["**/*.yml"],
  metadataExtensions: ["yml"],
  imageFieldPath: ["image"],
  fields: [
    { name: "image", type: "image" },
    { name: "alt", type: "string" },
  ],
};

test("flushes pending metadata to the asset being left", async () => {
  let selected = "a";
  const ctx: FieldContext = {
    config: { media: [], content: [], mediaLibraries: [library] },
    root: "/repo",
    entry: null,
    documentPath: "/repo/post.md",
    groups: [],
    errors: () => new Map(),
    templateValues: () => ({}),
    value: () => selected,
    edit: vi.fn(),
    listAppend: vi.fn(),
    listRemove: vi.fn(),
    listMove: vi.fn(),
  };
  const view = () => (
    <MantineProvider forceColorScheme="light">
      <MediaDragDropProvider>
        <ImageLibraryReferenceField
          field={{ name: "photo", type: "reference" }}
          path={["photo"]}
          ctx={ctx}
          library={library}
        />
      </MediaDragDropProvider>
    </MantineProvider>
  );
  const rendered = render(view());

  fireEvent.change(await screen.findByDisplayValue("Old A"), {
    target: { value: "Edited A" },
  });
  selected = "b";
  rendered.rerender(view());
  await act(async () => undefined);

  const write = mocks.invoke.mock.calls.find(([command]) => command === "write_text_file");
  expect(write?.[1]).toMatchObject({ path: "/repo/photos/a.yml" });
  expect(String(write?.[1]?.content)).toContain("Edited A");
  expect(String(write?.[1]?.path)).not.toContain("/b.yml");
});

test("preserves dirty metadata when the selected asset is refreshed", async () => {
  const ctx: FieldContext = {
    config: { media: [], content: [], mediaLibraries: [library] },
    root: "/repo",
    entry: null,
    documentPath: "/repo/post.md",
    groups: [],
    errors: () => new Map(),
    templateValues: () => ({}),
    value: () => "a",
    edit: vi.fn(),
    listAppend: vi.fn(),
    listRemove: vi.fn(),
    listMove: vi.fn(),
  };
  const view = () => (
    <MantineProvider forceColorScheme="light">
      <MediaDragDropProvider>
        <ImageLibraryReferenceField
          field={{ name: "photo", type: "reference" }}
          path={["photo"]}
          ctx={ctx}
          library={library}
        />
      </MediaDragDropProvider>
    </MantineProvider>
  );
  const rendered = render(view());

  fireEvent.change(await screen.findByDisplayValue("Old A"), {
    target: { value: "Unsaved edit" },
  });
  currentAssets = assets.map((asset) => ({
    ...asset,
    metadata: structuredClone(asset.metadata),
  }));
  rendered.rerender(view());
  await act(async () => undefined);

  expect(screen.getByDisplayValue("Unsaved edit")).toBeTruthy();
});

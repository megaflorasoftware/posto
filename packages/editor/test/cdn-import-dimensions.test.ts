// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { MediaLibrary } from "@posto/core/pagescms/config";
import { inspectMediaFile } from "@posto/ipc";
import { useImageLibraryImport } from "../src/hooks/useImageLibraryImport";
import { imageLibraryMetadataFields } from "../src/imageLibraryMetadata";

vi.mock("@posto/ipc", () => ({
  importImageLibraryAsset: vi.fn(),
  inspectMediaFile: vi.fn(),
  invoke: vi.fn().mockResolvedValue([]),
  openImageFiles: vi.fn().mockResolvedValue([]),
}));

const library: MediaLibrary = {
  collection: "photos",
  base: "src/data/photos",
  patterns: ["**/*.yaml"],
  metadataExtensions: ["yaml"],
  imageFieldPath: ["src"],
  mediaSource: "cdn",
  fields: [
    { name: "src", type: "image", required: true },
    { name: "alt", type: "string" },
    { name: "width", type: "number", required: true },
    { name: "height", type: "number", required: true },
  ],
};

async function planImport(target: MediaLibrary) {
  const { result } = renderHook(() =>
    useImageLibraryImport({
      root: "/site",
      library: target,
      initialSources: ["/photos/harbor.jpg"],
    }),
  );
  let plan: Awaited<ReturnType<typeof result.current.plan>> | undefined;
  await act(async () => {
    plan = await result.current.plan(result.current.drafts[0]);
  });
  return plan!;
}

beforeEach(() => {
  vi.mocked(inspectMediaFile).mockReset();
  vi.mocked(inspectMediaFile).mockResolvedValue({
    sha256: "a".repeat(64),
    size: 10,
    contentType: "image/jpeg",
    dimensions: { width: 1600, height: 900 },
  });
});

test("imports into a CDN-bound library record the image's dimensions", async () => {
  const plan = await planImport(library);
  expect(plan.metadata).toMatchObject({ width: 1600, height: 900 });
});

test("an unmeasurable image reports the schema's required fields", async () => {
  vi.mocked(inspectMediaFile).mockRejectedValue(new Error("unreadable"));
  await expect(planImport(library)).rejects.toThrow();
});

test("local libraries aren't measured", async () => {
  const local = {
    ...library,
    mediaSource: undefined,
    fields: library.fields.map((field) => ({ ...field, required: false })),
  };
  const plan = await planImport(local);
  expect(plan.metadata.width).toBeUndefined();
  expect(inspectMediaFile).not.toHaveBeenCalled();
});

test("editors only see dimension fields on local libraries", () => {
  const names = (target: MediaLibrary) =>
    imageLibraryMetadataFields(target).map((field) => field.name);
  expect(names(library)).toEqual(["alt"]);
  expect(names({ ...library, mediaSource: undefined })).toEqual(["alt", "width", "height"]);
});

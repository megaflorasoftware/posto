// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { MediaLibrary } from "@posto/core/pagescms/config";
import { inspectMediaFile, readCaptureDate } from "@posto/ipc";
import { useImageLibraryImport } from "../src/hooks/useImageLibraryImport";
import { imageLibraryMetadataFields } from "../src/imageLibraryMetadata";

vi.mock("@posto/ipc", () => ({
  importImageLibraryAsset: vi.fn(),
  inspectMediaFile: vi.fn(),
  invoke: vi.fn().mockResolvedValue([]),
  openImageFiles: vi.fn().mockResolvedValue([]),
  readCaptureDate: vi.fn(),
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
    { name: "width", type: "number", required: true, options: { defaultFrom: "width" } },
    { name: "height", type: "number", required: true, options: { defaultFrom: "height" } },
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

test("imports record the image's dimensions when the schema asks for them", async () => {
  const plan = await planImport(library);
  expect(plan.metadata).toMatchObject({ width: 1600, height: 900 });
});

test("local libraries are measured too when annotated", async () => {
  const plan = await planImport({ ...library, mediaSource: undefined });
  expect(plan.metadata).toMatchObject({ width: 1600, height: 900 });
});

test("an unmeasurable image reports the schema's required fields", async () => {
  vi.mocked(inspectMediaFile).mockRejectedValue(new Error("unreadable"));
  await expect(planImport(library)).rejects.toThrow();
});

test("libraries without dimension annotations aren't measured", async () => {
  const plain = {
    ...library,
    fields: library.fields.map((field) => ({ ...field, required: false, options: undefined })),
  };
  const plan = await planImport(plain);
  expect(plan.metadata.width).toBeUndefined();
  expect(inspectMediaFile).not.toHaveBeenCalled();
});

test("annotated dimension fields are hidden from editors", () => {
  const names = (target: MediaLibrary) =>
    imageLibraryMetadataFields(target).map((field) => field.name);
  expect(names(library)).toEqual(["alt"]);
  expect(names({ ...library, mediaSource: undefined })).toEqual(["alt"]);
  const plain = {
    ...library,
    fields: library.fields.map((field) => ({ ...field, options: undefined })),
  };
  expect(names(plain)).toEqual(["alt", "width", "height"]);
});

describe("capture dates", () => {
  const dated: MediaLibrary = {
    ...library,
    mediaSource: undefined,
    fields: [
      { name: "src", type: "image", required: true },
      { name: "taken_at", type: "date", options: { defaultFrom: "capture-date" } },
      { name: "width", type: "number" },
      { name: "height", type: "number" },
    ],
  };

  beforeEach(() => {
    vi.mocked(readCaptureDate).mockReset().mockResolvedValue("2026-10-07T13:26:04");
  });

  test("the import form shows each photo's capture date", async () => {
    const { result } = renderHook(() =>
      useImageLibraryImport({
        root: "/site",
        library: dated,
        initialSources: ["/photos/harbor.jpg"],
      }),
    );

    await waitFor(() =>
      expect(result.current.drafts[0].metadata.taken_at).toBe("2026-10-07T13:26:04"),
    );
    expect(readCaptureDate).toHaveBeenCalledWith("/photos/harbor.jpg");
  });

  test("a date the user already entered is kept", async () => {
    let resolve!: (date: string) => void;
    vi.mocked(readCaptureDate).mockReturnValue(new Promise((done) => (resolve = done)));
    const { result } = renderHook(() =>
      useImageLibraryImport({
        root: "/site",
        library: dated,
        initialSources: ["/photos/harbor.jpg"],
      }),
    );

    act(() =>
      result.current.updateDraft(0, (draft) => ({
        ...draft,
        metadata: { ...draft.metadata, taken_at: "2020-01-01" },
      })),
    );
    await act(async () => resolve("2026-10-07T13:26:04"));

    expect(result.current.drafts[0].metadata.taken_at).toBe("2020-01-01");
  });

  test("an import that starts before the date is read still gets it", async () => {
    const plan = await planImport(dated);
    expect(plan.metadata.taken_at).toBe("2026-10-07T13:26:04");
  });

  test("photos without a capture date leave the field empty", async () => {
    vi.mocked(readCaptureDate).mockResolvedValue(null);
    const plan = await planImport(dated);
    expect(plan.metadata.taken_at).toBeUndefined();
  });

  test("libraries without the annotation never read dates", async () => {
    const plain = {
      ...dated,
      fields: dated.fields.map((field) => ({ ...field, options: undefined })),
    };
    await planImport(plain);
    expect(readCaptureDate).not.toHaveBeenCalled();
  });
});

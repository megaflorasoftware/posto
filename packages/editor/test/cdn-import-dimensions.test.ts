// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Field, MediaLibrary } from "@posto/core/pagescms/config";
import { readImageDetails } from "@posto/ipc";
import { useImageLibraryImport } from "../src/hooks/useImageLibraryImport";
import { imageLibraryMetadataFields } from "../src/imageLibraryMetadata";

vi.mock("@posto/ipc", () => ({
  importImageLibraryAsset: vi.fn(),
  invoke: vi.fn().mockResolvedValue([]),
  openImageFiles: vi.fn().mockResolvedValue([]),
  readImageDetails: vi.fn(),
}));

const fromImage = (value: string, locked = false) => ({
  defaultFrom: { field: ["src"], value, locked },
});

function library(fields: Field[]): MediaLibrary {
  return {
    collection: "photos",
    base: "src/data/photos",
    patterns: ["**/*.yaml"],
    metadataExtensions: ["yaml"],
    imageFieldPath: ["src"],
    mediaSource: "cdn",
    fields: [
      { name: "src", type: "image", required: true },
      { name: "alt", type: "string" },
      ...fields,
    ],
  };
}

const annotated = library([
  { name: "taken_at", type: "date", options: fromImage("capture-date") },
  { name: "width", type: "number", required: true, options: fromImage("width") },
  { name: "height", type: "number", required: true, options: fromImage("height") },
]);

function render(target: MediaLibrary) {
  return renderHook(() =>
    useImageLibraryImport({
      root: "/site",
      library: target,
      initialSources: ["/photos/harbor.jpg"],
    }),
  );
}

async function planImport(target: MediaLibrary) {
  const { result } = render(target);
  let plan: Awaited<ReturnType<typeof result.current.plan>> | undefined;
  await act(async () => {
    plan = await result.current.plan(result.current.drafts[0]);
  });
  return plan!;
}

beforeEach(() => {
  vi.mocked(readImageDetails)
    .mockReset()
    .mockResolvedValue({
      captureDate: "2026-10-07T13:26:04",
      dimensions: { width: 1600, height: 900 },
    });
});

describe("initial values", () => {
  test("the import form shows each photo's capture date and size", async () => {
    const { result } = render(annotated);

    await waitFor(() =>
      expect(result.current.drafts[0].metadata).toMatchObject({
        taken_at: "2026-10-07T13:26:04",
        width: 1600,
        height: 900,
      }),
    );
    expect(readImageDetails).toHaveBeenCalledWith("/photos/harbor.jpg");
  });

  test("editors can still see and change them", () => {
    expect(imageLibraryMetadataFields(annotated).map((field) => field.name)).toEqual([
      "alt",
      "taken_at",
      "width",
      "height",
    ]);
  });

  test("a value the user already entered is kept", async () => {
    let resolve!: (details: Awaited<ReturnType<typeof readImageDetails>>) => void;
    vi.mocked(readImageDetails).mockReturnValue(new Promise((done) => (resolve = done)));
    const { result } = render(annotated);

    act(() =>
      result.current.updateDraft(0, (draft) => ({
        ...draft,
        metadata: { ...draft.metadata, taken_at: "2020-01-01", width: 10 },
      })),
    );
    await act(async () =>
      resolve({ captureDate: "2026-10-07T13:26:04", dimensions: { width: 1600, height: 900 } }),
    );

    expect(result.current.drafts[0].metadata).toMatchObject({
      taken_at: "2020-01-01",
      width: 10,
      height: 900,
    });
  });

  test("an import that starts before the image is read still gets its values", async () => {
    const plan = await planImport(annotated);
    expect(plan.metadata).toMatchObject({ taken_at: "2026-10-07T13:26:04", width: 1600 });
  });

  test("missing details leave fields empty for the schema to validate", async () => {
    vi.mocked(readImageDetails).mockResolvedValue({ captureDate: null, dimensions: null });
    await expect(planImport(annotated)).rejects.toThrow();
    const optional = library([
      { name: "taken_at", type: "date", options: fromImage("capture-date") },
    ]);
    const plan = await planImport(optional);
    expect(plan.metadata.taken_at).toBeUndefined();
  });

  test("annotations naming another field are ignored", async () => {
    const elsewhere = library([
      {
        name: "width",
        type: "number",
        options: { defaultFrom: { field: ["hero"], value: "width", locked: false } },
      },
    ]);
    await planImport(elsewhere);
    expect(readImageDetails).not.toHaveBeenCalled();
  });

  test("libraries without annotations never read the image", async () => {
    await planImport(library([{ name: "width", type: "number" }]));
    expect(readImageDetails).not.toHaveBeenCalled();
  });
});

describe("locked values", () => {
  const locked = library([{ name: "width", type: "number", options: fromImage("width", true) }]);

  test("always take the image's value", async () => {
    const { result } = render(locked);
    act(() =>
      result.current.updateDraft(0, (draft) => ({
        ...draft,
        metadata: { ...draft.metadata, width: 10 },
      })),
    );
    let plan: Awaited<ReturnType<typeof result.current.plan>> | undefined;
    await act(async () => {
      plan = await result.current.plan(result.current.drafts[0]);
    });
    expect(plan!.metadata.width).toBe(1600);
  });
});

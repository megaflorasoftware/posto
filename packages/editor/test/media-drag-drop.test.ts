import { describe, expect, test } from "vitest";
import {
  acceptsMediaDrop,
  type MediaDragItem,
  type MediaDragSelection,
} from "../src/components/MediaDragDrop";
import type { MarkdownMediaPick } from "../src/markdownMedia";

function image(id: string): MarkdownMediaPick {
  return { outputPath: `/${id}.jpg`, label: id, kind: "image" };
}

function selection(items: MediaDragItem[], media: MarkdownMediaPick[]): MediaDragSelection {
  return { items, media, source: null };
}

describe("media drop categories", () => {
  test("accepts any non-empty sidebar item group for directory moves", () => {
    const dragged: MediaDragSelection = {
      items: [
        { id: "one", kind: "image" },
        { id: "albums", kind: "directory" },
        { id: "song", kind: "audio" },
      ],
      media: [image("one")],
      source: {
        kind: "media-sidebar",
        scope: "public",
        items: [
          { id: "one", kind: "image" },
          { id: "albums", kind: "directory" },
          { id: "song", kind: "audio" },
        ],
      },
    };

    expect(acceptsMediaDrop(dragged, "sidebar-items")).toBe(true);
    expect(acceptsMediaDrop({ ...dragged, items: [] }, "sidebar-items")).toBe(false);
  });

  test("accepts exactly one image for single-image fields", () => {
    const dragged = selection([{ id: "one", kind: "image" }], [image("one")]);

    expect(acceptsMediaDrop(dragged, "single-image")).toBe(true);
    expect(acceptsMediaDrop(dragged, "image-list")).toBe(true);
  });

  test("accepts multiple images only for rich text image lists", () => {
    const dragged = selection(
      [
        { id: "one", kind: "image" },
        { id: "two", kind: "image" },
      ],
      [image("one"), image("two")],
    );

    expect(acceptsMediaDrop(dragged, "single-image")).toBe(false);
    expect(acceptsMediaDrop(dragged, "image-list")).toBe(true);
  });

  test("rejects directories from image fields and rich text", () => {
    const directory = selection([{ id: "albums", kind: "directory" }], []);
    const mixed = selection(
      [
        { id: "one", kind: "image" },
        { id: "albums", kind: "directory" },
      ],
      [image("one")],
    );

    expect(acceptsMediaDrop(directory, "single-image")).toBe(false);
    expect(acceptsMediaDrop(directory, "image-list")).toBe(false);
    expect(acceptsMediaDrop(mixed, "single-image")).toBe(false);
    expect(acceptsMediaDrop(mixed, "image-list")).toBe(false);
  });

  test("rejects non-image media and incomplete image payloads", () => {
    const audio: MarkdownMediaPick = {
      outputPath: "/song.mp3",
      label: "song",
      kind: "audio",
    };

    expect(
      acceptsMediaDrop(selection([{ id: "song", kind: "audio" }], [audio]), "image-list"),
    ).toBe(false);
    expect(
      acceptsMediaDrop(
        selection(
          [
            { id: "one", kind: "image" },
            { id: "two", kind: "image" },
          ],
          [image("one")],
        ),
        "image-list",
      ),
    ).toBe(false);
  });
});

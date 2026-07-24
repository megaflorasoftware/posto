// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { MediaLibrary } from "@posto/core/pagescms/config";
import { MediaLibraryTabs, PUBLIC_MEDIA_TAB } from "../src/components/MediaLibraryTabs";
import { isPublicMediaFile } from "../src/hooks/usePublicMediaFiles";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function library(collection: string): MediaLibrary {
  return {
    collection,
    base: `src/content/${collection}`,
    patterns: ["**/*.yml"],
    metadataExtensions: ["yml"],
    imageFieldPath: ["image"],
    fields: [],
  };
}

describe("public media", () => {
  test("shows explicit libraries first and public last", () => {
    render(
      <MediaLibraryTabs
        libraries={[library("photos"), library("illustrations")]}
        selected={PUBLIC_MEDIA_TAB}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "photos",
      "illustrations",
      "public",
    ]);
    expect(screen.getByRole("tab", { name: "public" }).getAttribute("aria-selected")).toBe("true");
  });

  test("includes binary media formats while excluding text and code files", () => {
    expect(
      ["guide.pdf", "song.mp3", "movie.mp4", "font.woff2", "photo.jpg", "mark.svg"].every(
        isPublicMediaFile,
      ),
    ).toBe(true);
    expect(
      [
        "README",
        "readme.md",
        "notes.txt",
        "page.html",
        "styles.css",
        "data.json",
        "script.ts",
      ].some(isPublicMediaFile),
    ).toBe(false);
  });
});

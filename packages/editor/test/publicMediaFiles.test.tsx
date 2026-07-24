// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { MediaLibrary } from "@posto/core/pagescms/config";
import { MediaLibraryTabs, PUBLIC_MEDIA_TAB } from "../src/components/MediaLibraryTabs";
import { FileMediaBrowser } from "../src/components/PublicMediaBrowser";
import { isPublicMediaFile } from "../src/hooks/usePublicMediaFiles";

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

afterEach(cleanup);

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

  test("selects files and directories without opening them", () => {
    const toggleFile = vi.fn();
    const toggleDirectory = vi.fn();
    render(
      <FileMediaBrowser
        rootDirectory="/repo/media"
        currentDirectory=""
        directories={["/repo/media/albums"]}
        files={[{ name: "guide.pdf", path: "/repo/media/guide.pdf" }]}
        selectionMode
        selectedFilePaths={new Set()}
        selectedDirectoryPaths={new Set()}
        onDirectoryChange={vi.fn()}
        onToggleFileSelection={toggleFile}
        onToggleDirectorySelection={toggleDirectory}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select guide.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: /albums/i }));

    expect(toggleFile).toHaveBeenCalledWith({
      name: "guide.pdf",
      path: "/repo/media/guide.pdf",
    });
    expect(toggleDirectory).toHaveBeenCalledWith("/repo/media/albums");
  });

  test("opens file media items for editing when an editor is supplied", () => {
    const onEdit = vi.fn();
    const file = { name: "guide.pdf", path: "/repo/media/guide.pdf" };
    render(
      <MantineProvider forceColorScheme="light">
        <FileMediaBrowser
          rootDirectory="/repo/media"
          currentDirectory=""
          directories={[]}
          files={[file]}
          onDirectoryChange={vi.fn()}
          onEdit={onEdit}
        />
      </MantineProvider>,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Edit guide.pdf" })[0]);
    expect(onEdit).toHaveBeenCalledWith(file);
  });

  test("selects desktop files and directories from inline card actions", () => {
    const toggleFile = vi.fn();
    const toggleDirectory = vi.fn();
    const openDirectory = vi.fn();
    render(
      <MantineProvider forceColorScheme="light">
        <FileMediaBrowser
          rootDirectory="/repo/media"
          currentDirectory=""
          directories={["/repo/media/albums"]}
          files={[{ name: "guide.pdf", path: "/repo/media/guide.pdf" }]}
          inlineSelection
          selectedFilePaths={new Set()}
          selectedDirectoryPaths={new Set()}
          onDirectoryChange={openDirectory}
          onToggleFileSelection={toggleFile}
          onToggleDirectorySelection={toggleDirectory}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
        />
      </MantineProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select guide.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "Select albums" }));

    expect(toggleFile).toHaveBeenCalledWith({
      name: "guide.pdf",
      path: "/repo/media/guide.pdf",
    });
    expect(toggleDirectory).toHaveBeenCalledWith("/repo/media/albums");
    expect(openDirectory).not.toHaveBeenCalled();
  });

  test("shift-clicks desktop file and directory cards to toggle selection", () => {
    const toggleFile = vi.fn();
    const toggleDirectory = vi.fn();
    const editFile = vi.fn();
    const openDirectory = vi.fn();
    const { container } = render(
      <MantineProvider forceColorScheme="light">
        <FileMediaBrowser
          rootDirectory="/repo/media"
          currentDirectory=""
          directories={["/repo/media/albums"]}
          files={[{ name: "guide.pdf", path: "/repo/media/guide.pdf" }]}
          inlineSelection
          selectedFilePaths={new Set()}
          selectedDirectoryPaths={new Set()}
          onDirectoryChange={openDirectory}
          onToggleFileSelection={toggleFile}
          onToggleDirectorySelection={toggleDirectory}
          onEdit={editFile}
          onDelete={vi.fn()}
        />
      </MantineProvider>,
    );

    fireEvent.click(container.querySelector('.picker-card[aria-label="Edit guide.pdf"]')!, {
      shiftKey: true,
    });
    fireEvent.click(container.querySelector('.picker-directory[aria-label="Open albums"]')!, {
      shiftKey: true,
    });

    expect(toggleFile).toHaveBeenCalledWith({
      name: "guide.pdf",
      path: "/repo/media/guide.pdf",
    });
    expect(toggleDirectory).toHaveBeenCalledWith("/repo/media/albums");
    expect(editFile).not.toHaveBeenCalled();
    expect(openDirectory).not.toHaveBeenCalled();
  });

  test("enables directory cards as drag sources when they have a categorized payload", () => {
    render(
      <MantineProvider forceColorScheme="light">
        <FileMediaBrowser
          rootDirectory="/repo/media"
          currentDirectory=""
          directories={["/repo/media/albums"]}
          files={[]}
          inlineSelection
          selectedFilePaths={new Set()}
          selectedDirectoryPaths={new Set()}
          onDirectoryChange={vi.fn()}
          directoryDragPayload={(directory) => ({
            media: [],
            source: {
              kind: "media-sidebar",
              scope: "public",
              items: [{ id: directory, kind: "directory" }],
            },
          })}
        />
      </MantineProvider>,
    );

    expect(
      screen.getByRole("button", { name: "Open albums" }).querySelector(".is-media-draggable"),
    ).toBeTruthy();
  });
});

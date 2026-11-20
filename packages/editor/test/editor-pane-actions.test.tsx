// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ProjectIO } from "@posto/core/project/adapter";
import { EditorPane } from "../src/components/EditorPane";

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

const props = {
  root: "/site",
  projectIO: {} as ProjectIO,
  filePath: "/site/styles.css",
  fileContent: "body {}",
  saveState: "saved" as const,
  entry: null,
  entrySource: null,
  config: null,
  configError: null,
  hasDerivedFallback: false,
  componentBlocks: null,
  entryIds: null,
  groups: [],
  editorTab: "raw" as const,
  onTabChange: vi.fn(),
  onEdit: vi.fn(),
  onFormEdit: vi.fn(),
  onRenameFile: vi.fn(async () => true),
  onRefreshFilename: vi.fn(),
  onPostoSaved: vi.fn(),
};

describe("EditorPane header actions", () => {
  test("renders the close button after the fullscreen button and calls onClose", () => {
    const onClose = vi.fn();
    render(
      <MantineProvider>
        <EditorPane {...props} onFullscreen={vi.fn()} onClose={onClose} />
      </MantineProvider>,
    );

    const fullscreen = screen.getByRole("button", { name: "Open fullscreen editor" });
    const close = screen.getByRole("button", { name: "Close editor" });
    expect(fullscreen.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  });

  test("omits the close button without onClose", () => {
    render(
      <MantineProvider>
        <EditorPane {...props} />
      </MantineProvider>,
    );

    expect(screen.queryByRole("button", { name: "Close editor" })).toBeNull();
  });
});

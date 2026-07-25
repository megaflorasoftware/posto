// @vitest-environment jsdom

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { describe, expect, test, vi } from "vitest";
import { FileTree } from "../src/components/FileTree";
import type { DisplayGroupNode } from "../src/components/Sidebar";

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

const posts: DisplayGroupNode = {
  group: {
    label: "Posts",
    path: "/site/posts",
    files: [{ name: "first.md", path: "/site/posts/first.md" }],
  },
  collection: null,
  exact: false,
  children: [],
  depth: 0,
  defaultOpen: true,
};

const props = {
  root: "/site",
  activeKey: null,
  variant: "desktop" as const,
  developerMode: false,
  onOpen: vi.fn(),
  onDelete: vi.fn(),
  onNewFile: vi.fn(),
  onSettings: vi.fn(),
};

describe("FileTree", () => {
  test("expands a top-level directory when it arrives after the initial render", async () => {
    const view = render(
      <MantineProvider>
        <FileTree {...props} nodes={[]} />
      </MantineProvider>,
    );

    view.rerender(
      <MantineProvider>
        <FileTree {...props} nodes={[posts]} />
      </MantineProvider>,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "first.md" })).toBeTruthy());
  });
});

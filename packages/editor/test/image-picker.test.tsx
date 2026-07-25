// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, expect, test, vi } from "vitest";
import { FieldEditor, type FieldContext } from "../src/components/FieldEditor";
import { ImagePicker } from "../src/components/ImagePicker";
import { MediaDragDropProvider } from "../src/components/MediaDragDrop";

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
  invoke: vi.fn().mockResolvedValue([
    {
      name: "hero.jpg",
      path: "/repo/src/assets/hero.jpg",
    },
  ]),
  openPath: vi.fn(),
  thumbnailUrl: vi.fn().mockResolvedValue(null),
}));

afterEach(cleanup);

test("inserts a source image relative to the Astro content document", async () => {
  const onPick = vi.fn();
  render(
    <MantineProvider forceColorScheme="light">
      <ImagePicker
        root="/repo"
        media={{ name: "src", input: "src", output: "src", relative: true }}
        documentPath="/repo/src/content/blog/post.md"
        onClose={vi.fn()}
        onPick={onPick}
      />
    </MantineProvider>,
  );

  fireEvent.click((await screen.findByText("hero.jpg")).closest("button")!);
  expect(onPick).toHaveBeenCalledWith("../../assets/hero.jpg");
});

test("uses the image preview as the only field picker control", async () => {
  const edit = vi.fn();
  const ctx: FieldContext = {
    config: {
      media: [{ name: "src", input: "src", output: "src", relative: true }],
      content: [],
    },
    root: "/repo",
    entry: null,
    documentPath: "/repo/src/content/blog/post.md",
    groups: [],
    errors: () => new Map(),
    templateValues: () => ({}),
    value: () => "../../assets/hero.jpg",
    edit,
    listAppend: vi.fn(),
    listRemove: vi.fn(),
    listMove: vi.fn(),
  };
  render(
    <MantineProvider forceColorScheme="light">
      <MediaDragDropProvider>
        <FieldEditor field={{ name: "heroImage", type: "image" }} path={["heroImage"]} ctx={ctx} />
      </MediaDragDropProvider>
    </MantineProvider>,
  );

  expect(screen.queryByRole("button", { name: "Browse…" })).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Change image" }));
  fireEvent.click(await screen.findByRole("button", { name: "Clear Image Selection" }));
  expect(edit).toHaveBeenCalledWith(["heroImage"], undefined);
});

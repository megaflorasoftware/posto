// @vitest-environment jsdom

import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, expect, test, vi } from "vitest";
import { FieldEditor, type FieldContext } from "../src/components/FieldEditor";
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

afterEach(cleanup);

function ListHarness() {
  const [items, setItems] = useState(["first"]);
  const ctx: FieldContext = {
    config: { media: [], content: [] },
    root: "/repo",
    entry: null,
    documentPath: "/repo/post.md",
    groups: [],
    errors: () => new Map(),
    templateValues: () => ({}),
    value: (path) => (path.length === 1 ? items : items[Number(path[1])]),
    edit: (path, value) => {
      setItems((current) =>
        current.map((item, index) => (index === Number(path[1]) ? String(value) : item)),
      );
    },
    listAppend: vi.fn(),
    listRemove: vi.fn(),
    listMove: vi.fn(),
  };
  return (
    <FieldEditor field={{ name: "tags", type: "string", list: true }} path={["tags"]} ctx={ctx} />
  );
}

test("keeps a list input mounted while its value changes", () => {
  render(
    <MantineProvider forceColorScheme="light">
      <MediaDragDropProvider>
        <ListHarness />
      </MediaDragDropProvider>
    </MantineProvider>,
  );

  const input = screen.getByRole("textbox");
  input.focus();
  fireEvent.change(input, { target: { value: "first edit" } });

  expect(screen.getByRole("textbox")).toBe(input);
  expect(document.activeElement).toBe(input);
  expect((input as HTMLInputElement).value).toBe("first edit");
});

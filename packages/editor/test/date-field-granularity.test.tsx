// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
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

function dateInput(value: string) {
  const edit = vi.fn();
  const ctx: FieldContext = {
    config: { media: [], content: [] },
    root: "/repo",
    entry: null,
    documentPath: "/repo/photos/harbor.yaml",
    groups: [],
    errors: () => new Map(),
    templateValues: () => ({}),
    value: () => value,
    edit,
    listAppend: vi.fn(),
    listRemove: vi.fn(),
    listMove: vi.fn(),
  };
  const { container } = render(
    <MantineProvider forceColorScheme="light">
      <MediaDragDropProvider>
        <FieldEditor field={{ name: "taken_at", type: "date" }} path={["taken_at"]} ctx={ctx} />
      </MediaDragDropProvider>
    </MantineProvider>,
  );
  return { input: container.querySelector("input")!, edit };
}

test("a capture time gets a date-and-time picker that keeps the time", () => {
  const { input, edit } = dateInput("2026-10-06T14:27:43");

  expect(input.type).toBe("datetime-local");
  // Inputs may add milliseconds; saving ignores them.
  expect(input.value).toMatch(/^2026-10-06T14:27:43(\.000)?$/);
  fireEvent.change(input, { target: { value: "2026-10-07T09:05:12" } });
  expect(edit).toHaveBeenCalledWith(["taken_at"], "2026-10-07T09:05:12");
});

test("a plain date keeps the date picker", () => {
  const { input } = dateInput("2026-10-06");

  expect(input.type).toBe("date");
  expect(input.value).toBe("2026-10-06");
});

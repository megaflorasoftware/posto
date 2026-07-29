// @vitest-environment jsdom

import React, { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, expect, test, vi } from "vitest";
import { FieldEditor, type FieldContext } from "../src/components/FieldEditor";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  refreshed: vi.fn(),
  created: false,
}));

vi.mock("@posto/ipc", () => ({
  invoke: mocks.invoke,
}));

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
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

afterEach(() => {
  cleanup();
  mocks.invoke.mockReset();
  mocks.refreshed.mockReset();
  mocks.created = false;
});

function Harness() {
  const [author, setAuthor] = useState<string | undefined>();
  const [groups, setGroups] = useState<FieldContext["groups"]>([]);
  const ctx: FieldContext = {
    config: {
      media: [],
      content: [
        {
          name: "authors",
          label: "Authors",
          type: "collection",
          path: "src/content/authors",
          filename: "{primary}.md",
          fields: [{ name: "title", label: "Name", type: "string", required: true }],
        },
      ],
    },
    root: "/repo",
    entry: null,
    documentPath: "/repo/src/content/posts/post.md",
    groups,
    errors: () => new Map(),
    templateValues: () => ({ author }),
    value: () => author,
    edit: (_path, value) => setAuthor(value as string | undefined),
    listAppend: vi.fn(),
    listRemove: vi.fn(),
    listMove: vi.fn(),
    onReferenceCreated: async () => {
      mocks.refreshed();
      setGroups([
        {
          label: "Authors",
          path: "/repo/src/content/authors",
          files: [
            {
              name: "ada-lovelace.md",
              path: "/repo/src/content/authors/ada-lovelace.md",
              title: "Ada Lovelace",
              frontmatter: { title: "Ada Lovelace" },
            },
          ],
        },
      ]);
    },
  };
  return (
    <FieldEditor
      field={{
        name: "author",
        label: "Author",
        type: "reference",
        options: { collection: "authors" },
      }}
      path={["author"]}
      ctx={ctx}
    />
  );
}

test("creates and selects a referenced collection entry from its field label", async () => {
  mocks.invoke.mockImplementation((command: string) => {
    if (command === "list_dir_files") {
      return Promise.resolve(
        mocks.created
          ? [
              {
                name: "ada-lovelace.md",
                path: "/repo/src/content/authors/ada-lovelace.md",
                title: "Ada Lovelace",
              },
            ]
          : [],
      );
    }
    if (command === "create_text_file") {
      mocks.created = true;
      return Promise.resolve(undefined);
    }
    throw new Error(`Unexpected command: ${command}`);
  });

  render(
    <MantineProvider forceColorScheme="light">
      <Harness />
    </MantineProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Create Authors" }));
  const name = await screen.findByDisplayValue("Untitled");
  fireEvent.change(name, { target: { value: "Ada Lovelace" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => {
    const create = mocks.invoke.mock.calls.find(([command]) => command === "create_text_file");
    expect(create?.[1]).toMatchObject({
      path: "/repo/src/content/authors/ada-lovelace.md",
    });
    expect(String(create?.[1]?.content)).toContain('title: "Ada Lovelace"');
  });
  await waitFor(() => expect(mocks.refreshed).toHaveBeenCalledOnce());
  expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
});

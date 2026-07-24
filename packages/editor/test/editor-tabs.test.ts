// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import { defaultEditorTabForFile, editorTabsForFile } from "../src/components/EditorPane";

describe("editorTabsForFile", () => {
  test("shows Raw for structured files only in developer mode", () => {
    const file = {
      filePath: "/site/post.md",
      fileContent: "---\ntitle: Hello\n---\nBody",
      entry: null,
    };

    expect(editorTabsForFile({ ...file, developerMode: false })).toEqual(["content"]);
    expect(editorTabsForFile({ ...file, developerMode: true })).toEqual(["content", "raw"]);
    expect(editorTabsForFile(file)).toEqual(["content"]);
  });

  test("defaults each newly opened structured document to the visual editor", () => {
    expect(defaultEditorTabForFile("/site/post.md")).toBe("content");
    expect(
      defaultEditorTabForFile("/site/content.json", {
        collection: "posts",
        id: "first",
        path: ["first"],
        format: "json",
      }),
    ).toBe("content");
    expect(defaultEditorTabForFile("/site/styles.css")).toBe("raw");
  });

  test("keeps raw-only files editable for normal users", () => {
    expect(
      editorTabsForFile({
        filePath: "/site/styles.css",
        fileContent: "body {}",
        entry: null,
        developerMode: false,
      }),
    ).toEqual(["raw"]);
  });

  test("opens malformed Markdown frontmatter directly in raw mode for every user", () => {
    const file = {
      filePath: "/site/post.mdx",
      fileContent: "---\ntitle: [broken\n---\nBody",
      entry: null,
    };

    expect(editorTabsForFile({ ...file, developerMode: false })).toEqual(["raw"]);
    expect(editorTabsForFile({ ...file, developerMode: true })).toEqual(["raw"]);
  });
});

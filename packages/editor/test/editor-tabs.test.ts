// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import { editorTabsForFile } from "../src/components/EditorPane";

describe("editorTabsForFile", () => {
  test("shows Raw for structured files only in developer mode", () => {
    const file = {
      filePath: "/site/post.md",
      fileContent: "---\ntitle: Hello\n---\nBody",
      entry: null,
    };

    expect(editorTabsForFile({ ...file, developerMode: false })).toEqual(["fields", "body"]);
    expect(editorTabsForFile({ ...file, developerMode: true })).toEqual([
      "fields",
      "body",
      "raw",
    ]);
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
});

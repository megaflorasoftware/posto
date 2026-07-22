import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseLoaderConfig } from "../src/astro/collections";

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/content-config/${name}.txt`, import.meta.url)), "utf8");

describe("content config corpus", () => {
  test("static glob collection", () => {
    const parsed = parseLoaderConfig(fixture("basic"));
    expect(parsed.loaders.get("posts")).toMatchObject({
      kind: "glob",
      base: "./src/content/posts",
      patterns: ["**/*.md"],
    });
    expect(parsed.diagnostics).toEqual([]);
  });

  test("file loader collection", () => {
    const parsed = parseLoaderConfig(fixture("file-loader"));
    expect(parsed.loaders.get("authors")).toMatchObject({
      kind: "file",
      filePath: "src/data/authors.yaml",
    });
  });

  test("multiline globs, exclusions, references, and custom ids", () => {
    const parsed = parseLoaderConfig(fixture("references"));
    expect(parsed.loaders.get("posts")).toMatchObject({
      kind: "glob",
      base: "src/posts",
      patterns: ["**/*.md", "!drafts/**"],
      references: { author: "authors" },
    });
    expect(parsed.loaders.get("authors")?.customIds).toBe(true);
  });
});

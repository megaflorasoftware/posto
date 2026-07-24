// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { MediaLibrary, PagesConfig } from "@posto/core/pagescms/config";
import type { FileGroup } from "@posto/ipc";

const { files, invoke } = vi.hoisted(() => {
  const files = new Map<string, string>();
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "read_text_file") return files.get(args?.path as string) ?? "";
    if (command === "write_text_file") {
      files.set(args?.path as string, args?.content as string);
      return null;
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  return { files, invoke };
});

vi.mock("@posto/ipc", () => ({ invoke }));

import {
  applyImageLibraryReferenceUpdates,
  planImageLibraryReferenceUpdates,
  rewriteMarkdownImageDestinations,
} from "../src/imageLibraryReferences";

describe("image library reference updates", () => {
  beforeEach(() => {
    files.clear();
    invoke.mockClear();
  });

  test("rewrites configured frontmatter fields, collection references, and Markdown images", async () => {
    const root = "/site";
    const path = `${root}/src/content/posts/hello.md`;
    files.set(
      path,
      `---\nhero: /images/old/photo.jpg\nrelated: old/photo\n---\n![Photo](/images/old/photo.jpg)\n`,
    );
    const library: MediaLibrary = {
      collection: "images",
      base: "public/images",
      patterns: ["**/*.{yml,yaml,json}"],
      metadataExtensions: ["yml"],
      imageFieldPath: ["image"],
      fields: [],
    };
    const config: PagesConfig = {
      media: [{ name: "images", input: "public/images", output: "/images" }],
      mediaLibraries: [library],
      content: [
        {
          name: "posts",
          type: "collection",
          path: "src/content/posts",
          fields: [
            { name: "hero", type: "image" },
            {
              name: "related",
              type: "reference",
              options: { collection: "images", idScheme: "framework" },
            },
            { name: "body", type: "rich-text" },
          ],
        },
      ],
    };
    const groups: FileGroup[] = [
      { label: "posts", path: `${root}/src/content/posts`, files: [{ name: "hello.md", path }] },
    ];
    const plan = await planImageLibraryReferenceUpdates({
      root,
      config,
      groups,
      library,
      relocations: [
        {
          oldEntryId: "old/photo",
          newEntryId: "archive/photo",
          oldImagePath: `${root}/public/images/old/photo.jpg`,
          newImagePath: `${root}/public/images/archive/photo.jpg`,
        },
      ],
    });

    expect(plan.replacements).toBe(3);
    expect(plan.writes).toHaveLength(1);
    await applyImageLibraryReferenceUpdates(plan);
    expect(files.get(path)).toContain('hero: "/images/archive/photo.jpg"');
    expect(files.get(path)).toContain('related: "archive/photo"');
    expect(files.get(path)).toContain("![Photo](/images/archive/photo.jpg)");
  });

  test("does not rewrite Markdown examples in fenced code", () => {
    const result = rewriteMarkdownImageDestinations(
      "![live](/old.jpg)\n```md\n![example](/old.jpg)\n```\n",
      new Map([["/old.jpg", "/new.jpg"]]),
    );
    expect(result.replacements).toBe(1);
    expect(result.content).toBe("![live](/new.jpg)\n```md\n![example](/old.jpg)\n```\n");
  });

  test("rewrites image paths and collection IDs in data-document entries", async () => {
    const root = "/site";
    const path = `${root}/src/data/posts.yml`;
    files.set(path, "- id: first\n  hero: /images/old/photo.jpg\n  related: old/photo\n");
    const library: MediaLibrary = {
      collection: "images",
      base: "public/images",
      patterns: ["**/*.yml"],
      metadataExtensions: ["yml"],
      imageFieldPath: ["image"],
      fields: [],
    };
    const config: PagesConfig = {
      media: [{ name: "images", input: "public/images", output: "/images" }],
      mediaLibraries: [library],
      content: [
        {
          name: "posts",
          type: "collection",
          path: "src/data/posts.yml",
          dataFile: { path: "src/data/posts.yml", format: "yaml" },
          fields: [
            { name: "hero", type: "image" },
            { name: "related", type: "reference", options: { collection: "images" } },
          ],
        },
      ],
    };
    const groups: FileGroup[] = [{ label: "posts", path, files: [{ name: "first", path }] }];
    const plan = await planImageLibraryReferenceUpdates({
      root,
      config,
      groups,
      library,
      relocations: [
        {
          oldEntryId: "old/photo",
          newEntryId: "archive/photo",
          oldImagePath: `${root}/public/images/old/photo.jpg`,
          newImagePath: `${root}/public/images/archive/photo.jpg`,
        },
      ],
    });

    expect(plan.replacements).toBe(2);
    await applyImageLibraryReferenceUpdates(plan);
    expect(files.get(path)).toContain('hero: "/images/archive/photo.jpg"');
    expect(files.get(path)).toContain('related: "archive/photo"');
  });
});

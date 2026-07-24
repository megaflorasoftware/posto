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
  planMarkdownMediaReferenceUpdates,
  rewriteMarkdownImageDestinations,
  rewriteMarkdownMediaDestinations,
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

  test("plans public-media path rewrites for md and mdx files only", async () => {
    const mdPath = "/site/posts/one.md";
    const mdxPath = "/site/posts/two.mdx";
    const markdownPath = "/site/posts/three.markdown";
    files.set(
      mdPath,
      "![One](/images/old%20photo.jpg?size=2)\n[Download](/images/old%20photo.jpg)\n",
    );
    files.set(
      mdxPath,
      '<audio controls src="images/old%20photo.jpg"></audio>\n```md\n[Example](images/old%20photo.jpg)\n```\n',
    );
    files.set(markdownPath, "![Three](/images/old%20photo.jpg)\n");
    const groups: FileGroup[] = [
      {
        label: "posts",
        path: "/site/posts",
        files: [
          { name: "one.md", path: mdPath },
          { name: "two.mdx", path: mdxPath },
          { name: "three.markdown", path: markdownPath },
        ],
      },
    ];
    const plan = await planMarkdownMediaReferenceUpdates({
      groups,
      replacements: new Map([
        ["/images/old%20photo.jpg", "/images/new%20photo.jpg"],
        ["images/old%20photo.jpg", "images/new%20photo.jpg"],
      ]),
    });

    expect(plan.replacements).toBe(3);
    expect(plan.writes.map((write) => write.path)).toEqual([mdPath, mdxPath]);
    await applyImageLibraryReferenceUpdates(plan);
    expect(files.get(mdPath)).toBe(
      "![One](/images/new%20photo.jpg?size=2)\n[Download](/images/new%20photo.jpg)\n",
    );
    expect(files.get(mdxPath)).toBe(
      '<audio controls src="images/new%20photo.jpg"></audio>\n```md\n[Example](images/old%20photo.jpg)\n```\n',
    );
    expect(files.get(markdownPath)).toBe("![Three](/images/old%20photo.jpg)\n");
  });

  test("rewrites links and source attributes without touching fenced examples", () => {
    const result = rewriteMarkdownMediaDestinations(
      '[file](/old.pdf)\n<video src="/old.pdf"></video>\n```md\n[file](/old.pdf)\n```\n',
      new Map([["/old.pdf", "/new.pdf"]]),
    );

    expect(result.replacements).toBe(2);
    expect(result.content).toBe(
      '[file](/new.pdf)\n<video src="/new.pdf"></video>\n```md\n[file](/old.pdf)\n```\n',
    );
  });

  test("syncs metadata alt text to direct Markdown images in md and mdx files only", async () => {
    const root = "/site";
    const mdPath = `${root}/src/content/posts/hello.md`;
    const mdxPath = `${root}/src/content/posts/hello.mdx`;
    const markdownPath = `${root}/src/content/posts/hello.markdown`;
    files.set(
      mdPath,
      "![Old alt](/images/old/photo.jpg)\n```md\n![Example](/images/old/photo.jpg)\n```\n",
    );
    files.set(
      mdxPath,
      '![Old alt](/images/old/photo.jpg)\n<Image src="/images/old/photo.jpg" alt="Old alt" />\n',
    );
    files.set(markdownPath, "![Old alt](/images/old/photo.jpg)\n");
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
          path: "src/content/posts",
          fields: [{ name: "body", type: "rich-text" }],
        },
      ],
    };
    const groups: FileGroup[] = [
      {
        label: "posts",
        path: `${root}/src/content/posts`,
        files: [
          { name: "hello.md", path: mdPath },
          { name: "hello.mdx", path: mdxPath },
          { name: "hello.markdown", path: markdownPath },
        ],
      },
    ];

    const plan = await planImageLibraryReferenceUpdates({
      root,
      config,
      groups,
      library,
      relocations: [
        {
          oldEntryId: "old/photo",
          newEntryId: "old/photo",
          oldImagePath: `${root}/public/images/old/photo.jpg`,
          newImagePath: `${root}/public/images/old/photo.jpg`,
          newAlt: "New [alt]",
        },
      ],
    });

    expect(plan.replacements).toBe(2);
    await applyImageLibraryReferenceUpdates(plan);
    expect(files.get(mdPath)).toBe(
      "![New \\[alt\\]](/images/old/photo.jpg)\n```md\n![Example](/images/old/photo.jpg)\n```\n",
    );
    expect(files.get(mdxPath)).toBe(
      '![New \\[alt\\]](/images/old/photo.jpg)\n<Image src="/images/old/photo.jpg" alt="Old alt" />\n',
    );
    expect(files.get(markdownPath)).toBe("![Old alt](/images/old/photo.jpg)\n");

    const repeatedPlan = await planImageLibraryReferenceUpdates({
      root,
      config,
      groups,
      library,
      relocations: [
        {
          oldEntryId: "old/photo",
          newEntryId: "old/photo",
          oldImagePath: `${root}/public/images/old/photo.jpg`,
          newImagePath: `${root}/public/images/old/photo.jpg`,
          newAlt: "New [alt]",
        },
      ],
    });
    expect(repeatedPlan).toEqual({ writes: [], replacements: 0 });
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

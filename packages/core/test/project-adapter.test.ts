import { expect, test } from "vitest";
import { astroAdapter } from "../src/project/astro";
import { eleventyAdapter, genericAdapter } from "../src/project/generic";
import { invalidationScopesForPaths } from "../src/project/adapter";

test("Astro routes are adapter-owned", () => {
  expect(astroAdapter.routeForFile("/site", "/site/src/pages/about.mdx", "")).toEqual({
    route: "/about",
    certain: true,
  });
  expect(
    astroAdapter.routeForFile(
      "/site",
      "/site/src/content/posts/hello.md",
      "---\nslug: welcome\n---",
    ),
  ).toEqual({ route: "/posts/welcome", certain: false });
  expect(genericAdapter.routeForFile("/site", "/site/src/pages/about.mdx", "")).toBeNull();
});

test("Astro owns its entry id behavior", () => {
  expect(astroAdapter.capabilities.entryIds?.derive("Hello World/index.md")).toBe("hello-world");
  expect(astroAdapter.capabilities.entryIds?.derive("post.md", "custom-id")).toBe("custom-id");
  expect(genericAdapter.capabilities.entryIds).toBeNull();
});

test("Eleventy supplies a conservative markdown route", () => {
  expect(eleventyAdapter.routeForFile("/site", "/site/posts/hello.md", "")).toEqual({
    route: "/posts/hello",
    certain: false,
  });
});

test("Eleventy proves the seam without framework-only capabilities", async () => {
  expect(eleventyAdapter.capabilities).toEqual({
    mediaLibraries: false,
    dataDocuments: false,
    componentBlocks: null,
    entryIds: null,
  });
  expect(
    await eleventyAdapter.loadDerivedConfig("/site", {
      async pathExists() {
        return false;
      },
      async readTextFileOptional() {
        return null;
      },
      async listDirFilesOptional() {
        return null;
      },
    }),
  ).toBeNull();
});

test("invalidations return only affected refresh scopes", () => {
  expect(
    invalidationScopesForPaths(astroAdapter, "/site", ["/site/src/content.config.ts"]),
  ).toEqual(new Set(["derivedConfig"]));
  expect(invalidationScopesForPaths(genericAdapter, "/site", ["/site/astro.config.mjs"])).toEqual(
    new Set(["projectType"]),
  );
});

test("glob invalidations preserve recursive wildcard semantics", () => {
  const adapter = {
    ...genericAdapter,
    invalidations: () => [
      { paths: [{ glob: "/site/a/**/b/*.md" }], refresh: "derivedConfig" as const },
    ],
  };
  expect(invalidationScopesForPaths(adapter, "/site", ["/site/a/nested/deep/b/post.md"])).toEqual(
    new Set(["derivedConfig"]),
  );
  expect(invalidationScopesForPaths(adapter, "/site", ["/site/a/nested/b/post.txt"])).toEqual(
    new Set(),
  );
});

test("Astro component capabilities provide neutral refs, fields, slots, and imports", async () => {
  const source = astroAdapter.capabilities.componentBlocks!;
  const componentPath = "/site/src/components/callout.astro";
  const islandPath = "/site/components/counter.tsx";
  const io = {
    async pathExists() {
      return false;
    },
    async readTextFileOptional(path: string) {
      return path === componentPath
        ? `---\ninterface Props { title: string; count?: number; payload: Date }\n---\n<slot /><slot name="footer" />`
        : null;
    },
    async listDirFilesOptional(dir: string) {
      return dir === "/site/src/components"
        ? [{ name: "callout.astro", path: componentPath }]
        : dir === "/site/components"
          ? [{ name: "counter.tsx", path: islandPath }]
          : null;
    },
  };
  const refs = await source.listComponents("/site", io);
  expect(refs).toEqual([
    { name: "Callout", path: componentPath },
    { name: "Counter", path: islandPath },
  ]);
  expect(await source.componentFields(refs[0], io, { media: [], content: [] })).toMatchObject({
    fields: [
      {
        name: "title",
        type: "string",
        required: true,
        options: { mdxDeclaredType: "string" },
      },
      { name: "count", type: "number", options: { mdxDeclaredType: "number" } },
      {
        name: "payload",
        type: "text",
        options: { mdxRawType: "Date", mdxDeclaredType: "Date" },
      },
    ],
    slots: ["footer"],
    hasDefaultSlot: true,
  });
  expect(source.importFor(refs[0], "/site/src/content/post.mdx")).toBe(
    "import Callout from '../components/callout.astro';",
  );
  expect(await source.componentFields(refs[1], io, { media: [], content: [] })).toBeNull();

  const withoutProps = await source.componentFields(
    { name: "Empty", path: "/site/src/components/empty.astro" },
    {
      ...io,
      async readTextFileOptional() {
        return "---\nconst title = 'hello';\n---\n<div>{title}</div>";
      },
    },
  );
  expect(withoutProps?.diagnostics).toMatchObject([
    { code: "component-props-not-found", feature: "component-blocks" },
  ]);
});

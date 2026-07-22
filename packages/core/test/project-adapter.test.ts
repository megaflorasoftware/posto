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

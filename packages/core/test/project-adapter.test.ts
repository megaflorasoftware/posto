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

test("invalidations return only affected refresh scopes", () => {
  expect(
    invalidationScopesForPaths(astroAdapter, "/site", ["/site/src/content.config.ts"]),
  ).toEqual(new Set(["derivedConfig"]));
  expect(
    invalidationScopesForPaths(genericAdapter, "/site", ["/site/astro.config.mjs"]),
  ).toEqual(new Set(["projectType"]));
});

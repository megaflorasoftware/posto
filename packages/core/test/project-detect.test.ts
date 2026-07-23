import { test, expect } from "vitest";
import { detectProject, projectInfoFromMarkers, type DetectionIO } from "../src/project/detect";

function tree(files: Record<string, string | null>): DetectionIO {
  return {
    async pathExists(path, kind) {
      if (kind === "directory") {
        const prefix = `${path.replace(/\/$/, "")}/`;
        return Object.keys(files).some((candidate) => candidate.startsWith(prefix));
      }
      return Object.hasOwn(files, path);
    },
    async readTextFileOptional(path) {
      return files[path] ?? null;
    },
  };
}

test("detects frameworks in precedence order", async () => {
  const io = tree({
    "/site/package.json": JSON.stringify({ dependencies: { astro: "5", "@11ty/eleventy": "3" } }),
    "/site/eleventy.config.js": "",
  });
  expect(await detectProject("/site", io)).toMatchObject({
    type: "astro",
    signals: ["astro dependency"],
  });
});

test("detects reserved Hugo projects", async () => {
  const info = await detectProject(
    "/site",
    tree({ "/site/config.toml": "", "/site/content/post.md": "" }),
  );
  expect(info.type).toBe("hugo");
  expect(info.diagnostic).toContain("recognized but not implemented");
});

test("detects Eleventy from its config or dependency", async () => {
  expect(
    await detectProject("/site", tree({ "/site/eleventy.config.mjs": "export default {}" })),
  ).toMatchObject({ type: "eleventy", signals: ["eleventy.config.mjs"] });
  expect(
    await detectProject(
      "/site",
      tree({ "/site/package.json": '{"devDependencies":{"@11ty/eleventy":"3"}}' }),
    ),
  ).toMatchObject({ type: "eleventy", signals: ["@11ty/eleventy dependency"] });
});

test("tracks overlays on generic projects", async () => {
  const info = await detectProject(
    "/site",
    tree({ "/site/.pages.yml": "content: []", "/site/.posto/index.json": "{}" }),
  );
  expect(info).toMatchObject({ type: "generic", hasPagesYml: true, hasPostoDir: true });
});

test("tracks posto collection overlays without an index", async () => {
  const info = await detectProject(
    "/site",
    tree({ "/site/.posto/collections/posts.json": '{"displayName":"Posts"}' }),
  );
  expect(info).toMatchObject({ type: "generic", hasPostoDir: true });
  expect(projectInfoFromMarkers([".posto"])).toMatchObject({ hasPostoDir: true });
});

test("posto can override detection to any registered project type", async () => {
  const info = await detectProject(
    "/site",
    tree({
      "/site/astro.config.mjs": "",
      "/site/.posto/index.json": JSON.stringify({ project: "hugo" }),
    }),
  );
  expect(info).toMatchObject({
    type: "hugo",
    signals: ["overridden via .posto"],
    diagnostic:
      "project type 'hugo' is recognized but not implemented by this version; using generic behavior",
  });
});

test("unknown posto overrides degrade to generic", async () => {
  const info = await detectProject(
    "/site",
    tree({ "/site/.posto/index.json": JSON.stringify({ project: "jekyll" }) }),
  );
  expect(info).toMatchObject({
    type: "generic",
    diagnostic: "project type 'jekyll' is not supported by this version; treating as generic",
  });
});

const parityFixtures: {
  name: string;
  files: Record<string, string | null>;
  markers: string[];
}[] = [
  {
    name: "posto override wins",
    files: {
      "/site/.posto/index.json": JSON.stringify({ project: "hugo" }),
      "/site/astro.config.mjs": "",
    },
    markers: [".posto/index.json", "project:hugo", "astro.config.mjs"],
  },
  {
    name: "astro wins over eleventy",
    files: {
      "/site/package.json": JSON.stringify({ dependencies: { astro: "5" } }),
      "/site/eleventy.config.js": "",
    },
    markers: ["dependency:astro", "eleventy.config.js"],
  },
  {
    name: "eleventy dependency",
    files: {
      "/site/package.json": JSON.stringify({ devDependencies: { "@11ty/eleventy": "3" } }),
    },
    markers: ["dependency:@11ty/eleventy"],
  },
  {
    name: "reserved hugo layout",
    files: { "/site/config.toml": "", "/site/content/post.md": "" },
    markers: ["config.toml", "content"],
  },
  {
    name: "generic overlays",
    files: { "/site/.pages.yml": "content: []", "/site/.posto/index.json": "{}" },
    markers: [".pages.yml", ".posto/index.json"],
  },
];

test.each(parityFixtures)(
  "IO and inventory detection agree for $name",
  async ({ files, markers }) => {
    expect(await detectProject("/site", tree(files))).toEqual(projectInfoFromMarkers(markers));
  },
);

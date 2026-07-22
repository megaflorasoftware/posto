import { test, expect } from "vitest";
import { detectProject, type DetectionIO } from "../src/project/detect";

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
});

test("tracks overlays on generic projects", async () => {
  const info = await detectProject(
    "/site",
    tree({ "/site/.pages.yml": "content: []", "/site/.posto/index.json": "{}" }),
  );
  expect(info).toMatchObject({ type: "generic", hasPagesYml: true, hasPostoDir: true });
});

test("posto overrides detection and unsupported adapters degrade to generic", async () => {
  const info = await detectProject(
    "/site",
    tree({
      "/site/astro.config.mjs": "",
      "/site/.posto/index.json": JSON.stringify({ project: "hugo" }),
    }),
  );
  expect(info).toMatchObject({
    type: "generic",
    signals: ["overridden via .posto"],
    diagnostic: "project type 'hugo' is not supported by this version; treating as generic",
  });
});

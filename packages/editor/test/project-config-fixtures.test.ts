// @vitest-environment jsdom

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { act, renderHook } from "@testing-library/react";
import { detectProject } from "@posto/core/project/detect";
import { projectAdapter } from "@posto/core/project/registry";
import type { ProjectIO } from "@posto/core/project/adapter";
import { describe, expect, test } from "vitest";
import { useSchemas } from "../src/hooks/useSchemas";

const editorRoot = process.cwd().endsWith("packages/editor")
  ? process.cwd()
  : join(process.cwd(), "packages/editor");
const fixtures = join(editorRoot, "test/fixtures/effective-config");

function fixtureIO(): ProjectIO {
  return {
    async pathExists(path, kind) {
      try {
        const metadata = await stat(path);
        return kind === "file"
          ? metadata.isFile()
          : kind === "directory"
            ? metadata.isDirectory()
            : true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    async readTextFileOptional(path) {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async listDirFilesOptional(dir, extensions) {
      try {
        const entries = await readdir(dir, { recursive: true, withFileTypes: true });
        return entries
          .filter((entry) => entry.isFile())
          .map((entry) => ({ name: entry.name, path: `${entry.parentPath}/${entry.name}` }))
          .filter((entry) => extensions.some((extension) => entry.name.endsWith(`.${extension}`)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  };
}

async function loadFixture(name: string) {
  const root = `${fixtures}/${name}`;
  const io = fixtureIO();
  const project = await detectProject(root, io);
  const adapter = projectAdapter(project.type);
  const hook = renderHook(() => useSchemas(adapter, io));
  await act(async () => {
    await hook.result.current.loadSchemas(root, adapter);
  });
  return { project, config: hook.result.current.config };
}

describe("repository config fixtures", () => {
  test.each([
    ["astro-overlay", "astro", ["posts", "authors"], "uploads"],
    ["astro-derived", "astro", ["posts"], "default"],
    ["eleventy-pages", "eleventy", ["notes"], "default"],
  ])(
    "loads %s through detection and adapter orchestration",
    async (name, type, collections, media) => {
      const loaded = await loadFixture(name);
      expect({
        type: loaded.project.type,
        hasPagesYml: loaded.project.hasPagesYml,
        hasPostoDir: loaded.project.hasPostoDir,
        collections: loaded.config.content.map((entry) => entry.name),
        labels: loaded.config.content.map((entry) => entry.label ?? null),
        order: loaded.config.content.map((entry) => entry.order ?? null),
        media: loaded.config.media.map((entry) => entry.name),
      }).toEqual({
        type,
        hasPagesYml: name !== "astro-derived",
        hasPostoDir: name === "astro-overlay",
        collections,
        labels:
          name === "astro-overlay"
            ? ["Pages posts", "People"]
            : name === "astro-derived"
              ? ["Posts"]
              : collections.map(() => null),
        order: name === "astro-overlay" ? [1, 0] : collections.map(() => null),
        media: [media],
      });
    },
  );
});

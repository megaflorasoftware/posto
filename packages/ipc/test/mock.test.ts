// @vitest-environment jsdom

import { beforeAll, expect, test } from "vitest";
import { importPublicMediaFile, invoke } from "../src/index";
import { installMockBackend } from "../src/mock";
import { detectProject } from "@posto/core/project/detect";

beforeAll(() => installMockBackend());

test("directory commands share fixtures and missing-path behavior", async () => {
  await expect(
    invoke("list_dir_files", {
      dir: "/mock/site/public/images",
      extensions: ["png"],
    }),
  ).resolves.toEqual([
    {
      name: "logo.png",
      path: "/mock/site/public/images/nested/logo.png",
    },
  ]);
  await expect(
    invoke("list_dir_files_optional", {
      dir: "/mock/site/public/images",
      extensions: ["png"],
    }),
  ).resolves.toEqual([
    {
      name: "logo.png",
      path: "/mock/site/public/images/nested/logo.png",
    },
  ]);

  await expect(
    invoke("list_dir_files_optional", {
      dir: "/mock/site/.astro/collections",
      extensions: ["txt"],
    }),
  ).resolves.toEqual([]);
  await expect(
    invoke("list_dir_files_optional", {
      dir: "/mock/site/missing",
      extensions: ["txt"],
    }),
  ).resolves.toBeNull();
  await expect(
    invoke("list_dir_files", {
      dir: "/mock/site/missing",
      extensions: ["txt"],
    }),
  ).rejects.toThrow("Not a directory: /mock/site/missing");
});

test("recursive listings skip hidden entries and generated directories", async () => {
  await expect(
    invoke("list_dir_files", {
      dir: "/mock/site",
      extensions: ["txt"],
    }),
  ).resolves.toEqual([
    { name: "notes.txt", path: "/mock/site/notes.txt" },
    { name: "notes.txt", path: "/mock/site/src/layouts/notes.txt" },
  ]);

  const postoFiles = await invoke<{ path: string }[]>("list_dir_files", {
    dir: "/mock/site/.posto",
    extensions: ["json"],
  });
  expect(postoFiles.map((file) => file.path)).toEqual([
    "/mock/site/.posto/collections/blog.json",
    "/mock/site/.posto/collections/pages.json",
    "/mock/site/.posto/index.json",
  ]);
});

test("public media imports copy a file without a metadata sidecar", async () => {
  await expect(
    importPublicMediaFile({
      repositoryRoot: "/mock/site",
      sourceFilePath: "/mock/uploads/brochure.pdf",
      directory: "downloads",
    }),
  ).resolves.toBe("/mock/site/public/downloads/brochure.pdf");
  await expect(
    invoke("list_dir_files", { dir: "/mock/site/public", extensions: ["pdf"] }),
  ).resolves.toContainEqual({
    name: "brochure.pdf",
    path: "/mock/site/public/downloads/brochure.pdf",
  });
  await expect(
    invoke("list_dir_files", { dir: "/mock/site/public/downloads", extensions: ["yml"] }),
  ).resolves.toEqual([]);
});

test("path existence matches native file and directory semantics", async () => {
  await expect(
    invoke("path_exists", { path: "/mock/site/.pages.yml", kind: "file" }),
  ).resolves.toBe(true);
  await expect(
    invoke("path_exists", { path: "/mock/site/.pages.yml", kind: "directory" }),
  ).resolves.toBe(false);
  await expect(
    invoke("path_exists", { path: "/mock/site/.astro/collections", kind: "directory" }),
  ).resolves.toBe(true);
  await expect(invoke("path_exists", { path: "/mock/site/missing", kind: "file" })).resolves.toBe(
    false,
  );
  await expect(invoke("path_exists", { path: "/mock/site", kind: "socket" })).rejects.toThrow(
    "Unknown path kind: socket",
  );

  const temporary = "/mock/site/empty-after-delete/temporary.md";
  await invoke("create_text_file", { path: temporary, content: "temporary" });
  await invoke("delete_file", { path: temporary });
  await expect(invoke("path_exists", { path: temporary, kind: "file" })).resolves.toBe(false);
  await expect(
    invoke("path_exists", { path: "/mock/site/empty-after-delete", kind: "directory" }),
  ).resolves.toBe(true);
});

test("project detection runs through the installed browser backend", async () => {
  const project = await detectProject("/mock/site", {
    pathExists(path, kind) {
      return invoke<boolean>("path_exists", { path, kind });
    },
    readTextFileOptional(path) {
      return invoke<string | null>("read_text_file_optional", { path });
    },
  });
  expect(project).toMatchObject({ type: "astro", hasPagesYml: true, hasPostoDir: true });
});

test("a stale remembered work directory never falls back to the repository root", async () => {
  localStorage.setItem("posto-last-root", "/mock/site");
  localStorage.setItem("posto-work-dir:/mock/site", "/mock/site/apps/renamed");

  await expect(invoke("get_last_selection")).resolves.toEqual({
    root: "/mock/site",
    workDir: null,
  });
  await expect(invoke("get_work_dir", { root: "/mock/site" })).resolves.toBeNull();
  localStorage.removeItem("posto-last-root");
  localStorage.removeItem("posto-work-dir:/mock/site");
});

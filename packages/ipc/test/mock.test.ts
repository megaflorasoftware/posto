// @vitest-environment jsdom

import { beforeAll, expect, test } from "vitest";
import { invoke } from "../src/index";
import { installMockBackend } from "../src/mock";

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

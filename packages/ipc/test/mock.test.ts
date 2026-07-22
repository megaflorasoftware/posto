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

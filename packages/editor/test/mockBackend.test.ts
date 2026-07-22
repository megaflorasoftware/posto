// @vitest-environment jsdom

import { beforeAll, expect, test } from "vitest";
import { installMockBackend } from "@posto/ipc/mock";
import { invoke } from "@posto/ipc";

beforeAll(() => installMockBackend());

test("optional directory listing distinguishes empty matches from a missing directory", async () => {
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
});

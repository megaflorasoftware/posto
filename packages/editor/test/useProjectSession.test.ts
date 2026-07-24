// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import type { ProjectIO } from "@posto/core/project/adapter";
import { useProjectSession } from "../src/hooks/useProjectSession";

const io: ProjectIO = {
  async pathExists(path) {
    return path.endsWith("astro.config.mjs");
  },
  async readTextFileOptional() {
    return null;
  },
  async listDirFilesOptional() {
    return null;
  },
};

test("shares remembered workspace resolution and adapter activation", async () => {
  const { result } = renderHook(() =>
    useProjectSession({
      io,
      async scanProjects() {
        return [];
      },
      async getRememberedWorkDir() {
        return "/repo/apps/site";
      },
    }),
  );

  expect(await result.current.resolveRepository("/repo")).toEqual({
    kind: "open",
    workDir: "/repo/apps/site",
    automatic: true,
  });
  await act(async () => {
    await result.current.activate("/repo/apps/site");
  });
  expect(result.current.projectInfo?.type).toBe("astro");
  expect(result.current.adapter.type).toBe("astro");
});

test("shares bounded workspace decisions when no directory is remembered", async () => {
  const { result } = renderHook(() =>
    useProjectSession({
      io,
      async scanProjects() {
        return [
          { dir: "/repo", markers: ["pnpm-workspace.yaml"] },
          { dir: "/repo/apps/site", markers: ["astro.config.mjs"] },
        ];
      },
      async getRememberedWorkDir() {
        return null;
      },
    }),
  );
  expect(await result.current.resolveRepository("/repo")).toEqual({
    kind: "choose",
    candidates: [
      expect.objectContaining({ dir: "/repo", type: "generic" }),
      expect.objectContaining({ dir: "/repo/apps/site", type: "astro" }),
    ],
  });
});

test("a remembered project does not bypass the opened root picker", async () => {
  const { result } = renderHook(() =>
    useProjectSession({
      io,
      async scanProjects() {
        return [
          { dir: "/repo", markers: ["pnpm-workspace.yaml"] },
          { dir: "/repo/apps/site", markers: ["astro.config.mjs"] },
        ];
      },
      async getRememberedWorkDir() {
        return "/repo/apps/site";
      },
    }),
  );
  expect((await result.current.resolveRepository("/repo")).kind).toBe("choose");
});

test("preparing an activation does not commit it before the caller accepts it", async () => {
  const { result } = renderHook(() =>
    useProjectSession({
      io,
      async scanProjects() {
        return [];
      },
      async getRememberedWorkDir() {
        return null;
      },
    }),
  );

  const activation = await result.current.prepare("/repo/apps/site");
  expect(result.current.projectInfo).toBeNull();
  act(() => result.current.commit(activation));
  expect(result.current.projectInfo?.type).toBe("astro");
});

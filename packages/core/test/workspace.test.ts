import { expect, test } from "vitest";
import {
  decideWorkspace,
  scanWorkspace,
  workspaceLayoutChanged,
  workspaceProjects,
} from "../src/project/workspace";

test("offers the opened root alongside a single nested project", async () => {
  const scan = await scanWorkspace("/repo", [
    { dir: "/repo", markers: ["pnpm-workspace.yaml"] },
    { dir: "/repo/apps/docs", markers: ["package.json", "dependency:astro"] },
  ]);
  expect(decideWorkspace("/repo", scan)).toEqual({
    kind: "choose",
    candidates: [
      expect.objectContaining({ dir: "/repo", type: "generic" }),
      expect.objectContaining({ dir: "/repo/apps/docs", type: "astro" }),
    ],
  });
});

test("a configured root still offers another configured nested project", async () => {
  const scan = await scanWorkspace("/repo", [
    { dir: "/repo", markers: ["package.json", "pnpm-workspace.yaml", "dependency:astro"] },
    { dir: "/repo/apps/docs", markers: ["package.json", "dependency:astro"] },
  ]);
  expect(decideWorkspace("/repo", scan)).toEqual({
    kind: "choose",
    candidates: [
      expect.objectContaining({ dir: "/repo", type: "astro" }),
      expect.objectContaining({ dir: "/repo/apps/docs", type: "astro" }),
    ],
  });
});

test("switchable directories include a generic opened root", async () => {
  const scan = await scanWorkspace("/repo", [
    { dir: "/repo", markers: ["pnpm-workspace.yaml"] },
    { dir: "/repo/apps/docs", markers: ["package.json", "dependency:astro"] },
  ]);
  expect(workspaceProjects("/repo", scan).map((project) => project.dir)).toEqual([
    "/repo",
    "/repo/apps/docs",
  ]);
});

test("switchable projects include a framework repository root", async () => {
  const scan = await scanWorkspace("/repo", [
    { dir: "/repo", markers: ["package.json", "dependency:astro"] },
    { dir: "/repo/apps/docs", markers: ["package.json", "dependency:astro"] },
  ]);
  expect(workspaceProjects("/repo", scan).map((project) => project.dir)).toEqual([
    "/repo",
    "/repo/apps/docs",
  ]);
});

test("workspace classification uses the canonical posto parser", async () => {
  const scan = await scanWorkspace("/repo", [
    {
      dir: "/repo",
      markers: [".posto/index.json", "astro.config.mjs"],
      postoIndex: JSON.stringify({ project: "hugo" }),
    },
  ]);
  expect(scan.root).toMatchObject({ type: "hugo", signals: ["overridden via .posto"] });
});

test("a directly opened configured project has no picker without nested projects", async () => {
  const scan = await scanWorkspace("/repo/apps/docs", [
    { dir: "/repo/apps/docs", markers: ["package.json", "dependency:astro"] },
  ]);
  expect(decideWorkspace("/repo/apps/docs", scan)).toEqual({
    kind: "open",
    workDir: "/repo/apps/docs",
    automatic: false,
  });
});

test("a workspace manifest alone does not create a project picker", async () => {
  const scan = await scanWorkspace("/repo", [{ dir: "/repo", markers: ["pnpm-workspace.yaml"] }]);
  expect(decideWorkspace("/repo", scan)).toEqual({
    kind: "open",
    workDir: "/repo",
    automatic: false,
  });
});

test("workspace manifests never invalidate a single-project session", () => {
  expect(workspaceLayoutChanged("/repo", "/repo", ["/repo/package.json"])).toBe(false);
  expect(workspaceLayoutChanged("/repo", "/repo/apps/site", ["/repo/pnpm-workspace.yaml"])).toBe(
    true,
  );
  expect(workspaceLayoutChanged("/repo", "/repo/apps/site", ["/repo/apps/site/package.json"])).toBe(
    false,
  );
  expect(
    workspaceLayoutChanged("/repo", "/repo/apps/site", ["/repo/apps/new-site/astro.config.mjs"]),
  ).toBe(true);
});

import { expect, test } from "vitest";
import { decideWorkspace, scanWorkspace, workspaceLayoutChanged } from "../src/project/workspace";

test("automatically selects the only nested project", async () => {
  const scan = await scanWorkspace("/repo", [
    { dir: "/repo", markers: ["pnpm-workspace.yaml"] },
    { dir: "/repo/apps/docs", markers: ["package.json", "dependency:astro"] },
  ]);
  expect(decideWorkspace("/repo", scan)).toEqual({
    kind: "open",
    workDir: "/repo/apps/docs",
    automatic: true,
  });
});

test("a framework root wins over nested candidates", async () => {
  const scan = await scanWorkspace("/repo", [
    { dir: "/repo", markers: ["package.json", "pnpm-workspace.yaml", "dependency:astro"] },
    { dir: "/repo/apps/docs", markers: ["package.json", "dependency:astro"] },
  ]);
  expect(decideWorkspace("/repo", scan)).toEqual({
    kind: "open",
    workDir: "/repo",
    automatic: false,
  });
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

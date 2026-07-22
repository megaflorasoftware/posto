import { expect, test } from "vitest";
import type { DetectionIO } from "../src/project/detect";
import { decideWorkspace, scanWorkspace } from "../src/project/workspace";

const files: Record<string, string> = {
  "/repo/pnpm-workspace.yaml": "packages: [apps/*]",
  "/repo/apps/docs/package.json": '{"dependencies":{"astro":"5"}}',
};
const io: DetectionIO = {
  async pathExists(path, kind) {
    if (kind === "directory") return Object.keys(files).some((file) => file.startsWith(`${path}/`));
    return path in files;
  },
  async readTextFileOptional(path) {
    return files[path] ?? null;
  },
};

test("automatically selects the only nested project", async () => {
  const scan = await scanWorkspace(
    "/repo",
    [
      { dir: "/repo", markers: ["pnpm-workspace.yaml"] },
      { dir: "/repo/apps/docs", markers: ["package.json"] },
    ],
    io,
  );
  expect(decideWorkspace("/repo", scan)).toEqual({
    kind: "open",
    workDir: "/repo/apps/docs",
    automatic: true,
  });
});

test("a framework root wins over nested candidates", async () => {
  files["/repo/package.json"] = '{"dependencies":{"astro":"5"}}';
  const scan = await scanWorkspace(
    "/repo",
    [
      { dir: "/repo", markers: ["package.json", "pnpm-workspace.yaml"] },
      { dir: "/repo/apps/docs", markers: ["package.json"] },
    ],
    io,
  );
  expect(decideWorkspace("/repo", scan)).toEqual({
    kind: "open",
    workDir: "/repo",
    automatic: false,
  });
  delete files["/repo/package.json"];
});

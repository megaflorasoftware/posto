import { detectProject, type DetectionIO, type ProjectInfo } from "./detect";

export interface ProjectInventory {
  dir: string;
  markers: string[];
}

export interface ProjectCandidate extends ProjectInfo {
  dir: string;
}

export interface WorkspaceScan {
  root: ProjectInfo;
  candidates: ProjectCandidate[];
  hasWorkspaceManifest: boolean;
}

const WORKSPACE_LAYOUT_FILES = [
  "package.json",
  "pnpm-workspace.yaml",
  "lerna.json",
  "turbo.json",
] as const;

/** Whether a changed path can alter the workspace layout outside the active project. */
export function workspaceLayoutChanged(
  repoRoot: string,
  workDir: string,
  paths: string[],
): boolean {
  if (repoRoot === workDir) return false;
  return paths.some((path) =>
    WORKSPACE_LAYOUT_FILES.some((marker) => path === `${repoRoot}/${marker}`),
  );
}

const WORKSPACE_MARKERS = new Set([
  "pnpm-workspace.yaml",
  "lerna.json",
  "turbo.json",
  "package.json#workspaces",
]);

/** Classifies a bounded backend marker inventory using the canonical detector. */
export async function scanWorkspace(
  root: string,
  inventory: ProjectInventory[],
  io: DetectionIO,
): Promise<WorkspaceScan> {
  const rootInfo = await detectProject(root, io);
  const candidates: ProjectCandidate[] = [];
  for (const item of inventory) {
    if (item.dir === root) continue;
    const info = await detectProject(item.dir, io);
    if (info.type !== "generic" || info.hasPagesYml) candidates.push({ dir: item.dir, ...info });
  }
  candidates.sort((a, b) => a.dir.localeCompare(b.dir));
  return {
    root: rootInfo,
    candidates,
    hasWorkspaceManifest: inventory.some((item) =>
      item.markers.some((marker) => WORKSPACE_MARKERS.has(marker)),
    ),
  };
}

export type WorkspaceDecision =
  | { kind: "open"; workDir: string; automatic: boolean }
  | { kind: "choose"; candidates: ProjectCandidate[] };

export function decideWorkspace(root: string, scan: WorkspaceScan): WorkspaceDecision {
  if (scan.root.type !== "generic") return { kind: "open", workDir: root, automatic: false };
  if (scan.candidates.length === 1) {
    return { kind: "open", workDir: scan.candidates[0].dir, automatic: true };
  }
  if (scan.candidates.length >= 2 || scan.hasWorkspaceManifest) {
    return { kind: "choose", candidates: scan.candidates };
  }
  return { kind: "open", workDir: root, automatic: false };
}

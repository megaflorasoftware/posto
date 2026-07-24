import { projectInfoFromMarkers, type ProjectInfo } from "./detect";
import { PROJECT_MARKERS } from "./detect";
import { parsePostoIndex } from "../posto/config";

export interface ProjectInventory {
  dir: string;
  markers: string[];
  postoIndex?: string;
}

export interface ProjectCandidate extends ProjectInfo {
  dir: string;
}

export interface WorkspaceScan {
  root: ProjectInfo;
  candidates: ProjectCandidate[];
  hasWorkspaceManifest: boolean;
}

/** Directories available from the context the user opened. The opened root
 * remains an explicit option even when it is only a generic container. */
export function workspaceProjects(root: string, scan: WorkspaceScan): ProjectCandidate[] {
  return [{ dir: root, ...scan.root }, ...scan.candidates];
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
  return paths.some((path) => {
    if (!path.startsWith(`${repoRoot}/`) || path.startsWith(`${workDir}/`)) return false;
    const relative = path.slice(repoRoot.length + 1);
    if (WORKSPACE_LAYOUT_FILES.some((marker) => relative === marker)) return true;
    return PROJECT_MARKERS.some(
      (marker) => relative === marker.path || relative.endsWith(`/${marker.path}`),
    );
  });
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
): Promise<WorkspaceScan> {
  const classify = (item: ProjectInventory | undefined) => {
    const project = item?.postoIndex ? parsePostoIndex(item.postoIndex).project : undefined;
    return projectInfoFromMarkers([
      ...(item?.markers ?? []),
      ...(project ? [`project:${project}`] : []),
    ]);
  };
  const rootInfo = classify(inventory.find((item) => item.dir === root));
  const candidates: ProjectCandidate[] = [];
  for (const item of inventory) {
    if (item.dir === root) continue;
    const info = classify(item);
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
  if (scan.candidates.length > 0) {
    return { kind: "choose", candidates: workspaceProjects(root, scan) };
  }
  return { kind: "open", workDir: root, automatic: false };
}

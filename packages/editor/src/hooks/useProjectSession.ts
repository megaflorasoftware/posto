import { useMemo, useState } from "react";
import type { PagesConfig } from "@posto/core/pagescms/config";
import {
  invalidationScopesForPaths,
  type ProjectAdapter,
  type ProjectIO,
} from "@posto/core/project/adapter";
import { detectProject, type ProjectInfo } from "@posto/core/project/detect";
import { projectAdapter } from "@posto/core/project/registry";
import {
  decideWorkspace,
  scanWorkspace,
  type ProjectInventory,
  type WorkspaceDecision,
  type WorkspaceScan,
} from "@posto/core/project/workspace";

export function useProjectSession(services: {
  io: ProjectIO;
  scanProjects: (root: string) => Promise<ProjectInventory[]>;
  getRememberedWorkDir: (root: string) => Promise<string | null>;
}) {
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const adapter = useMemo(() => projectAdapter(projectInfo?.type ?? "generic"), [projectInfo]);

  async function inspect(dir: string): Promise<ProjectInfo> {
    return detectProject(dir, services.io);
  }

  async function prepare(dir: string): Promise<{ info: ProjectInfo; adapter: ProjectAdapter }> {
    const info = await inspect(dir);
    return { info, adapter: projectAdapter(info.type) };
  }

  function commit(activation: { info: ProjectInfo }) {
    setProjectInfo(activation.info);
  }

  async function activate(dir: string): Promise<{ info: ProjectInfo; adapter: ProjectAdapter }> {
    const activation = await prepare(dir);
    commit(activation);
    return activation;
  }

  function clear() {
    setProjectInfo(null);
  }

  async function scanRepository(root: string): Promise<WorkspaceScan> {
    return scanWorkspace(root, await services.scanProjects(root));
  }

  async function resolveRepository(root: string): Promise<WorkspaceDecision> {
    const remembered = await services.getRememberedWorkDir(root);
    if (remembered) return { kind: "open", workDir: remembered, automatic: true };
    return decideWorkspace(root, await scanRepository(root));
  }

  function invalidations(root: string, paths: string[], config?: PagesConfig | null) {
    return invalidationScopesForPaths(adapter, root, paths, config);
  }

  return {
    projectInfo,
    adapter,
    inspect,
    prepare,
    commit,
    activate,
    setProjectInfo,
    clear,
    scanRepository,
    resolveRepository,
    invalidations,
  };
}

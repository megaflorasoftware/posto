import type { ProjectAdapter } from "./adapter";
import type { ProjectType } from "./detect";

const adapters = new Map<ProjectType, ProjectAdapter>();

export function registerProjectAdapter(adapter: ProjectAdapter): void {
  adapters.set(adapter.type, adapter);
}

export function projectAdapter(type: ProjectType): ProjectAdapter {
  return adapters.get(type) ?? adapters.get("generic")!;
}

import type { ProjectAdapter } from "./adapter";
import type { ProjectType } from "./detect";
import { astroAdapter } from "./astro";
import { eleventyAdapter, genericAdapter, hugoAdapter } from "./generic";

const adapters = new Map<ProjectType, ProjectAdapter>(
  [astroAdapter, eleventyAdapter, hugoAdapter, genericAdapter].map((adapter) => [
    adapter.type,
    adapter,
  ]),
);

export function registerProjectAdapter(adapter: ProjectAdapter): void {
  adapters.set(adapter.type, adapter);
}

export function projectAdapter(type: ProjectType): ProjectAdapter {
  return adapters.get(type) ?? genericAdapter;
}

import type { ProjectType } from "./detect";

/** Project types with behavior beyond the generic fallback in this release. */
export const IMPLEMENTED_PROJECT_TYPES: readonly ProjectType[] = ["astro", "eleventy", "generic"];

export function projectTypeImplemented(type: ProjectType): boolean {
  return IMPLEMENTED_PROJECT_TYPES.includes(type);
}

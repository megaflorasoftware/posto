import { useRef, useState } from "react";
import { invoke } from "@posto/ipc";
import type { FileGroup } from "@posto/ipc";
import { parseFile } from "@posto/core/pagescms/frontmatter";

// Sidebar labels and sort keys come from frontmatter; keep them in sync when
// a save changes it (list_files only runs on directory selection).
function sidebarFrontmatter(path: string, content: string): Record<string, string> | null {
  if (!/\.(md|mdx|markdown)$/i.test(path)) return null;
  const parsed = parseFile(content);
  if (parsed.error) return null;
  const values = parsed.doc.toJSON() as unknown;
  if (!values || typeof values !== "object" || Array.isArray(values)) return null;
  // Scalars only, matching what the backend's line-based scan surfaces.
  const pairs: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string" && value.trim() !== "") pairs[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") pairs[key] = String(value);
  }
  return Object.keys(pairs).length > 0 ? pairs : null;
}

function sidebarTitle(frontmatter: Record<string, string> | null): string | null {
  return frontmatter?.title ?? frontmatter?.name ?? null;
}

/** The sidebar's file groups for the selected root. */
export function useFileGroups(onError: (message: string) => void) {
  const [groups, setGroups] = useState<FileGroup[]>([]);
  // Latest value for callbacks that outlive the render they were created in.
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  async function refreshGroups(dir: string) {
    try {
      const listed = await invoke<FileGroup[]>("list_files", { root: dir });
      setGroups(listed);
      groupsRef.current = listed;
    } catch (e) {
      setGroups([]);
      onError(String(e));
    }
  }

  function updateSidebarTitle(path: string, content: string) {
    const frontmatter = sidebarFrontmatter(path, content);
    const title = sidebarTitle(frontmatter);
    setGroups((current) =>
      current.map((group) =>
        group.files.some((file) => file.path === path)
          ? {
              ...group,
              files: group.files.map((file) =>
                file.path === path ? { ...file, title, frontmatter } : file,
              ),
            }
          : group,
      ),
    );
  }

  return { groups, groupsRef, refreshGroups, updateSidebarTitle };
}

import { useRef, useState } from "react";
import { invoke } from "../ipc";
import type { FileGroup } from "../ipc";
import { parseFile } from "../pagescms/frontmatter";

// Sidebar labels come from frontmatter titles; keep them in sync when a
// save changes the title (list_files only runs on directory selection).
function sidebarTitle(path: string, content: string): string | null {
  if (!/\.(md|mdx|markdown)$/i.test(path)) return null;
  const parsed = parseFile(content);
  if (parsed.error) return null;
  const value = parsed.doc.get("title") ?? parsed.doc.get("name");
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number") return String(value);
  return null;
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
    const title = sidebarTitle(path, content);
    setGroups((current) =>
      current.map((group) =>
        group.files.some((file) => file.path === path)
          ? {
              ...group,
              files: group.files.map((file) =>
                file.path === path && file.title !== title ? { ...file, title } : file,
              ),
            }
          : group,
      ),
    );
  }

  return { groups, groupsRef, refreshGroups, updateSidebarTitle };
}

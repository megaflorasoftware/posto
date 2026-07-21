import { useRef, useState } from "react";
import { invoke } from "@posto/ipc";
import type { FileGroup } from "@posto/ipc";
import { parseFile } from "@posto/core/pagescms/frontmatter";
import type { PagesConfig } from "@posto/core/pagescms/config";
import {
  dataDocumentEntries,
  dataEntryValues,
  parseDataDocument,
} from "@posto/core/astro/dataDocument";

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
  const physicalGroups = useRef<FileGroup[]>([]);
  const dataGroups = useRef<FileGroup[]>([]);

  function commitGroups() {
    const next = [...physicalGroups.current, ...dataGroups.current];
    setGroups(next);
    groupsRef.current = next;
  }

  async function refreshGroups(dir: string) {
    try {
      const listed = await invoke<FileGroup[]>("list_files", { root: dir });
      physicalGroups.current = listed;
      commitGroups();
    } catch (e) {
      physicalGroups.current = [];
      commitGroups();
      onError(String(e));
    }
  }

  /** Builds synthetic sidebar entries for Astro file-loader collections. */
  async function refreshDataGroups(dir: string, config: PagesConfig | null) {
    const next: FileGroup[] = [];
    for (const collection of config?.content ?? []) {
      if (!collection.dataFile) continue;
      const dataFile = collection.dataFile;
      const path = `${dir}/${dataFile.path}`;
      try {
        const parsed = parseDataDocument(
          await invoke<string>("read_text_file", { path }),
          dataFile.format,
        );
        if (parsed.error) continue;
        const files = dataDocumentEntries(parsed).flatMap((locator) => {
          const values = dataEntryValues(parsed, locator);
          if (!values) return [];
          const frontmatter: Record<string, string> = {};
          for (const [key, value] of Object.entries(values)) {
            if (
              typeof value === "string" ||
              typeof value === "number" ||
              typeof value === "boolean"
            ) {
              frontmatter[key] = String(value);
            }
          }
          return [
            {
              name: locator.id,
              path,
              key: `${path}#${collection.name}:${locator.path.join(".")}`,
              title:
                typeof values.title === "string"
                  ? values.title
                  : typeof values.name === "string"
                    ? values.name
                    : locator.id,
              frontmatter,
              dataEntry: {
                collection: collection.name,
                id: locator.id,
                path: locator.path,
                format: dataFile.format,
              },
            },
          ];
        });
        next.push({
          label: collection.label ?? collection.name,
          path,
          kind: "data",
          dataCollection: collection.name,
          files,
        });
      } catch {
        // Missing/unreadable backing files do not hide ordinary file groups.
      }
    }
    dataGroups.current = next;
    commitGroups();
  }

  function updateSidebarTitle(path: string, content: string) {
    const frontmatter = sidebarFrontmatter(path, content);
    const title = sidebarTitle(frontmatter);
    setGroups((current) =>
      current.map((group) =>
        group.kind === "data"
          ? group
          : group.files.some((file) => file.path === path)
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

  return { groups, groupsRef, refreshGroups, refreshDataGroups, updateSidebarTitle };
}

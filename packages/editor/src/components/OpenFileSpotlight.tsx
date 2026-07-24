import { useEffect, useMemo } from "react";
import { Spotlight, spotlight } from "@mantine/spotlight";
import { FileText } from "lucide-react";
import type { FileEntry, FileGroup } from "@posto/ipc";
import type { PagesConfig } from "@posto/core/pagescms/config";
import { sidebarDisplayGroups } from "./Sidebar";

/**
 * Search palette containing exactly the entries shown in the sidebar, in the
 * same collection-aware display order.
 */
export function OpenFileSpotlight(props: {
  root: string;
  groups: FileGroup[];
  config: PagesConfig | null;
  onClose: () => void;
  onOpen: (file: FileEntry) => void;
}) {
  useEffect(() => {
    spotlight.open();
  }, []);

  const actions = useMemo(
    () =>
      sidebarDisplayGroups(props.groups, props.config, props.root).flatMap(
        ({ group }, groupIndex) =>
          group.files.map((file, fileIndex) => {
            const relativePath = file.path.startsWith(`${props.root}/`)
              ? file.path.slice(props.root.length + 1)
              : file.path;
            const groupLabel = group.label || "Project";
            return {
              id: `${groupIndex}:${fileIndex}:${file.key ?? file.path}`,
              label: file.title ?? file.name,
              description: `${groupLabel} · ${relativePath}`,
              leftSection: <FileText size={16} />,
              onClick: () => props.onOpen(file),
            };
          }),
      ),
    [props.config, props.groups, props.root, props.onOpen],
  );

  return (
    <Spotlight
      shortcut={null}
      actions={actions}
      highlightQuery
      onSpotlightClose={props.onClose}
      searchProps={{
        placeholder: "Open a file…",
        "aria-label": "Search recognized files",
      }}
      nothingFound="No recognized files found"
    />
  );
}

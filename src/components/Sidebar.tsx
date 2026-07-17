import { useMemo } from "react";
import { ChevronDown, Plus } from "lucide-react";
import type { FileEntry, FileGroup } from "../ipc";
import { matchCollectionForDir, type PagesConfig } from "../pagescms/config";
import { FileList } from "./FileList";

export function Sidebar(props: {
  root: string;
  groups: FileGroup[];
  config: PagesConfig | null;
  activePath: string | null;
  onOpen: (path: string) => void;
  onDelete: (file: FileEntry) => void;
  onNewFile: (group: FileGroup) => void;
}) {
  const { root, groups, config } = props;

  // Sidebar groups: loose root files stay at the very top, then groups whose
  // directory belongs to a defined collection — taking that collection's
  // label and sorting alphabetically regardless of schema source — and plain
  // directory groups follow in backend order.
  const displayGroups = useMemo(() => {
    if (!config) return groups;
    return groups
      .map((group, original) => {
        if (group.kind === "styles") {
          return { group, tier: 3, collectionLabel: "", exact: false, original };
        }
        const collection = group.label ? matchCollectionForDir(config, root, group.path) : null;
        const exact = collection !== null && group.path === root + "/" + collection.path;
        return {
          // Subfolder groups of a collection sort with it but keep their
          // directory label, so nested dirs stay distinguishable.
          group: exact ? { ...group, label: collection.label ?? collection.name } : group,
          tier: !group.label ? 0 : collection ? 1 : 2,
          collectionLabel: collection ? (collection.label ?? collection.name) : "",
          exact,
          original,
        };
      })
      .sort(
        (a, b) =>
          a.tier - b.tier ||
          a.collectionLabel.localeCompare(b.collectionLabel, undefined, {
            sensitivity: "base",
          }) ||
          Number(b.exact) - Number(a.exact) ||
          a.original - b.original,
      )
      .map((d) => d.group);
  }, [groups, config, root]);

  return (
    <aside className="sidebar">
      {displayGroups.map((group) =>
        group.label ? (
          // The synthetic Styles group shares its path with the root
          // group, so the key needs the kind to stay unique.
          <details key={`${group.kind ?? ""}:${group.path}`} open>
            <summary>
              <span className="group-label" title={group.label}>
                {group.label}
              </span>
              {group.kind !== "styles" && (
                <button
                  type="button"
                  className="group-action"
                  title="New file"
                  aria-label={`New file in ${group.label}`}
                  onClick={(e) => {
                    // A click inside <summary> would also toggle the group.
                    e.preventDefault();
                    e.stopPropagation();
                    props.onNewFile(group);
                  }}
                >
                  <Plus size={14} />
                </button>
              )}
              <ChevronDown size={14} className="group-chevron" />
            </summary>
            <FileList
              files={group.files}
              activePath={props.activePath}
              onOpen={props.onOpen}
              onDelete={props.onDelete}
            />
          </details>
        ) : (
          <FileList
            key={group.path}
            files={group.files}
            activePath={props.activePath}
            onOpen={props.onOpen}
            onDelete={props.onDelete}
          />
        ),
      )}
    </aside>
  );
}

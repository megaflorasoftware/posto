import { useEffect, useMemo, useState } from "react";
import { Popover, Stack, Text } from "@mantine/core";
import { ChevronDown, Plus, SlidersHorizontal, TriangleAlert } from "lucide-react";
import type { FileEntry, FileGroup } from "@posto/ipc";
import {
  matchCollectionForDir,
  type ContentEntry,
  type PagesConfig,
} from "@posto/core/pagescms/config";
import { applyCollectionPrefs } from "../collectionPrefs";
import { CollectionOrderDialog } from "./CollectionOrderDialog";
import { CollectionSettingsDialog } from "./CollectionSettingsDialog";
import { FileList } from "./FileList";

export interface DisplayGroup {
  group: FileGroup;
  /** Collection the group's directory belongs to, when one is defined. */
  collection: ContentEntry | null;
  /** True when the group is the collection's own folder (not a subfolder);
   * only these carry the collection's label and settings button. */
  exact: boolean;
}

export interface DisplayGroupNode extends DisplayGroup {
  /** Nested directories inferred from the flat groups returned by the backend. */
  children: DisplayGroupNode[];
  /** Zero for sidebar roots; used to open only top-level directories by default. */
  depth: number;
  defaultOpen: boolean;
}

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function joinedPath(parent: string, child: string): string {
  return `${normalizedPath(parent)}/${child.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")}`;
}

function relativePath(parent: string, child: string): string | null {
  const normalizedParent = normalizedPath(parent);
  const normalizedChild = normalizedPath(child);
  if (normalizedChild === normalizedParent) return "";
  const prefix = `${normalizedParent}/`;
  return normalizedChild.startsWith(prefix) ? normalizedChild.slice(prefix.length) : null;
}

function displayNode(
  display: DisplayGroup,
  depth: number,
  label = display.group.label,
): DisplayGroupNode {
  return {
    ...display,
    group: label === display.group.label ? display.group : { ...display.group, label },
    children: [],
    depth,
    defaultOpen: depth === 0,
  };
}

function inferredDirectory(
  path: string,
  label: string,
  collection: ContentEntry | null,
  exact: boolean,
  depth: number,
): DisplayGroupNode {
  return displayNode(
    {
      group: { label, path, files: [] },
      collection,
      exact,
    },
    depth,
  );
}

/** Public media is managed through the media library, not the text-file
 * creation flow exposed by sidebar collection groups. */
export function canCreateFileInGroup(root: string, group: FileGroup): boolean {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedGroup = group.path.replace(/\\/g, "/").replace(/\/+$/, "");
  return group.kind !== "styles" && normalizedGroup !== `${normalizedRoot}/public`;
}

/**
 * Groups in display order with collection settings applied: loose root files
 * stay at the very top, then groups whose directory belongs to a defined
 * collection — taking that collection's label and sorting by `.posto`
 * collection order, then alphabetically, regardless of schema source — and
 * plain directory groups follow in backend order. Shared with the mobile
 * file list, which renders groups without this component.
 */
export function sidebarDisplayGroups(
  groups: FileGroup[],
  config: PagesConfig | null,
  root: string,
): DisplayGroup[] {
  if (!config) return groups.map((group) => ({ group, collection: null, exact: false }));
  return groups
    .map((group, original) => {
      if (group.kind === "styles") {
        return {
          display: { group, collection: null, exact: false },
          tier: 3,
          order: Infinity,
          collectionLabel: "",
          exact: false,
          original,
        };
      }
      const collection = group.label ? matchCollectionForDir(config, root, group.path) : null;
      const exact =
        collection !== null &&
        normalizedPath(group.path) === normalizedPath(joinedPath(root, collection.path));
      const withPrefs = collection
        ? { ...group, files: applyCollectionPrefs(group.files, collection) }
        : group;
      return {
        // Subfolder groups of a collection sort with it but keep their
        // directory label, so nested dirs stay distinguishable.
        display: {
          group: exact ? { ...withPrefs, label: collection.label ?? collection.name } : withPrefs,
          collection,
          exact,
        },
        tier: !group.label ? 0 : collection ? 1 : 2,
        order: collection?.order ?? Infinity,
        collectionLabel: collection ? (collection.label ?? collection.name) : "",
        exact,
        original,
      };
    })
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        a.order - b.order ||
        a.collectionLabel.localeCompare(b.collectionLabel, undefined, {
          sensitivity: "base",
        }) ||
        Number(b.exact) - Number(a.exact) ||
        a.original - b.original,
    )
    .map((d) => d.display);
}

/**
 * Turns the backend's flat list of file-containing directories into a tree.
 * Collection roots are sidebar roots even when their on-disk path is nested,
 * while ordinary folders are rooted at their first directory below `root`.
 * Missing intermediate directories are inferred so a folder that only holds
 * subdirectories remains navigable.
 */
export function sidebarDisplayTree(
  groups: FileGroup[],
  config: PagesConfig | null,
  root: string,
): DisplayGroupNode[] {
  const roots: DisplayGroupNode[] = [];
  const rootsByKey = new Map<string, DisplayGroupNode>();

  for (const display of sidebarDisplayGroups(groups, config, root)) {
    const { group, collection } = display;
    // Loose root files and synthetic groups (Styles and data-document
    // collections) are already complete top-level sections.
    if (!group.label || group.kind) {
      roots.push(displayNode(display, 0));
      continue;
    }

    const groupPath = normalizedPath(group.path);
    const collectionRoot = collection ? joinedPath(root, collection.path) : null;
    const fromRoot = relativePath(root, groupPath);
    const fromCollection = collectionRoot ? relativePath(collectionRoot, groupPath) : null;
    if (fromRoot === null || (collectionRoot && fromCollection === null)) {
      roots.push(displayNode(display, 0));
      continue;
    }

    const relative = collectionRoot ? fromCollection! : fromRoot;
    const segments = relative.split("/").filter(Boolean);
    const rootSegment = collectionRoot ? null : segments.shift();
    const treeRootPath = collectionRoot ?? joinedPath(root, rootSegment!);
    const rootKey = collection
      ? `collection:${collection.name}:${normalizedPath(collection.path)}`
      : `folder:${normalizedPath(treeRootPath)}`;
    let treeRoot = rootsByKey.get(rootKey);

    if (!treeRoot) {
      const groupIsRoot = groupPath === normalizedPath(treeRootPath);
      treeRoot = groupIsRoot
        ? displayNode(display, 0, collection ? group.label : rootSegment!)
        : inferredDirectory(
            treeRootPath,
            collection ? (collection.label ?? collection.name) : rootSegment!,
            collection,
            collection !== null,
            0,
          );
      rootsByKey.set(rootKey, treeRoot);
      roots.push(treeRoot);
    } else if (groupPath === normalizedPath(treeRootPath)) {
      // A descendant may have caused an inferred root to be created first.
      const replacement = displayNode(display, 0, collection ? group.label : rootSegment!);
      treeRoot.group = replacement.group;
      treeRoot.collection = replacement.collection;
      treeRoot.exact = replacement.exact;
    }

    if (groupPath === normalizedPath(treeRootPath)) continue;

    let parent = treeRoot;
    let currentPath = normalizedPath(treeRootPath);
    for (const [index, segment] of segments.entries()) {
      currentPath = joinedPath(currentPath, segment);
      const final = index === segments.length - 1;
      let child = parent.children.find(
        (candidate) => normalizedPath(candidate.group.path) === normalizedPath(currentPath),
      );
      if (!child) {
        child = final
          ? displayNode(display, parent.depth + 1, segment)
          : inferredDirectory(currentPath, segment, collection, false, parent.depth + 1);
        parent.children.push(child);
      } else if (final) {
        const replacement = displayNode(display, child.depth, segment);
        child.group = replacement.group;
        child.collection = replacement.collection;
        child.exact = replacement.exact;
      }
      parent = child;
    }
  }

  return roots;
}

/**
 * Collections eligible for the order dialog, unique by name in current
 * display order. Derived from the config (not the visible groups) so
 * collections whose folder is currently empty still appear.
 */
export function orderableCollections(config: PagesConfig | null): ContentEntry[] {
  if (!config) return [];
  const seen = new Set<string>();
  return config.content
    .filter((entry) => {
      if (entry.type !== "collection" || seen.has(entry.name)) return false;
      seen.add(entry.name);
      return true;
    })
    .sort(
      (a, b) =>
        (a.order ?? Infinity) - (b.order ?? Infinity) ||
        (a.label ?? a.name).localeCompare(b.label ?? b.name, undefined, { sensitivity: "base" }),
    );
}

export function SchemaDiagnostics({ config }: { config: PagesConfig | null }) {
  const diagnostics = config?.diagnostics ?? [];
  if (diagnostics.length === 0) return null;
  const label = `${diagnostics.length} schema ${diagnostics.length === 1 ? "notice" : "notices"}`;
  return (
    <Popover position="right-end" width={340} shadow="md" withArrow>
      <Popover.Target>
        <button type="button" className="sidebar-footer-action schema-diagnostics-action">
          <TriangleAlert size={14} />
          {label}
        </button>
      </Popover.Target>
      <Popover.Dropdown aria-label={label}>
        <Stack gap="sm">
          {diagnostics.map((diagnostic, index) => (
            <div key={`${diagnostic.collection}:${diagnostic.code}:${index}`}>
              <Text size="xs" fw={700} c="yellow.7">
                {diagnostic.collection ?? "Project"}
              </Text>
              <Text size="sm">{diagnostic.message}</Text>
            </div>
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

export function Sidebar(props: {
  root: string;
  groups: FileGroup[];
  config: PagesConfig | null;
  activeKey: string | null;
  onOpen: (file: FileEntry) => void;
  onDelete: (file: FileEntry) => void;
  onNewFile: (group: FileGroup) => void;
  /** Reveals controls that write repository-level Posto configuration. */
  developerMode?: boolean;
  /** `.posto` settings were saved; reload the overlay. */
  onPostoSaved: () => void;
}) {
  const { root, groups, config } = props;
  const developerMode = props.developerMode ?? true;

  // Collection whose settings dialog is open, with its group's files for
  // pinning suggestions.
  const [settingsFor, setSettingsFor] = useState<{
    collection: ContentEntry;
    files: FileEntry[];
  } | null>(null);
  const [orderOpen, setOrderOpen] = useState(false);

  useEffect(() => {
    if (developerMode) return;
    setSettingsFor(null);
    setOrderOpen(false);
  }, [developerMode]);

  const displayGroups = useMemo(
    () => sidebarDisplayGroups(groups, config, root),
    [groups, config, root],
  );

  return (
    <aside className="sidebar">
      {developerMode && settingsFor && (
        <CollectionSettingsDialog
          root={root}
          collection={settingsFor.collection}
          files={settingsFor.files}
          onClose={() => setSettingsFor(null)}
          onSaved={props.onPostoSaved}
        />
      )}
      {developerMode && orderOpen && (
        <CollectionOrderDialog
          root={root}
          collections={orderableCollections(config)}
          onClose={() => setOrderOpen(false)}
          onSaved={props.onPostoSaved}
        />
      )}
      <div className="sidebar-groups">
        {displayGroups.map(({ group, collection, exact }) =>
          group.label ? (
            // The synthetic Styles group shares its path with the root
            // group, so the key needs the kind to stay unique.
            <details key={`${group.kind ?? ""}:${group.path}`} open>
              <summary>
                <span className="group-label" title={group.label}>
                  {group.label}
                </span>
                {canCreateFileInGroup(root, group) && (
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
                {developerMode && collection && exact && (
                  <button
                    type="button"
                    className="group-action"
                    title="Collection settings"
                    aria-label={`Settings for ${group.label}`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setSettingsFor({ collection, files: group.files });
                    }}
                  >
                    <SlidersHorizontal size={14} />
                  </button>
                )}
                <ChevronDown size={14} className="group-chevron" />
              </summary>
              <FileList
                files={group.files}
                activeKey={props.activeKey}
                pinned={collection?.pinned}
                onOpen={props.onOpen}
                onDelete={props.onDelete}
              />
            </details>
          ) : (
            <FileList
              key={group.path}
              files={group.files}
              activeKey={props.activeKey}
              onOpen={props.onOpen}
              onDelete={props.onDelete}
            />
          ),
        )}
      </div>
      {developerMode && orderableCollections(config).length > 1 && (
        <button type="button" className="sidebar-footer-action" onClick={() => setOrderOpen(true)}>
          <SlidersHorizontal size={14} />
          Collection settings
        </button>
      )}
      {developerMode && <SchemaDiagnostics config={config} />}
    </aside>
  );
}

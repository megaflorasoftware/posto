import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActionIcon,
  Tree,
  getTreeExpandedState,
  useTree,
  type RenderTreeNodePayload,
  type TreeNodeData,
} from "@mantine/core";
import { FileText, Folder, FolderOpen, Pin, Plus, SlidersHorizontal } from "lucide-react";
import type { ContentEntry } from "@posto/core/pagescms/config";
import { expandEntryName } from "@posto/core/posto/config";
import type { FileEntry, FileGroup } from "@posto/ipc";
import type { DisplayGroupNode } from "./Sidebar";
import { FileList } from "./FileList";

/** Public media is managed through the media library, not this text-file tree. */
export function canCreateFileInGroup(root: string, group: FileGroup): boolean {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedGroup = group.path.replace(/\\/g, "/").replace(/\/+$/, "");
  return group.kind !== "styles" && normalizedGroup !== `${normalizedRoot}/public`;
}

type DirectoryNodeProps = {
  type: "directory";
  display: DisplayGroupNode;
};

type FileNodeProps = {
  type: "file";
  file: FileEntry;
  collection: ContentEntry | null;
};

type FileTreeNodeProps = DirectoryNodeProps | FileNodeProps;

function fileValue(file: FileEntry): string {
  return `file:${file.key ?? file.path}`;
}

function directoryValue(node: DisplayGroupNode): string {
  return `directory:${node.group.kind ?? ""}:${node.group.path}`;
}

/** A custom collection entry-label template wins; otherwise show the filename. */
export function sidebarFileLabel(file: FileEntry, collection: ContentEntry | null): string {
  if (!collection?.entryName) return file.name;
  return expandEntryName(collection.entryName, file.frontmatter) ?? file.name;
}

function fileData(file: FileEntry, collection: ContentEntry | null): TreeNodeData {
  return {
    value: fileValue(file),
    label: sidebarFileLabel(file, collection),
    nodeProps: { type: "file", file, collection } satisfies FileNodeProps,
  };
}

function directoryData(display: DisplayGroupNode): TreeNodeData {
  return {
    value: directoryValue(display),
    label: display.group.label,
    nodeProps: { type: "directory", display } satisfies DirectoryNodeProps,
    children: [
      ...display.group.files.map((file) => fileData(file, display.collection)),
      ...display.children.map(directoryData),
    ],
  };
}

/** Converts sidebar groups into Mantine Tree data, lifting loose root files. */
export function fileTreeData(nodes: DisplayGroupNode[]): TreeNodeData[] {
  return nodes.flatMap((node) =>
    node.group.label
      ? [directoryData(node)]
      : node.group.files.map((file) => fileData(file, node.collection)),
  );
}

function nodeProps(node: TreeNodeData): FileTreeNodeProps {
  return node.nodeProps as FileTreeNodeProps;
}

export function FileTree(props: {
  root: string;
  nodes: DisplayGroupNode[];
  activeKey: string | null;
  variant: "desktop" | "mobile";
  developerMode: boolean;
  onOpen: (file: FileEntry) => void;
  onDelete?: (file: FileEntry) => void;
  onNewFile: (group: FileGroup) => void;
  onSettings: (collection: ContentEntry, files: FileEntry[]) => void;
}) {
  const data = useMemo(() => fileTreeData(props.nodes), [props.nodes]);
  const rootDirectories = useMemo(
    () => data.filter((node) => nodeProps(node).type === "directory").map((node) => node.value),
    [data],
  );
  const [expandedState, setExpandedState] = useState(() =>
    getTreeExpandedState(data, rootDirectories),
  );
  const initializedRoots = useRef(new Set<string>());

  useEffect(() => {
    const newRoots = rootDirectories.filter((value) => !initializedRoots.current.has(value));
    if (newRoots.length === 0) return;
    newRoots.forEach((value) => initializedRoots.current.add(value));
    setExpandedState((current) => ({
      ...current,
      ...Object.fromEntries(newRoots.map((value) => [value, true])),
    }));
  }, [rootDirectories]);

  const tree = useTree({
    expandedState,
    onExpandedStateChange: setExpandedState,
    selectedState: props.activeKey ? [`file:${props.activeKey}`] : [],
  });

  function renderDirectory(payload: RenderTreeNodePayload, directory: DirectoryNodeProps) {
    const { group, collection, exact } = directory.display;
    const labelClass =
      props.variant === "mobile" ? "mobile-file-tree-directory" : "file-tree-directory";
    const actionClass = props.variant === "mobile" ? "mobile-group-action" : "group-action";

    return (
      <div
        {...payload.elementProps}
        className={`${payload.elementProps.className} ${labelClass}`}
        title={group.label}
      >
        {payload.expanded ? (
          <FolderOpen
            size={props.variant === "mobile" ? 15 : 13}
            className="file-tree-type-icon"
            aria-hidden
          />
        ) : (
          <Folder
            size={props.variant === "mobile" ? 15 : 13}
            className="file-tree-type-icon"
            aria-hidden
          />
        )}
        <span className="file-tree-directory-label">{group.label}</span>
        {canCreateFileInGroup(props.root, group) &&
          (props.variant === "mobile" ? (
            <ActionIcon
              className={actionClass}
              variant="subtle"
              color="gray"
              aria-label={`New file in ${group.label}`}
              title="New file"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                props.onNewFile(group);
              }}
            >
              <Plus size={16} />
            </ActionIcon>
          ) : (
            <button
              type="button"
              className={actionClass}
              title="New file"
              aria-label={`New file in ${group.label}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                props.onNewFile(group);
              }}
            >
              <Plus size={14} />
            </button>
          ))}
        {props.developerMode &&
          collection &&
          exact &&
          (props.variant === "mobile" ? (
            <ActionIcon
              className={actionClass}
              variant="subtle"
              color="gray"
              aria-label={`Settings for ${group.label}`}
              title="Collection settings"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                props.onSettings(collection, group.files);
              }}
            >
              <SlidersHorizontal size={16} />
            </ActionIcon>
          ) : (
            <button
              type="button"
              className={actionClass}
              title="Collection settings"
              aria-label={`Settings for ${group.label}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                props.onSettings(collection, group.files);
              }}
            >
              <SlidersHorizontal size={14} />
            </button>
          ))}
      </div>
    );
  }

  function renderFile(payload: RenderTreeNodePayload, item: FileNodeProps) {
    if (props.variant === "mobile") {
      return (
        <div
          {...payload.elementProps}
          className={`${payload.elementProps.className} mobile-file-tree-file`}
        >
          <button
            type="button"
            className="mobile-file-item"
            title={item.file.name}
            onClick={() => props.onOpen(item.file)}
          >
            <FileText size={15} className="file-tree-type-icon" aria-hidden />
            <span className="mobile-file-label">
              {sidebarFileLabel(item.file, item.collection)}
            </span>
            {item.collection?.pinned?.includes(item.file.name) && (
              <Pin size={13} className="mobile-file-pin" aria-label="Pinned" />
            )}
          </button>
        </div>
      );
    }

    return (
      <div {...payload.elementProps} className={`${payload.elementProps.className} file-tree-file`}>
        <FileList
          files={[item.file]}
          leadingIcon={<FileText size={13} className="file-tree-type-icon" aria-hidden />}
          fileLabel={(file) => sidebarFileLabel(file, item.collection)}
          activeKey={props.activeKey}
          pinned={item.collection?.pinned}
          onOpen={props.onOpen}
          onDelete={props.onDelete!}
        />
      </div>
    );
  }

  return (
    <Tree
      className={props.variant === "mobile" ? "mobile-file-tree" : "file-tree"}
      data={data}
      tree={tree}
      levelOffset={props.variant === "mobile" ? 18 : 14}
      withLines
      renderNode={(payload) => {
        const metadata = nodeProps(payload.node);
        return metadata.type === "directory"
          ? renderDirectory(payload, metadata)
          : renderFile(payload, metadata);
      }}
    />
  );
}

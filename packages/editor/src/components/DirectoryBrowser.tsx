import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Group,
  Loader,
  Stack,
  Text,
  Tree,
  getTreeExpandedState,
  mergeAsyncChildren,
  useTree,
  type RenderTreeNodePayload,
  type TreeNodeData,
} from "@mantine/core";
import { Folder, FolderOpen, TriangleAlert } from "lucide-react";
import { invoke } from "@posto/ipc";

function directoryNode(path: string, label: string): TreeNodeData {
  return { value: path, label, hasChildren: true };
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

function renderDirectory(payload: RenderTreeNodePayload) {
  const label =
    typeof payload.node.label === "string" ? payload.node.label : basename(payload.node.value);
  return (
    <div
      {...payload.elementProps}
      className={`${payload.elementProps.className} directory-browser-node`}
      title={payload.loadError?.message ?? label}
    >
      {payload.expanded ? <FolderOpen size={16} /> : <Folder size={16} />}
      <span className="directory-browser-label">{payload.node.label}</span>
      {payload.loadError && <TriangleAlert size={15} color="var(--mantine-color-red-6)" />}
    </div>
  );
}

export function DirectoryBrowser(props: {
  repoRoot: string;
  onChoose: (dir: string) => void;
  onCancel: () => void;
}) {
  return <DirectoryBrowserContent key={props.repoRoot} {...props} />;
}

function DirectoryBrowserContent(props: {
  repoRoot: string;
  onChoose: (dir: string) => void;
  onCancel: () => void;
}) {
  const [data, setData] = useState<TreeNodeData[]>([
    directoryNode(props.repoRoot, "Repository root"),
  ]);
  const [selected, setSelected] = useState<string[]>([props.repoRoot]);
  const [loadingRoot, setLoadingRoot] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadChildren = useCallback(async (dir: string) => {
    const listed = await invoke<string[]>("list_child_directories", { dir });
    setData((current) =>
      mergeAsyncChildren(
        current,
        dir,
        listed.map((path) => directoryNode(path, basename(path))),
      ),
    );
  }, []);

  const tree = useTree({
    initialExpandedState: getTreeExpandedState(data, [props.repoRoot]),
    selectedState: selected,
    onSelectedStateChange: setSelected,
    onLoadChildren: loadChildren,
  });

  useEffect(() => {
    let cancelled = false;
    void invoke<string[]>("list_child_directories", { dir: props.repoRoot })
      .then((listed) => {
        if (cancelled) return;
        setData([
          {
            value: props.repoRoot,
            label: "Repository root",
            children: listed.map((path) => directoryNode(path, basename(path))),
          },
        ]);
        setLoadingRoot(false);
      })
      .catch((reason) => {
        if (cancelled) return;
        setError(String(reason));
        setLoadingRoot(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.repoRoot]);

  const selectedDir = selected[0] ?? props.repoRoot;
  const selectedLabel =
    selectedDir === props.repoRoot
      ? "Repository root"
      : selectedDir.slice(props.repoRoot.length + 1);


  return (
    <Stack className="workspace-chooser" gap="sm">
      <div>
        <Text fw={600}>Browse project directories</Text>
        <Text size="sm" c="dimmed">
          {selectedLabel}
        </Text>
      </div>
      <Group grow>
        <Button variant="default" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button onClick={() => props.onChoose(selectedDir)}>Use this folder</Button>
      </Group>
      {error && <Alert color="red">{error}</Alert>}
      {loadingRoot ? (
        <Loader size="sm" />
      ) : (
        <Tree
          className="directory-browser-tree"
          data={data}
          tree={tree}
          levelOffset={18}
          selectOnClick
          withLines
          renderNode={renderDirectory}
        />
      )}
    </Stack>
  );
}

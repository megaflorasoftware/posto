import { useEffect, useState } from "react";
import { Alert, Button, Group, Loader, Stack, Text } from "@mantine/core";
import { ChevronLeft, Folder } from "lucide-react";
import { invoke } from "@posto/ipc";

export function DirectoryBrowser(props: {
  repoRoot: string;
  onChoose: (dir: string) => void;
  onCancel: () => void;
}) {
  const [dir, setDir] = useState(props.repoRoot);
  const [children, setChildren] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setChildren(null);
    setError(null);
    void invoke<string[]>("list_child_directories", { dir })
      .then((listed) => {
        if (!cancelled) setChildren(listed);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [dir]);

  const parent = dir.slice(0, dir.lastIndexOf("/"));
  const canGoUp = dir !== props.repoRoot && parent.startsWith(props.repoRoot);
  const label = dir === props.repoRoot ? "Repository root" : dir.slice(props.repoRoot.length + 1);

  return (
    <Stack className="workspace-chooser" gap="sm">
      <div>
        <Text fw={600}>Browse project directories</Text>
        <Text size="sm" c="dimmed">
          {label}
        </Text>
      </div>
      <Group grow>
        <Button variant="default" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button onClick={() => props.onChoose(dir)}>Use this folder</Button>
      </Group>
      {canGoUp && (
        <Button
          variant="subtle"
          justify="flex-start"
          leftSection={<ChevronLeft size={16} />}
          onClick={() => setDir(parent)}
        >
          Parent folder
        </Button>
      )}
      {error && <Alert color="red">{error}</Alert>}
      {children === null && !error ? (
        <Loader size="sm" />
      ) : (
        children?.map((child) => (
          <Button
            key={child}
            variant="default"
            justify="flex-start"
            leftSection={<Folder size={16} />}
            onClick={() => setDir(child)}
          >
            {child.slice(child.lastIndexOf("/") + 1)}
          </Button>
        ))
      )}
    </Stack>
  );
}

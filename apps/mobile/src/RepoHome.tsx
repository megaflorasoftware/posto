import {
  Alert,
  Button,
  Center,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core";
import { PublishModal, useFileGroups, useGitSync } from "@posto/editor/sync";
import type { ChangedFile } from "@posto/ipc";
import {
  CloudDownload,
  ChevronDown,
  GitCommitHorizontal,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type Props = {
  root: string;
};

export default function RepoHome({ root }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const files = useFileGroups(setError);
  const git = useGitSync(root, {
    onStatus: setStatus,
    afterPull: (dir) => void files.refreshGroups(dir),
  });

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void files.refreshGroups(root).finally(() => {
      if (active) setLoading(false);
    });
    void git.refreshLocalChanges(root);
    return () => {
      active = false;
    };
    // The selected root is the only value that should restart initial loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  const fileCount = useMemo(
    () => files.groups.reduce((total, group) => total + group.files.length, 0),
    [files.groups],
  );

  function openPublish() {
    setPublishOpen(true);
    void git.loadChanges(root);
  }

  async function revert(file: ChangedFile) {
    if (!(await git.revertChange(root, file))) return;
    void files.refreshGroups(root);
  }

  return (
    <main className="repo-home">
      <Stack gap="sm" className="repo-home-notices">
        {git.behindUpstream && (
          <Alert
            color="blue"
            variant="light"
            icon={<CloudDownload size={18} />}
            title="Updates are available"
            className="sync-alert"
          >
            <Group justify="space-between" align="center" wrap="nowrap">
              <Text size="sm">Pull the latest changes before editing.</Text>
              <Button
                size="sm"
                variant="light"
                loading={git.pulling}
                onClick={() => void git.fetchChanges()}
              >
                Pull
              </Button>
            </Group>
          </Alert>
        )}

        {status && (
          <Alert color={status.includes("failed") ? "red" : "blue"} variant="light">
            {status}
          </Alert>
        )}

        {error && (
          <Alert color="red" variant="light" title="Files could not be loaded">
            <Stack gap="sm">
              <Text size="sm">{error}</Text>
              <Button
                variant="light"
                color="red"
                size="sm"
                leftSection={<RefreshCw size={14} />}
                onClick={() => void files.refreshGroups(root)}
              >
                Try again
              </Button>
            </Stack>
          </Alert>
        )}
      </Stack>

      <ScrollArea className="repo-files" type="auto">
        {loading ? (
          <Center className="repo-files-state"><Loader size="md" /></Center>
        ) : fileCount === 0 && !error ? (
          <Center className="repo-files-state">
            <Stack align="center" gap="xs">
              <Text fw={600}>No editable files found</Text>
              <Text size="sm" c="dimmed" ta="center">
                Markdown, MDX, text, and stylesheet files will appear here.
              </Text>
            </Stack>
          </Center>
        ) : (
          <div className="mobile-document-list">
            {files.groups.map((group) => (
              group.label ? (
                <details key={`${group.kind ?? ""}:${group.path}`} open>
                  <summary>
                    <span className="mobile-group-label" title={group.label}>{group.label}</span>
                    <ChevronDown size={14} className="mobile-group-chevron" />
                  </summary>
                  {group.files.map((file) => (
                    <div className="mobile-file-item" key={file.path} title={file.name}>
                      {file.title ?? file.name}
                    </div>
                  ))}
                </details>
              ) : (
                <div key={`${group.kind ?? ""}:${group.path}`}>
                  {group.files.map((file) => (
                    <div className="mobile-file-item" key={file.path} title={file.name}>
                      {file.title ?? file.name}
                    </div>
                  ))}
                </div>
              )
            ))}
          </div>
        )}
      </ScrollArea>

      <div className="repo-home-actions">
        <Button
          fullWidth
          size="sm"
          leftSection={<GitCommitHorizontal size={19} />}
          disabled={!git.hasLocalChanges}
          onClick={openPublish}
        >
          {git.hasLocalChanges ? "Publish…" : "Everything is published"}
        </Button>
      </div>

      <PublishModal
        opened={publishOpen}
        changes={git.changes}
        error={git.changesError}
        onClose={() => setPublishOpen(false)}
        onRevert={(file) => void revert(file)}
        onPublish={(message) => {
          setPublishOpen(false);
          void git.publish(message);
        }}
      />
    </main>
  );
}

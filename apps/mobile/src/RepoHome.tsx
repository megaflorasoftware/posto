import {
  Alert,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { PublishModal, useFileGroups, useGitSync } from "@posto/editor/sync";
import type { ChangedFile, GitHubRepo } from "@posto/ipc";
import {
  CloudDownload,
  FileText,
  FolderGit2,
  GitCommitHorizontal,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type Props = {
  root: string;
  repo: GitHubRepo | null;
  onChangeRepo: () => void;
};

export default function RepoHome({ root, repo, onChangeRepo }: Props) {
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
      <Group justify="space-between" align="flex-start" wrap="nowrap" className="repo-home-title">
        <div>
          <Text className="eyebrow">On this device</Text>
          <Title order={1}>{repo?.name ?? "Your site"}</Title>
          <Group gap="xs" mt={8}>
            <Badge variant="light" color="violet" leftSection={<FolderGit2 size={12} />}>
              {repo?.owner ?? "Repository"}
            </Badge>
            {!loading && <Text size="xs" c="dimmed">{fileCount} files</Text>}
          </Group>
        </div>
        <Button variant="subtle" color="gray" size="compact-sm" onClick={onChangeRepo}>
          Change
        </Button>
      </Group>

      <Stack gap="sm" className="repo-home-notices">
        {git.behindUpstream && (
          <Alert
            color="violet"
            variant="light"
            icon={<CloudDownload size={18} />}
            title="Updates are available"
            className="sync-alert"
          >
            <Group justify="space-between" align="center" wrap="nowrap">
              <Text size="sm">Pull the latest changes before editing.</Text>
              <Button
                size="compact-sm"
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
          <Alert color={status.includes("failed") ? "red" : "violet"} variant="light">
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
                size="compact-sm"
                leftSection={<RefreshCw size={14} />}
                onClick={() => void files.refreshGroups(root)}
              >
                Try again
              </Button>
            </Stack>
          </Alert>
        )}
      </Stack>

      <ScrollArea className="repo-files" type="auto" offsetScrollbars>
        {loading ? (
          <Center className="repo-files-state"><Loader size="sm" /></Center>
        ) : fileCount === 0 && !error ? (
          <Center className="repo-files-state">
            <Stack align="center" gap="xs">
              <ThemeIcon variant="light" color="gray" radius="xl" size="lg">
                <FileText size={18} />
              </ThemeIcon>
              <Text fw={600}>No editable files found</Text>
              <Text size="sm" c="dimmed" ta="center">
                Markdown, MDX, text, and stylesheet files will appear here.
              </Text>
            </Stack>
          </Center>
        ) : (
          <Stack gap="md" pb="md">
            {files.groups.map((group) => (
              <Paper
                key={`${group.kind ?? ""}:${group.path}`}
                withBorder
                radius="lg"
                className="mobile-file-group"
              >
                <Group justify="space-between" className="mobile-file-group-heading">
                  <Text fw={700} size="sm">{group.label || "Site files"}</Text>
                  <Badge size="sm" variant="light" color="gray">{group.files.length}</Badge>
                </Group>
                <Stack gap={0}>
                  {group.files.map((file) => (
                    <div className="mobile-file-row" key={file.path}>
                      <ThemeIcon variant="light" color="violet" radius="md" size="md">
                        <FileText size={16} />
                      </ThemeIcon>
                      <div className="mobile-file-copy">
                        <Text fw={600} size="sm" truncate>{file.title ?? file.name}</Text>
                        {file.title && <Text size="xs" c="dimmed" truncate>{file.name}</Text>}
                      </div>
                    </div>
                  ))}
                </Stack>
              </Paper>
            ))}
          </Stack>
        )}
      </ScrollArea>

      <div className="repo-home-actions">
        <Button
          fullWidth
          size="md"
          radius="xl"
          leftSection={<GitCommitHorizontal size={19} />}
          disabled={!git.hasLocalChanges}
          onClick={openPublish}
        >
          {git.hasLocalChanges ? "Publish changes" : "Everything is published"}
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

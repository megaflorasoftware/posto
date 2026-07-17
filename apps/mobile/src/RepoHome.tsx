import {
  ActionIcon,
  Alert,
  Breadcrumbs,
  Button,
  Center,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { PublishModal, useFileGroups, useGitSync } from "@posto/editor/sync";
import { invoke } from "@posto/ipc";
import type { ChangedFile, GitHubRepo } from "@posto/ipc";
import {
  CloudDownload,
  ChevronDown,
  GitCommitHorizontal,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type Props = {
  root: string;
  repo: GitHubRepo | null;
  onChangeRepo: () => void;
  onRedownloadRepo: () => Promise<void>;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function RepoHome({ root, repo, onChangeRepo, onRedownloadRepo }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [redownloading, setRedownloading] = useState(false);
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

  async function refreshRepository() {
    if (!repo || refreshing) return;
    setRefreshing(true);
    setRepairError(null);
    setError(null);
    setStatus("Checking repository…");
    try {
      const check = await invoke<string>("doctor_repo", {
        root,
        expectedUrl: repo.clone_url,
      });
      setStatus(check === "Repository repaired." ? "Repository repaired. Updating…" : "Updating…");
    } catch (checkError) {
      setStatus(null);
      setRepairError(message(checkError));
      setRefreshing(false);
      return;
    }

    try {
      const behind = await invoke<boolean>("fetch_upstream", { root });
      if (behind) {
        setStatus("Downloading updates…");
        await invoke<string>("pull_upstream", { root });
      }
      await files.refreshGroups(root);
      await git.refreshLocalChanges(root);
      setStatus("Repository is up to date.");
    } catch (refreshError) {
      setStatus(null);
      setError(`Could not refresh the repository: ${message(refreshError)}`);
    } finally {
      setRefreshing(false);
    }
  }

  async function redownloadRepository() {
    setRedownloading(true);
    try {
      await onRedownloadRepo();
    } catch (removeError) {
      setRepairError(`Could not remove the damaged repository: ${message(removeError)}`);
      setRedownloading(false);
    }
  }

  return (
    <>
      <header className="mobile-header">
        <Breadcrumbs separator="/" className="mobile-breadcrumbs">
          <UnstyledButton className="mobile-breadcrumb-link" onClick={onChangeRepo}>
            Repositories
          </UnstyledButton>
          <Text fw={600} size="sm" truncate>{repo?.name ?? "Repository"}</Text>
        </Breadcrumbs>
        <ActionIcon
          variant="subtle"
          aria-label="Refresh repository"
          title="Refresh repository"
          loading={refreshing}
          onClick={() => void refreshRepository()}
        >
          <RefreshCw size={19} />
        </ActionIcon>
      </header>
      <main className="repo-home">
      <Stack gap="sm" className="repo-home-notices">
        {repairError && (
          <Alert
            color="red"
            variant="light"
            icon={<TriangleAlert size={19} />}
            title="This repository needs to be downloaded again"
          >
            <Stack gap="sm">
              <Text size="sm">{repairError}</Text>
              <Text size="sm">
                Remove the damaged local copy and download a clean copy from GitHub. Files that
                have not been published may be lost.
              </Text>
              <Button
                color="red"
                variant="light"
                loading={redownloading}
                onClick={() => void redownloadRepository()}
              >
                Remove and redownload
              </Button>
            </Stack>
          </Alert>
        )}
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
    </>
  );
}

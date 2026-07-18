import {
  ActionIcon,
  Alert,
  Breadcrumbs,
  Button,
  Center,
  Group,
  ScrollArea,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import {
  EditorPane,
  NewFileModal,
  PublishModal,
  contentHasFields,
  useCurrentFile,
  useFileGroups,
  useGitSync,
  useSchemas,
  type EditorTab,
} from "@posto/editor";
import { matchEntry } from "@posto/core/pagescms/config";
import { parseFile } from "@posto/core/pagescms/frontmatter";
import { invoke } from "@posto/ipc";
import type { ChangedFile, FileGroup, GitHubRepo } from "@posto/ipc";
import {
  CloudDownload,
  ChevronDown,
  GitCommitHorizontal,
  Menu,
  Plus,
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
  const [repairError, setRepairError] = useState<string | null>(null);
  const [redownloading, setRedownloading] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [checkingChanges, setCheckingChanges] = useState(false);
  const [newFileGroup, setNewFileGroup] = useState<FileGroup | null>(null);
  const [editorTab, setEditorTab] = useState<EditorTab>("fields");
  const schemas = useSchemas();
  const files = useFileGroups(setError);
  const currentFile = useCurrentFile({
    onAfterSave(path, content) {
      files.updateSidebarTitle(path, content);
      if (path === root + "/.pages.yml") void schemas.loadPagesConfig(root);
      if (path === root + "/src/content.config.ts" || path === root + "/src/content/config.ts") {
        void schemas.loadAstroConfig(root);
      }
    },
    onOpened(path, content) {
      if (!/\.(md|mdx|markdown)$/i.test(path)) return;
      const entry = schemas.configRef.current
        ? matchEntry(schemas.configRef.current, root, path)
        : null;
      const parsed = parseFile(content);
      const hasFields = contentHasFields(entry, parsed);
      const hasBody = parsed.body.trim() !== "";
      setEditorTab((last) => {
        if (last === "fields" && !hasFields) return "body";
        if (last === "body" && !hasBody && hasFields) return "fields";
        return last;
      });
    },
    onOpenError: setError,
  });
  const git = useGitSync(root, {
    onStatus: setStatus,
    beforeSync: () => currentFile.flushPendingSave(),
    afterPull: (dir) => void files.refreshGroups(dir),
  });

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setRepairError(null);
    const repositoryCheck = repo
      ? invoke<string>("doctor_repo", { root, expectedUrl: repo.clone_url }).catch((checkError) => {
          if (active) setRepairError(message(checkError));
        })
      : Promise.resolve();
    const repositoryContent = Promise.all([
      files.refreshGroups(root),
      schemas.loadPagesConfig(root),
      schemas.loadAstroConfig(root),
    ]);
    void Promise.all([repositoryContent, repositoryCheck]).finally(() => {
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

  async function openPublish() {
    await currentFile.flushPendingSave();
    setPublishOpen(true);
    await git.loadChanges(root);
  }

  async function revert(file: ChangedFile) {
    if (!(await git.revertChange(root, file))) return;
    void files.refreshGroups(root);
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

  async function openFile(path: string) {
    await currentFile.openFile(path);
    if (currentFile.filePathRef.current === path) setShowEditor(true);
  }

  async function openCreatedFile(path: string) {
    setNewFileGroup(null);
    await files.refreshGroups(root);
    await openFile(path);
  }

  function closeEditor() {
    const pendingSave = currentFile.flushPendingSave();
    setShowEditor(false);
    currentFile.closeFile();
    setCheckingChanges(true);
    void pendingSave
      .then(() => git.refreshLocalChanges(root))
      .finally(() => setCheckingChanges(false));
  }

  function closeSecondaryView() {
    if (showEditor) closeEditor();
    else setShowSettings(false);
  }

  function leaveRepository() {
    currentFile.flushPendingSave();
    currentFile.closeFile();
    setShowSettings(false);
    onChangeRepo();
  }

  const config = schemas.config;
  const entry = useMemo(() => {
    if (!currentFile.filePath || !config) return null;
    return matchEntry(config, root, currentFile.filePath);
  }, [config, currentFile.filePath, root]);
  const entrySource =
    entry === null ? null : schemas.astroConfig?.content.includes(entry) ? "astro" : "pages";
  const openFileName = currentFile.filePath?.split("/").pop() ?? "File";

  return (
    <>
      <header className="mobile-header">
        <Breadcrumbs separator="/" className="mobile-breadcrumbs">
          <UnstyledButton className="mobile-breadcrumb-link" onClick={leaveRepository}>
            Repositories
          </UnstyledButton>
          {showEditor || showSettings ? (
            <UnstyledButton className="mobile-breadcrumb-link" onClick={closeSecondaryView}>
              {repo?.name ?? "Repository"}
            </UnstyledButton>
          ) : (
            <Text fw={600} size="sm" truncate>{repo?.name ?? "Repository"}</Text>
          )}
          {showEditor && (
            <Text fw={600} size="sm" className="mobile-file-breadcrumb">{openFileName}</Text>
          )}
          {showSettings && <Text fw={600} size="sm" truncate>Settings</Text>}
        </Breadcrumbs>
        {!showEditor && !showSettings && (
          <ActionIcon
            variant="subtle"
            aria-label="Site settings"
            title="Site settings"
            onClick={() => setShowSettings(true)}
          >
            <Menu size={20} />
          </ActionIcon>
        )}
      </header>
      {showEditor ? (
        <main className="mobile-editor-screen">
          <EditorPane
            root={root}
            filePath={currentFile.filePath}
            fileContent={currentFile.fileContent}
            saveState={currentFile.saveState}
            entry={entry}
            entrySource={entrySource}
            config={config}
            configError={schemas.configError}
            hasAstroFallback={schemas.astroConfig !== null}
            groups={files.groups}
            editorTab={editorTab}
            onTabChange={setEditorTab}
            onEdit={currentFile.onEdit}
            onFormEdit={currentFile.onFormEdit}
          />
        </main>
      ) : showSettings ? (
        <main className="mobile-settings-screen">
          <Stack gap="xs">
            {[
              ["Site details", "Name, URL, and metadata"],
              ["Publishing", "Branch and deployment settings"],
              ["Media", "Image sources and upload settings"],
              ["Domains", "Custom domains and redirects"],
            ].map(([label, description]) => (
              <div className="mobile-settings-row" key={label}>
                <div>
                  <Text fw={600} size="sm">{label}</Text>
                  <Text c="dimmed" size="xs">{description}</Text>
                </div>
                <Text c="dimmed" size="xs">Coming soon</Text>
              </div>
            ))}
          </Stack>
        </main>
      ) : (
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
          null
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
                    {group.kind !== "styles" && (
                      <ActionIcon
                        className="mobile-group-action"
                        variant="subtle"
                        color="gray"
                        aria-label={`New file in ${group.label}`}
                        title="New file"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setNewFileGroup(group);
                        }}
                      >
                        <Plus size={16} />
                      </ActionIcon>
                    )}
                    <ChevronDown size={14} className="mobile-group-chevron" />
                  </summary>
                  {group.files.map((file) => (
                    <button
                      className="mobile-file-item"
                      key={file.path}
                      title={file.name}
                      onClick={() => void openFile(file.path)}
                    >
                      {file.title ?? file.name}
                    </button>
                  ))}
                </details>
              ) : (
                <div key={`${group.kind ?? ""}:${group.path}`}>
                  {group.files.map((file) => (
                    <button
                      className="mobile-file-item"
                      key={file.path}
                      title={file.name}
                      onClick={() => void openFile(file.path)}
                    >
                      {file.title ?? file.name}
                    </button>
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
          loading={checkingChanges}
          onClick={() => void openPublish()}
        >
          {checkingChanges
            ? "Checking changes…"
            : git.hasLocalChanges
              ? "Publish…"
              : "Up to date"}
        </Button>
      </div>

      {newFileGroup && config && (
        <NewFileModal
          root={root}
          group={newFileGroup}
          config={config}
          astroContent={schemas.astroConfig?.content ?? []}
          onClose={() => setNewFileGroup(null)}
          onCreated={(path) => void openCreatedFile(path)}
        />
      )}

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
      )}
    </>
  );
}

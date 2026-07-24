import { useState } from "react";
import { Alert, Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { Trash2 } from "lucide-react";
import {
  deleteFileMediaDirectory,
  deleteFileMediaItem,
  moveFileMediaDirectory,
  moveFileMediaItem,
  renameFileMediaItem,
  type FileEntry,
  type FileGroup,
} from "@posto/ipc";
import {
  applyImageLibraryReferenceUpdates,
  planMarkdownMediaReferenceUpdates,
} from "../imageLibraryReferences";
import { publicMediaOutputPath } from "../markdownMedia";
import { Dialog } from "./Dialog";
import { FileMediaBrowser, FileMediaPreview } from "./PublicMediaBrowser";

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

function markdownReferenceReplacements(
  root: string,
  relocations: Array<{ from: string; to: string }>,
): Map<string, string> {
  const replacements = new Map<string, string>();
  for (const relocation of relocations) {
    const from = publicMediaOutputPath(root, relocation.from);
    const to = publicMediaOutputPath(root, relocation.to);
    if (!from || !to || from === to) continue;
    replacements.set(from, to);
    replacements.set(from.replace(/^\//, ""), to.replace(/^\//, ""));
  }
  return replacements;
}

export function FileMediaEditDialog(props: {
  root: string;
  mediaRoot: string;
  groups: FileGroup[];
  file: FileEntry;
  onBeforeChange: () => Promise<void>;
  onClose: () => void;
  onChanged: (options?: { silent?: boolean }) => void;
}) {
  const [filename, setFilename] = useState(props.file.name);
  const [pending, setPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const originalExtension = props.file.name.slice(props.file.name.lastIndexOf(".") + 1);
  const candidateExtension = filename.slice(filename.lastIndexOf(".") + 1);
  const filenameError =
    !filename ||
    filename === "." ||
    filename === ".." ||
    filename.startsWith(".") ||
    /[\\/]/.test(filename) ||
    candidateExtension.toLowerCase() !== originalExtension.toLowerCase()
      ? `Use a visible filename ending in .${originalExtension}`
      : null;

  const save = async () => {
    if (filenameError) return;
    if (filename === props.file.name) {
      props.onClose();
      return;
    }
    setPending(true);
    setError(null);
    const targetPath = `${dirname(props.file.path)}/${filename}`;
    try {
      await props.onBeforeChange();
      const referencePlan = await planMarkdownMediaReferenceUpdates({
        groups: props.groups,
        replacements: markdownReferenceReplacements(props.root, [
          { from: props.file.path, to: targetPath },
        ]),
      });
      await renameFileMediaItem({
        mediaRoot: props.mediaRoot,
        path: props.file.path,
        targetPath,
      });
      try {
        await applyImageLibraryReferenceUpdates(referencePlan);
      } catch (caught) {
        await renameFileMediaItem({
          mediaRoot: props.mediaRoot,
          path: targetPath,
          targetPath: props.file.path,
        }).catch(() => undefined);
        throw caught;
      }
      props.onChanged();
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      await deleteFileMediaItem({ mediaRoot: props.mediaRoot, path: props.file.path });
      props.onChanged({ silent: true });
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog opened onClose={props.onClose} title={`Edit ${props.file.name}`} size="xl">
      {error && (
        <Alert color="red" mb="sm">
          {error}
        </Alert>
      )}
      <div className="image-library-import-details">
        <div className="image-library-import-preview">
          <FileMediaPreview file={props.file} />
        </div>
        <div className="image-library-import-form">
          <TextInput
            size="xs"
            label="Filename"
            value={filename}
            error={filenameError}
            onChange={(event) => setFilename(event.currentTarget.value)}
          />
          <Group justify="space-between" mt="md">
            <Button
              color="red"
              variant="subtle"
              leftSection={<Trash2 size={16} />}
              loading={deleting}
              disabled={pending}
              onClick={() => void remove()}
            >
              Delete file
            </Button>
            <Button
              loading={pending}
              disabled={!!filenameError || deleting}
              onClick={() => void save()}
            >
              Save changes
            </Button>
          </Group>
        </div>
      </div>
    </Dialog>
  );
}

export function DeleteFileMediaItemsDialog(props: {
  mediaRoot: string;
  files: FileEntry[];
  directories: string[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = props.files.length + props.directories.length;

  const remove = async () => {
    setPending(true);
    setError(null);
    try {
      for (const file of props.files) {
        await deleteFileMediaItem({ mediaRoot: props.mediaRoot, path: file.path });
      }
      for (const directoryPath of props.directories) {
        await deleteFileMediaDirectory({
          mediaRoot: props.mediaRoot,
          path: directoryPath,
        });
      }
      props.onDeleted();
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      opened
      onClose={props.onClose}
      title={count === 1 ? "Delete item?" : `Delete ${count} items?`}
      size="sm"
    >
      <Stack gap="sm">
        {error && <Alert color="red">{error}</Alert>}
        <Text size="sm">
          This deletes the selected {count === 1 ? "item" : "items"} and everything inside selected
          folders from the project. This cannot be undone in Posto.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            color="red"
            leftSection={<Trash2 size={16} />}
            loading={pending}
            onClick={() => void remove()}
          >
            {count === 1 ? "Delete item" : "Delete items"}
          </Button>
        </Group>
      </Stack>
    </Dialog>
  );
}

export function MoveFileMediaItemsDialog(props: {
  root: string;
  mediaRoot: string;
  groups: FileGroup[];
  directories: string[];
  files: FileEntry[];
  movingFiles: FileEntry[];
  movingDirectories: string[];
  onBeforeChange: () => Promise<void>;
  onClose: () => void;
  onRefresh: () => void;
  onMoved: () => void;
}) {
  const [currentDirectory, setCurrentDirectory] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = props.movingFiles.length + props.movingDirectories.length;

  const move = async () => {
    setPending(true);
    setError(null);
    const destination = [props.mediaRoot, currentDirectory].filter(Boolean).join("/");
    const fileOperations = props.movingFiles.map((file) => ({
      from: file.path,
      to: `${destination}/${basename(file.path)}`,
    }));
    const directoryOperations = props.movingDirectories.map((from) => ({
      from,
      to: `${destination}/${basename(from)}`,
    }));

    try {
      const movingFilePaths = new Set(props.movingFiles.map((file) => file.path));
      const existingFilePaths = new Set(props.files.map((file) => file.path));
      const targets = new Set<string>();
      for (const operation of fileOperations) {
        if (operation.from === operation.to) {
          throw new Error("One or more selected files are already in that folder.");
        }
        if (
          targets.has(operation.to) ||
          props.directories.includes(operation.to) ||
          (existingFilePaths.has(operation.to) && !movingFilePaths.has(operation.to))
        ) {
          throw new Error("A file or folder with that name already exists in the destination.");
        }
        targets.add(operation.to);
      }

      const directoryTargets = new Set<string>();
      for (const operation of directoryOperations) {
        if (destination === operation.from || destination.startsWith(`${operation.from}/`)) {
          throw new Error("A folder cannot be moved into itself.");
        }
        if (operation.from === operation.to) {
          throw new Error("One or more selected folders are already in that folder.");
        }
        if (
          directoryTargets.has(operation.to) ||
          existingFilePaths.has(operation.to) ||
          props.directories.some(
            (directory) =>
              directory === operation.to &&
              !props.movingDirectories.some(
                (movingDirectory) =>
                  directory === movingDirectory || directory.startsWith(`${movingDirectory}/`),
              ),
          )
        ) {
          throw new Error("A file or folder with that name already exists in the destination.");
        }
        directoryTargets.add(operation.to);
      }

      const completedFiles: typeof fileOperations = [];
      const completedDirectories: typeof directoryOperations = [];
      await props.onBeforeChange();
      const relocationTargets = new Map(
        fileOperations.map((operation) => [operation.from, operation.to]),
      );
      const orderedDirectories = [...directoryOperations].sort(
        (left, right) => right.from.length - left.from.length,
      );
      for (const file of props.files) {
        if (relocationTargets.has(file.path)) continue;
        const directory = orderedDirectories.find((operation) =>
          file.path.startsWith(`${operation.from}/`),
        );
        if (directory) {
          relocationTargets.set(
            file.path,
            `${directory.to}${file.path.slice(directory.from.length)}`,
          );
        }
      }
      const referencePlan = await planMarkdownMediaReferenceUpdates({
        groups: props.groups,
        replacements: markdownReferenceReplacements(
          props.root,
          [...relocationTargets].map(([from, to]) => ({ from, to })),
        ),
      });
      try {
        for (const operation of fileOperations) {
          await moveFileMediaItem({
            mediaRoot: props.mediaRoot,
            path: operation.from,
            destinationDirectory: destination,
          });
          completedFiles.push(operation);
        }
        for (const operation of directoryOperations) {
          await moveFileMediaDirectory({
            mediaRoot: props.mediaRoot,
            path: operation.from,
            destinationDirectory: destination,
          });
          completedDirectories.push(operation);
        }
        await applyImageLibraryReferenceUpdates(referencePlan);
      } catch (caught) {
        for (const operation of completedDirectories.reverse()) {
          await moveFileMediaDirectory({
            mediaRoot: props.mediaRoot,
            path: operation.to,
            destinationDirectory: dirname(operation.from),
          }).catch(() => undefined);
        }
        for (const operation of completedFiles.reverse()) {
          await moveFileMediaItem({
            mediaRoot: props.mediaRoot,
            path: operation.to,
            destinationDirectory: dirname(operation.from),
          }).catch(() => undefined);
        }
        throw caught;
      }

      props.onMoved();
      props.onClose();
    } catch (caught) {
      props.onRefresh();
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      opened
      onClose={props.onClose}
      title={count === 1 ? "Move item" : `Move ${count} items`}
      size="xl"
    >
      {error && (
        <Alert color="red" mb="sm">
          {error}
        </Alert>
      )}
      <Text size="sm" c="dimmed" mb="sm">
        Choose a destination folder.
      </Text>
      <FileMediaBrowser
        rootDirectory={props.mediaRoot}
        currentDirectory={currentDirectory}
        directories={props.directories}
        files={props.files}
        onDirectoryChange={setCurrentDirectory}
      />
      <Button fullWidth mt="md" loading={pending} onClick={() => void move()}>
        Move here
      </Button>
    </Dialog>
  );
}

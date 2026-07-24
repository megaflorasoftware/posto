import { useState } from "react";
import { ActionIcon, Alert, Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { RotateCw, Trash2 } from "lucide-react";
import {
  deleteFileMediaDirectory,
  deleteFileMediaItem,
  renameFileMediaItem,
  rotateMediaImage,
  type FileEntry,
  type FileGroup,
} from "@posto/ipc";
import {
  applyImageLibraryReferenceUpdates,
  planMarkdownMediaReferenceUpdates,
} from "../imageLibraryReferences";
import { filePathDirname, normalizeFilePath } from "../filePaths";
import { moveFileMediaItems } from "../mediaMoves";
import { canRotateMediaImage, publicMediaOutputPath } from "../markdownMedia";
import { Dialog } from "./Dialog";
import { FileMediaBrowser, FileMediaPreview } from "./PublicMediaBrowser";

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
  const [rotating, setRotating] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
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
    const sourcePath = normalizeFilePath(props.file.path);
    const targetPath = `${filePathDirname(sourcePath)}/${filename}`;
    try {
      await props.onBeforeChange();
      const referencePlan = await planMarkdownMediaReferenceUpdates({
        groups: props.groups,
        replacements: markdownReferenceReplacements(props.root, [
          { from: sourcePath, to: targetPath },
        ]),
      });
      await renameFileMediaItem({
        mediaRoot: props.mediaRoot,
        path: sourcePath,
        targetPath,
      });
      try {
        await applyImageLibraryReferenceUpdates(referencePlan);
      } catch (caught) {
        await renameFileMediaItem({
          mediaRoot: props.mediaRoot,
          path: targetPath,
          targetPath: sourcePath,
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
  const rotate = async () => {
    if (!canRotateMediaImage(props.file.path)) return;
    setRotating(true);
    setError(null);
    try {
      await props.onBeforeChange();
      await rotateMediaImage({ mediaRoot: props.mediaRoot, path: props.file.path });
      setPreviewRevision((revision) => revision + 1);
      props.onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRotating(false);
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
          <FileMediaPreview key={previewRevision} file={props.file} />
          {canRotateMediaImage(props.file.path) && (
            <ActionIcon
              className="image-edit-rotate-action"
              variant="filled"
              color="dark"
              size="md"
              loading={rotating}
              disabled={pending || deleting}
              title="Rotate image clockwise"
              aria-label="Rotate image clockwise"
              onClick={() => void rotate()}
            >
              <RotateCw size={18} />
            </ActionIcon>
          )}
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
              disabled={pending || rotating}
              onClick={() => void remove()}
            >
              Delete file
            </Button>
            <Button
              loading={pending}
              disabled={!!filenameError || deleting || rotating}
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
    const destination = [normalizeFilePath(props.mediaRoot).replace(/\/+$/, ""), currentDirectory]
      .filter(Boolean)
      .join("/");
    try {
      await moveFileMediaItems({
        root: props.root,
        mediaRoot: props.mediaRoot,
        groups: props.groups,
        directories: props.directories,
        files: props.files,
        movingFiles: props.movingFiles,
        movingDirectories: props.movingDirectories,
        destinationDirectory: destination,
        onBeforeChange: props.onBeforeChange,
      });
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

import { useMemo, useState } from "react";
import { Alert, Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { Image as ImageIcon, Trash2 } from "lucide-react";
import {
  serializeImageLibraryMetadata,
  type ImageLibraryAsset,
} from "@posto/core/project/mediaLibrary";
import type { MediaLibrary, PagesConfig } from "@posto/core/pagescms/config";
import type { ValuePath } from "@posto/core/pagescms/frontmatter";
import { pathEntryId } from "@posto/core/project/entryIds";
import { validateForm } from "@posto/core/pagescms/validate";
import { createFileMediaDirectory, invoke, type FileGroup } from "@posto/ipc";
import {
  editValueAtPath,
  imageLibraryMetadataFields,
  metadataExtension,
  valueAtPath,
} from "../imageLibraryMetadata";
import {
  applyImageLibraryReferenceUpdates,
  planImageLibraryReferenceUpdates,
} from "../imageLibraryReferences";
import { moveImageLibraryItems } from "../mediaMoves";
import { CachedImage } from "./CachedImage";
import { Dialog } from "./Dialog";
import { FieldEditor, type FieldContext } from "./FieldEditor";
import { ImageLibraryBrowser } from "./ImageLibraryBrowser";

export function CreateImageLibraryFolderDialog(props: {
  libraryRoot: string;
  repositoryRoot?: string;
  currentDirectory: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();
  const invalid =
    !trimmed ||
    trimmed === "." ||
    trimmed === ".." ||
    /[\\/]/.test(trimmed) ||
    trimmed.startsWith(".");

  const create = async () => {
    if (invalid) return;
    setPending(true);
    setError(null);
    const directoryPath = [props.libraryRoot, props.currentDirectory, trimmed]
      .filter(Boolean)
      .join("/");
    const publicDirectory = [props.currentDirectory, trimmed].filter(Boolean).join("/");
    try {
      if (props.repositoryRoot) {
        await createFileMediaDirectory({
          repositoryRoot: props.repositoryRoot,
          mediaRoot: props.libraryRoot,
          directory: publicDirectory,
        });
      } else {
        await invoke("create_image_library_directory", {
          libraryRoot: props.libraryRoot,
          directoryPath,
        });
      }
      props.onCreated();
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog opened onClose={props.onClose} title="New folder" size="sm">
      <Stack gap="sm">
        {error && <Alert color="red">{error}</Alert>}
        <TextInput
          autoFocus
          label="Folder name"
          value={name}
          error={
            name.length > 0 && invalid ? "Enter a visible folder name without slashes." : undefined
          }
          onChange={(event) => setName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void create();
          }}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={props.onClose}>
            Cancel
          </Button>
          <Button loading={pending} disabled={invalid} onClick={() => void create()}>
            Create folder
          </Button>
        </Group>
      </Stack>
    </Dialog>
  );
}

async function deleteAssets(libraryRoot: string, assets: ImageLibraryAsset[]): Promise<void> {
  for (const asset of assets) {
    if (!asset.imagePath) throw new Error(`${asset.entryId} has no image to delete.`);
    await invoke("delete_image_library_asset", {
      libraryRoot,
      imagePath: asset.imagePath,
      metadataPath: asset.metadataPath,
    });
  }
}

async function deleteDirectories(libraryRoot: string, directories: string[]): Promise<void> {
  for (const directoryPath of directories) {
    await invoke("delete_image_library_directory", { libraryRoot, directoryPath });
  }
}

function metadataAlt(metadata: Record<string, unknown>): string | undefined {
  return Object.prototype.hasOwnProperty.call(metadata, "alt") && typeof metadata.alt === "string"
    ? metadata.alt
    : undefined;
}

export function DeleteImageLibraryAssetsDialog(props: {
  libraryRoot: string;
  assets: ImageLibraryAsset[];
  directories?: string[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const directories = props.directories ?? [];
  const count = props.assets.length + directories.length;

  const remove = async () => {
    setPending(true);
    setError(null);
    try {
      await deleteAssets(props.libraryRoot, props.assets);
      await deleteDirectories(props.libraryRoot, directories);
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

export function MoveImageLibraryAssetsDialog(props: {
  root: string;
  library: MediaLibrary;
  config: PagesConfig;
  groups: FileGroup[];
  libraryRoot: string;
  directories: string[];
  assets: ImageLibraryAsset[];
  movingAssets: ImageLibraryAsset[];
  movingDirectories?: string[];
  onClose: () => void;
  onBeforeMove: () => Promise<void>;
  onRefresh: () => void;
  onMoved: () => void;
}) {
  const [currentDirectory, setCurrentDirectory] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const movingDirectories = props.movingDirectories ?? [];
  const count = props.movingAssets.length + movingDirectories.length;

  const move = async () => {
    setPending(true);
    setError(null);
    const destinationDirectory = [props.libraryRoot, currentDirectory].filter(Boolean).join("/");
    try {
      await moveImageLibraryItems({
        root: props.root,
        library: props.library,
        config: props.config,
        groups: props.groups,
        libraryRoot: props.libraryRoot,
        directories: props.directories,
        assets: props.assets,
        movingAssets: props.movingAssets,
        movingDirectories,
        destinationDirectory,
        onBeforeMove: props.onBeforeMove,
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
      <ImageLibraryBrowser
        rootDirectory={props.libraryRoot}
        currentDirectory={currentDirectory}
        directories={props.directories}
        assets={props.assets}
        onDirectoryChange={setCurrentDirectory}
      />
      <Button fullWidth mt="md" loading={pending} onClick={() => void move()}>
        Move here
      </Button>
    </Dialog>
  );
}

export function ImageLibraryEditDialog(props: {
  root: string;
  library: MediaLibrary;
  config: PagesConfig;
  groups: FileGroup[];
  asset: ImageLibraryAsset;
  onBeforeChange: () => Promise<void>;
  onClose: () => void;
  onChanged: (options?: { silent?: boolean }) => void;
}) {
  const [metadata, setMetadata] = useState<Record<string, unknown>>(() =>
    structuredClone(props.asset.metadata),
  );
  const [pending, setPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const originalFilename =
    props.asset.imagePath?.split("/").pop() ?? props.asset.entryId.split("/").pop() ?? "";
  const [filename, setFilename] = useState(originalFilename);
  const fields = useMemo(() => imageLibraryMetadataFields(props.library), [props.library]);
  const errors = validateForm(fields, metadata);
  const update = (path: ValuePath, value: unknown) =>
    setMetadata((current) => editValueAtPath(current, path, value));
  const fieldCtx: FieldContext = {
    config: props.config,
    root: props.root,
    entry: null,
    groups: props.groups,
    errors: () => errors,
    templateValues: () => metadata,
    value: (path) => valueAtPath(metadata, path),
    edit: update,
    listAppend: (path, value) => {
      const list = valueAtPath(metadata, path);
      update(path, [...(Array.isArray(list) ? list : []), value]);
    },
    listRemove: (path, index) => {
      const list = valueAtPath(metadata, path);
      if (Array.isArray(list))
        update(
          path,
          list.filter((_item, itemIndex) => itemIndex !== index),
        );
    },
    listMove: (path, from, to) => {
      const list = valueAtPath(metadata, path);
      if (!Array.isArray(list)) return;
      const moved = [...list];
      const [item] = moved.splice(from, 1);
      moved.splice(to, 0, item);
      update(path, moved);
    },
  };

  const save = async () => {
    if (errors.size > 0 || filenameError) return;
    setPending(true);
    setError(null);
    try {
      if (!props.asset.imagePath || filename === originalFilename) {
        const serializedMetadata = serializeImageLibraryMetadata(
          metadata,
          metadataExtension(props.asset.metadataPath),
        );
        const nextAlt = metadataAlt(metadata);
        if (!props.asset.imagePath || nextAlt === undefined) {
          await invoke("write_text_file", {
            path: props.asset.metadataPath,
            content: serializedMetadata,
          });
        } else {
          await props.onBeforeChange();
          const referencePlan = await planImageLibraryReferenceUpdates({
            root: props.root,
            config: props.config,
            groups: props.groups,
            library: props.library,
            relocations: [
              {
                oldEntryId: props.asset.entryId,
                newEntryId: props.asset.entryId,
                oldImagePath: props.asset.imagePath,
                newImagePath: props.asset.imagePath,
                newAlt: nextAlt,
              },
            ],
          });
          await invoke("write_text_file", {
            path: props.asset.metadataPath,
            content: serializedMetadata,
          });
          try {
            await applyImageLibraryReferenceUpdates(referencePlan);
          } catch (caught) {
            await invoke("write_text_file", {
              path: props.asset.metadataPath,
              content: props.asset.metadataSource,
            }).catch(() => undefined);
            throw caught;
          }
        }
      } else {
        await props.onBeforeChange();
        const imageDirectory = props.asset.imagePath.slice(
          0,
          props.asset.imagePath.lastIndexOf("/"),
        );
        const metadataDirectory = props.asset.metadataPath.slice(
          0,
          props.asset.metadataPath.lastIndexOf("/"),
        );
        const imageExtension = originalFilename.slice(originalFilename.lastIndexOf(".") + 1);
        const stem = filename.slice(0, -(imageExtension.length + 1));
        const targetImagePath = `${imageDirectory}/${filename}`;
        const targetMetadataPath = `${metadataDirectory}/${stem}.${metadataExtension(props.asset.metadataPath)}`;
        const nextMetadata = editValueAtPath(
          metadata,
          props.library.imageFieldPath,
          `./${filename}`,
        );
        const serializedMetadata = serializeImageLibraryMetadata(
          nextMetadata,
          metadataExtension(props.asset.metadataPath),
        );
        const referencePlan = await planImageLibraryReferenceUpdates({
          root: props.root,
          config: props.config,
          groups: props.groups,
          library: props.library,
          relocations: [
            {
              oldEntryId: props.asset.entryId,
              newEntryId: pathEntryId(targetMetadataPath.slice(libraryRoot.length + 1)),
              oldImagePath: props.asset.imagePath,
              newImagePath: targetImagePath,
              newAlt: metadataAlt(nextMetadata),
            },
          ],
        });
        await invoke("rename_image_library_asset", {
          libraryRoot,
          imagePath: props.asset.imagePath,
          metadataPath: props.asset.metadataPath,
          targetImagePath,
          targetMetadataPath,
          serializedMetadata,
        });
        try {
          await applyImageLibraryReferenceUpdates(referencePlan);
        } catch (caught) {
          await invoke("rename_image_library_asset", {
            libraryRoot,
            imagePath: targetImagePath,
            metadataPath: targetMetadataPath,
            targetImagePath: props.asset.imagePath,
            targetMetadataPath: props.asset.metadataPath,
            serializedMetadata: props.asset.metadataSource,
          }).catch(() => undefined);
          throw caught;
        }
      }
      props.onChanged();
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };

  const libraryRoot = `${props.root}/${props.library.base}`;
  const originalExtension = originalFilename.slice(originalFilename.lastIndexOf(".") + 1);
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
  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      await deleteAssets(libraryRoot, [props.asset]);
      props.onChanged({ silent: true });
      props.onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDeleting(false);
    }
  };
  return (
    <Dialog opened onClose={props.onClose} title={`Edit ${filename}`} size="xl">
      {error && (
        <Alert color="red" mb="sm">
          {error}
        </Alert>
      )}
      <div className="image-library-import-details">
        <div className="image-library-import-preview">
          <CachedImage path={props.asset.imagePath} alt="" fallback={<ImageIcon size={28} />} />
        </div>
        <div className="image-library-import-form">
          <TextInput
            size="xs"
            label="Filename"
            value={filename}
            error={filenameError}
            onChange={(event) => setFilename(event.currentTarget.value)}
          />
          <div className="form-fields image-library-metadata-fields">
            {fields.map((field) => (
              <FieldEditor key={field.name} field={field} path={[field.name]} ctx={fieldCtx} />
            ))}
          </div>
          <Group justify="space-between" mt="md">
            <Button
              color="red"
              variant="subtle"
              leftSection={<Trash2 size={16} />}
              loading={deleting}
              disabled={pending}
              onClick={() => void remove()}
            >
              Delete image
            </Button>
            <Button
              loading={pending}
              disabled={errors.size > 0 || !!filenameError || deleting}
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

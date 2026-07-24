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
import { invoke, type FileGroup } from "@posto/ipc";
import {
  editValueAtPath,
  imageLibraryMetadataFields,
  metadataExtension,
  valueAtPath,
} from "../imageLibraryMetadata";
import {
  applyImageLibraryReferenceUpdates,
  planImageLibraryReferenceUpdates,
  type ImageLibraryRelocation,
} from "../imageLibraryReferences";
import { CachedImage } from "./CachedImage";
import { Dialog } from "./Dialog";
import { FieldEditor, type FieldContext } from "./FieldEditor";
import { ImageLibraryBrowser } from "./ImageLibraryBrowser";

export function CreateImageLibraryFolderDialog(props: {
  libraryRoot: string;
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
    try {
      await invoke("create_image_library_directory", {
        libraryRoot: props.libraryRoot,
        directoryPath,
      });
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
    const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
    const dirname = (path: string) => path.slice(0, path.lastIndexOf("/"));
    const assetTargets = props.movingAssets.map((asset) => ({
      asset,
      imagePath: `${destinationDirectory}/${basename(asset.imagePath ?? "")}`,
      metadataPath: `${destinationDirectory}/${basename(asset.metadataPath)}`,
    }));
    const directoryTargets = movingDirectories.map((directoryPath) => ({
      directoryPath,
      target: `${destinationDirectory}/${basename(directoryPath)}`,
    }));
    const relocationFor = (asset: ImageLibraryAsset): ImageLibraryRelocation | null => {
      if (!asset.imagePath) return null;
      const direct = assetTargets.find(
        (operation) => operation.asset.metadataPath === asset.metadataPath,
      );
      let newImagePath: string;
      let newMetadataPath: string;
      if (direct) {
        newImagePath = direct.imagePath;
        newMetadataPath = direct.metadataPath;
      } else {
        const directory = directoryTargets.find(
          (operation) =>
            asset.metadataPath.startsWith(`${operation.directoryPath}/`) &&
            asset.imagePath?.startsWith(`${operation.directoryPath}/`),
        );
        if (!directory) return null;
        newImagePath = `${directory.target}${asset.imagePath.slice(directory.directoryPath.length)}`;
        newMetadataPath = `${directory.target}${asset.metadataPath.slice(directory.directoryPath.length)}`;
      }
      return {
        oldEntryId: asset.entryId,
        newEntryId: pathEntryId(newMetadataPath.slice(props.libraryRoot.length + 1)),
        oldImagePath: asset.imagePath,
        newImagePath,
        newAlt: metadataAlt(asset.metadata),
      };
    };
    try {
      const existingPaths = new Set(
        props.assets.flatMap((asset) =>
          asset.imagePath ? [asset.imagePath, asset.metadataPath] : [asset.metadataPath],
        ),
      );
      const sourcePaths = new Set(
        props.movingAssets.flatMap((asset) =>
          asset.imagePath ? [asset.imagePath, asset.metadataPath] : [asset.metadataPath],
        ),
      );
      const targetPaths = new Set<string>();
      for (const asset of props.movingAssets) {
        if (!asset.imagePath) throw new Error(`${asset.entryId} has no image to move.`);
        const targets = [asset.imagePath, asset.metadataPath].map(
          (path) => `${destinationDirectory}/${path.split("/").pop()}`,
        );
        if (targets.some((path) => sourcePaths.has(path))) {
          throw new Error("One or more selected images are already in that folder.");
        }
        if (
          targets.some(
            (path) => targetPaths.has(path) || (existingPaths.has(path) && !sourcePaths.has(path)),
          )
        ) {
          throw new Error("A file with that name already exists in the destination folder.");
        }
        targets.forEach((path) => targetPaths.add(path));
      }
      const directoryTargetPaths = new Set<string>();
      for (const directoryPath of movingDirectories) {
        if (
          destinationDirectory === directoryPath ||
          destinationDirectory.startsWith(`${directoryPath}/`)
        ) {
          throw new Error("A folder cannot be moved into itself.");
        }
        const target = `${destinationDirectory}/${directoryPath.split("/").pop()}`;
        if (target === directoryPath) {
          throw new Error("One or more selected folders are already in that folder.");
        }
        if (
          directoryTargetPaths.has(target) ||
          props.directories.some(
            (directory) =>
              directory === target &&
              !movingDirectories.some(
                (movingDirectory) =>
                  directory === movingDirectory || directory.startsWith(`${movingDirectory}/`),
              ),
          )
        ) {
          throw new Error("A folder with that name already exists in the destination folder.");
        }
        directoryTargetPaths.add(target);
      }
      await props.onBeforeMove();
      const relocations = props.assets.flatMap((asset) => {
        const relocation = relocationFor(asset);
        return relocation ? [relocation] : [];
      });
      const referencePlan = await planImageLibraryReferenceUpdates({
        root: props.root,
        config: props.config,
        groups: props.groups,
        library: props.library,
        relocations,
      });
      const completedAssets: typeof assetTargets = [];
      const completedDirectories: typeof directoryTargets = [];
      try {
        for (const operation of assetTargets) {
          await invoke("move_image_library_asset", {
            libraryRoot: props.libraryRoot,
            imagePath: operation.asset.imagePath,
            metadataPath: operation.asset.metadataPath,
            destinationDirectory,
          });
          completedAssets.push(operation);
        }
        for (const operation of directoryTargets) {
          await invoke("move_image_library_directory", {
            libraryRoot: props.libraryRoot,
            directoryPath: operation.directoryPath,
            destinationDirectory,
          });
          completedDirectories.push(operation);
        }
        await applyImageLibraryReferenceUpdates(referencePlan);
      } catch (caught) {
        for (const operation of completedDirectories.reverse()) {
          await invoke("move_image_library_directory", {
            libraryRoot: props.libraryRoot,
            directoryPath: operation.target,
            destinationDirectory: dirname(operation.directoryPath),
          }).catch(() => undefined);
        }
        for (const operation of completedAssets.reverse()) {
          await invoke("move_image_library_asset", {
            libraryRoot: props.libraryRoot,
            imagePath: operation.imagePath,
            metadataPath: operation.metadataPath,
            destinationDirectory: dirname(operation.asset.metadataPath),
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

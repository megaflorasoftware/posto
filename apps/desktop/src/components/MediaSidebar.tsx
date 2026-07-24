import { useEffect, useState, type ReactNode } from "react";
import { Alert, Button, Text } from "@mantine/core";
import { FolderPlus, Upload } from "lucide-react";
import { mediaOutputPath, type MediaLibrary, type PagesConfig } from "@posto/core/pagescms/config";
import {
  CreateImageLibraryFolderDialog,
  DeleteImageLibraryAssetsDialog,
  DeleteFileMediaItemsDialog,
  FileMediaEditDialog,
  ImageLibraryBrowser,
  ImageLibraryEditDialog,
  ImageLibraryImportDialog,
  MediaLibraryTabs,
  MoveImageLibraryAssetsDialog,
  MoveFileMediaItemsDialog,
  PUBLIC_MEDIA_TAB,
  PublicMediaBrowser,
  chooseAndImportPublicMedia,
  droppedImageDirectory,
  droppedImagePaths,
  refreshImageLibraryAssets,
  useImageLibraryAssets,
  usePublicMediaFiles,
  markdownMediaKind,
  moveFileMediaItems,
  moveImageLibraryItems,
  publicMediaOutputPath,
  type MarkdownMediaPick,
  type MediaSidebarDragSource,
} from "@posto/editor";
import type { ImageLibraryAsset } from "@posto/core/project/mediaLibrary";
import { importPublicMediaFile, onFileDrop, type FileEntry, type FileGroup } from "@posto/ipc";

/** Browses one library's directories and assets (read-only, like the import
 * picker) with a sticky Import action — the desktop mirror of the mobile
 * settings Media pane. The hook only runs when a library exists. */
function LibraryMediaBrowserContent(props: {
  root: string;
  config: PagesConfig;
  groups: FileGroup[];
  library: MediaLibrary;
  tabs: ReactNode;
  onBeforeChange: () => Promise<void>;
  onChanged: (options?: { silent?: boolean }) => void;
}) {
  const [currentDirectory, setCurrentDirectory] = useState("");
  const [importing, setImporting] = useState<{
    sources?: string[];
    folder?: string;
  } | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [editing, setEditing] = useState<ImageLibraryAsset | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [selectedDirectories, setSelectedDirectories] = useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const library = props.library;
  const state = useImageLibraryAssets(props.root, library);
  const libraryRoot = `${props.root}/${library.base}`;
  const dragScope = `library:${library.collection}`;
  const mediaForAsset = (asset: ImageLibraryAsset): MarkdownMediaPick | null => {
    if (!asset.imagePath) return null;
    const input = library.base.replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
    const outputPath = mediaOutputPath(
      props.root,
      { name: dragScope, input, output: `/${input}` },
      asset.imagePath,
    );
    return outputPath
      ? {
          outputPath,
          label: asset.imagePath.split("/").pop() ?? asset.entryId,
          kind: "image",
          alt: typeof asset.metadata.alt === "string" ? asset.metadata.alt : undefined,
          library: { collection: library.collection, entryId: asset.entryId },
        }
      : null;
  };
  const dropIntoDirectory = (source: MediaSidebarDragSource, destinationDirectory: string) => {
    const movingAssets = state.assets.filter((asset) =>
      source.itemIds.includes(asset.metadataPath),
    );
    if (movingAssets.length === 0) return;
    setMoveError(null);
    void moveImageLibraryItems({
      root: props.root,
      library,
      config: props.config,
      groups: props.groups,
      libraryRoot,
      directories: state.directories,
      assets: state.assets,
      movingAssets,
      destinationDirectory,
      onBeforeMove: props.onBeforeChange,
    })
      .then(() => {
        setSelected(new Set());
        void state.refresh();
        props.onChanged();
      })
      .catch((caught) => setMoveError(caught instanceof Error ? caught.message : String(caught)));
  };

  useEffect(() => {
    if (importing) return;
    const droppedDirectory = (paths: string[], pointer: { x: number; y: number } | null) =>
      droppedImageDirectory(paths, pointer, libraryRoot, (x, y) => document.elementFromPoint(x, y));
    return onFileDrop(
      (paths, details) => {
        const directory = droppedDirectory(paths, details.pointer);
        if (!directory) return;
        setImporting({
          sources: droppedImagePaths(paths),
          folder: directory.slice(libraryRoot.length).replace(/^\/+/, ""),
        });
      },
      {
        priority: 60,
        accepts: (paths, details) => droppedDirectory(paths, details.pointer) !== null,
      },
    );
  }, [importing, libraryRoot]);

  return (
    <div className="media-drawer">
      <div className="media-drawer-scroll">
        {state.error && (
          <Text c="red" size="sm">
            Could not read image library: {state.error}
          </Text>
        )}
        {moveError && (
          <Alert color="red" mb="sm">
            {moveError}
          </Alert>
        )}
        <ImageLibraryBrowser
          rootDirectory={libraryRoot}
          currentDirectory={currentDirectory}
          directories={state.directories}
          assets={state.assets}
          toolbar={props.tabs}
          onDirectoryChange={setCurrentDirectory}
          onEdit={setEditing}
          onDelete={(asset) => {
            setSelected(new Set([asset.metadataPath]));
            setSelectedDirectories(new Set());
            setDeleting(true);
          }}
          dragPayload={(asset) => {
            const dragged = selected.has(asset.metadataPath)
              ? state.assets.filter(
                  (candidate) =>
                    selected.has(candidate.metadataPath) && candidate.health.includes("valid"),
                )
              : [asset];
            const media = dragged.flatMap((candidate) => {
              const pick = mediaForAsset(candidate);
              return pick ? [pick] : [];
            });
            return media.length > 0
              ? {
                  media,
                  source: {
                    kind: "media-sidebar",
                    scope: dragScope,
                    itemIds: dragged.map((candidate) => candidate.metadataPath),
                  },
                }
              : null;
          }}
          dropScope={dragScope}
          onDropToDirectory={dropIntoDirectory}
          inlineSelection
          selectedAssetIds={selected}
          selectedDirectoryPaths={selectedDirectories}
          onToggleSelection={(asset) =>
            setSelected((current) => {
              const next = new Set(current);
              if (next.has(asset.metadataPath)) next.delete(asset.metadataPath);
              else next.add(asset.metadataPath);
              return next;
            })
          }
          onToggleDirectorySelection={(directory) => {
            setSelectedDirectories((current) => {
              const next = new Set(current);
              if (next.has(directory)) next.delete(directory);
              else {
                for (const selectedDirectory of next) {
                  if (selectedDirectory.startsWith(`${directory}/`)) next.delete(selectedDirectory);
                }
                next.add(directory);
              }
              return next;
            });
            setSelected(
              (current) =>
                new Set(
                  [...current].filter((metadataPath) => !metadataPath.startsWith(`${directory}/`)),
                ),
            );
          }}
        />
      </div>
      <div className="media-drawer-footer">
        {selected.size + selectedDirectories.size > 0 ? (
          <div className="media-selection-actions">
            <Button fullWidth variant="default" onClick={() => setMoving(true)}>
              Move items
            </Button>
            <Button fullWidth color="red" onClick={() => setDeleting(true)}>
              Delete items
            </Button>
          </div>
        ) : (
          <div className="media-primary-actions">
            <Button
              fullWidth
              variant="default"
              leftSection={<FolderPlus size={16} />}
              onClick={() => setCreatingFolder(true)}
            >
              New folder
            </Button>
            <Button fullWidth leftSection={<Upload size={16} />} onClick={() => setImporting({})}>
              Import images
            </Button>
          </div>
        )}
      </div>
      {creatingFolder && (
        <CreateImageLibraryFolderDialog
          libraryRoot={libraryRoot}
          currentDirectory={currentDirectory}
          onClose={() => setCreatingFolder(false)}
          onCreated={() => void state.refresh()}
        />
      )}
      {editing && (
        <ImageLibraryEditDialog
          root={props.root}
          library={library}
          config={props.config}
          groups={props.groups}
          asset={editing}
          onBeforeChange={props.onBeforeChange}
          onClose={() => setEditing(null)}
          onChanged={(options) => {
            void state.refresh();
            props.onChanged(options);
          }}
        />
      )}
      {deleting && (
        <DeleteImageLibraryAssetsDialog
          libraryRoot={libraryRoot}
          assets={state.assets.filter((asset) => selected.has(asset.metadataPath))}
          directories={[...selectedDirectories]}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setSelected(new Set());
            setSelectedDirectories(new Set());
            void state.refresh();
            props.onChanged({ silent: true });
          }}
        />
      )}
      {moving && (
        <MoveImageLibraryAssetsDialog
          root={props.root}
          library={library}
          config={props.config}
          groups={props.groups}
          libraryRoot={libraryRoot}
          directories={state.directories}
          assets={state.assets}
          movingAssets={state.assets.filter((asset) => selected.has(asset.metadataPath))}
          movingDirectories={[...selectedDirectories]}
          onClose={() => setMoving(false)}
          onBeforeMove={props.onBeforeChange}
          onRefresh={() => void state.refresh()}
          onMoved={() => {
            setSelected(new Set());
            setSelectedDirectories(new Set());
            void state.refresh();
            props.onChanged();
          }}
        />
      )}
      {importing && (
        <ImageLibraryImportDialog
          root={props.root}
          library={library}
          libraries={props.config.mediaLibraries ?? [library]}
          config={props.config}
          groups={props.groups}
          sourcePaths={importing.sources}
          initialFolder={importing.folder}
          skipLocationSelection={!!importing.sources?.length}
          onClose={() => setImporting(null)}
          onImported={(_result, importedLibrary) => {
            void refreshImageLibraryAssets(props.root, importedLibrary);
            props.onChanged();
          }}
          onPublicImported={() => props.onChanged()}
        />
      )}
    </div>
  );
}

function PublicMediaBrowserContent(props: {
  root: string;
  groups: FileGroup[];
  tabs: ReactNode;
  onBeforeChange: () => Promise<void>;
  onChanged: (options?: { silent?: boolean }) => void;
}) {
  const state = usePublicMediaFiles(props.root);
  const [currentDirectory, setCurrentDirectory] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [selectedDirectories, setSelectedDirectories] = useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const [moving, setMoving] = useState(false);
  const [editing, setEditing] = useState<FileEntry | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const dragScope = "public";

  const importFiles = async () => {
    setImporting(true);
    setError(null);
    try {
      const imported = await chooseAndImportPublicMedia(props.root, currentDirectory);
      if (imported.length > 0) {
        await state.refresh();
        props.onChanged();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setImporting(false);
    }
  };
  useEffect(() => {
    if (importing) return;
    const droppedDirectory = (paths: string[], pointer: { x: number; y: number } | null) =>
      droppedImageDirectory(paths, pointer, state.publicRoot, (x, y) =>
        document.elementFromPoint(x, y),
      );
    return onFileDrop(
      (paths, details) => {
        const directory = droppedDirectory(paths, details.pointer);
        if (!directory) return;
        setImporting(true);
        setError(null);
        const relativeDirectory = directory.slice(state.publicRoot.length).replace(/^\/+/, "");
        void (async () => {
          try {
            for (const sourceFilePath of droppedImagePaths(paths)) {
              await importPublicMediaFile({
                repositoryRoot: props.root,
                sourceFilePath,
                directory: relativeDirectory,
              });
            }
            await state.refresh();
            props.onChanged();
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
          } finally {
            setImporting(false);
          }
        })();
      },
      {
        priority: 60,
        accepts: (paths, details) => droppedDirectory(paths, details.pointer) !== null,
      },
    );
  }, [importing, props.root, state.publicRoot]);
  const mediaForFile = (file: FileEntry): MarkdownMediaPick | null => {
    if (markdownMediaKind(file.path) !== "image") return null;
    const outputPath = publicMediaOutputPath(props.root, file.path);
    return outputPath ? { outputPath, label: file.name, kind: "image" } : null;
  };
  const dropIntoDirectory = (source: MediaSidebarDragSource, destinationDirectory: string) => {
    const movingFiles = state.files.filter((file) => source.itemIds.includes(file.path));
    if (movingFiles.length === 0) return;
    setMoveError(null);
    void moveFileMediaItems({
      root: props.root,
      mediaRoot: state.publicRoot,
      groups: props.groups,
      directories: state.directories,
      files: state.files,
      movingFiles,
      destinationDirectory,
      onBeforeChange: props.onBeforeChange,
    })
      .then(() => {
        setSelected(new Set());
        void state.refresh();
        props.onChanged();
      })
      .catch((caught) => setMoveError(caught instanceof Error ? caught.message : String(caught)));
  };

  return (
    <div className="media-drawer">
      <div className="media-drawer-scroll">
        {(error || state.error) && (
          <Alert color="red" mb="sm">
            {error ?? `Could not read public media: ${state.error}`}
          </Alert>
        )}
        {moveError && (
          <Alert color="red" mb="sm">
            {moveError}
          </Alert>
        )}
        <PublicMediaBrowser
          rootDirectory={state.publicRoot}
          currentDirectory={currentDirectory}
          directories={state.directories}
          files={state.files}
          toolbar={props.tabs}
          onDirectoryChange={setCurrentDirectory}
          onEdit={setEditing}
          onDelete={(file) => {
            setSelected(new Set([file.path]));
            setSelectedDirectories(new Set());
            setDeleting(true);
          }}
          dragPayload={(file) => {
            const dragged = selected.has(file.path)
              ? state.files.filter(
                  (candidate) =>
                    selected.has(candidate.path) && markdownMediaKind(candidate.path) === "image",
                )
              : [file];
            const media = dragged.flatMap((candidate) => {
              const pick = mediaForFile(candidate);
              return pick ? [pick] : [];
            });
            return media.length > 0
              ? {
                  media,
                  source: {
                    kind: "media-sidebar",
                    scope: dragScope,
                    itemIds: dragged.map((candidate) => candidate.path),
                  },
                }
              : null;
          }}
          dropScope={dragScope}
          onDropToDirectory={dropIntoDirectory}
          inlineSelection
          selectedFilePaths={selected}
          selectedDirectoryPaths={selectedDirectories}
          onToggleFileSelection={(file) =>
            setSelected((current) => {
              const next = new Set(current);
              if (next.has(file.path)) next.delete(file.path);
              else next.add(file.path);
              return next;
            })
          }
          onToggleDirectorySelection={(directory) => {
            setSelectedDirectories((current) => {
              const next = new Set(current);
              if (next.has(directory)) next.delete(directory);
              else {
                for (const selectedDirectory of next) {
                  if (selectedDirectory.startsWith(`${directory}/`)) next.delete(selectedDirectory);
                }
                next.add(directory);
              }
              return next;
            });
            setSelected(
              (current) =>
                new Set([...current].filter((path) => !path.startsWith(`${directory}/`))),
            );
          }}
        />
      </div>
      <div className="media-drawer-footer">
        {selected.size + selectedDirectories.size > 0 ? (
          <div className="media-selection-actions">
            <Button fullWidth variant="default" onClick={() => setMoving(true)}>
              Move items
            </Button>
            <Button fullWidth color="red" onClick={() => setDeleting(true)}>
              Delete items
            </Button>
          </div>
        ) : (
          <div className="media-primary-actions">
            <Button
              fullWidth
              variant="default"
              leftSection={<FolderPlus size={16} />}
              onClick={() => setCreatingFolder(true)}
            >
              New folder
            </Button>
            <Button
              fullWidth
              leftSection={<Upload size={16} />}
              loading={importing}
              onClick={() => void importFiles()}
            >
              Import files
            </Button>
          </div>
        )}
      </div>
      {creatingFolder && (
        <CreateImageLibraryFolderDialog
          libraryRoot={state.publicRoot}
          repositoryRoot={props.root}
          currentDirectory={currentDirectory}
          onClose={() => setCreatingFolder(false)}
          onCreated={() => {
            void state.refresh();
            props.onChanged();
          }}
        />
      )}
      {deleting && (
        <DeleteFileMediaItemsDialog
          mediaRoot={state.publicRoot}
          files={state.files.filter((file) => selected.has(file.path))}
          directories={[...selectedDirectories]}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setSelected(new Set());
            setSelectedDirectories(new Set());
            void state.refresh();
            props.onChanged({ silent: true });
          }}
        />
      )}
      {editing && (
        <FileMediaEditDialog
          root={props.root}
          mediaRoot={state.publicRoot}
          groups={props.groups}
          file={editing}
          onBeforeChange={props.onBeforeChange}
          onClose={() => setEditing(null)}
          onChanged={(options) => {
            void state.refresh();
            props.onChanged(options);
          }}
        />
      )}
      {moving && (
        <MoveFileMediaItemsDialog
          root={props.root}
          mediaRoot={state.publicRoot}
          groups={props.groups}
          directories={state.directories}
          files={state.files}
          movingFiles={state.files.filter((file) => selected.has(file.path))}
          movingDirectories={[...selectedDirectories]}
          onBeforeChange={props.onBeforeChange}
          onClose={() => setMoving(false)}
          onRefresh={() => void state.refresh()}
          onMoved={() => {
            setSelected(new Set());
            setSelectedDirectories(new Set());
            void state.refresh();
            props.onChanged();
          }}
        />
      )}
    </div>
  );
}

function MediaBrowserContent(props: {
  root: string;
  config: PagesConfig;
  groups: FileGroup[];
  libraries: MediaLibrary[];
  onBeforeChange: () => Promise<void>;
  onChanged: (options?: { silent?: boolean }) => void;
}) {
  const [selected, setSelected] = useState(props.libraries[0]?.collection ?? PUBLIC_MEDIA_TAB);
  const library = props.libraries.find((candidate) => candidate.collection === selected);
  const effectiveSelected = library ? selected : PUBLIC_MEDIA_TAB;
  const tabs = (
    <MediaLibraryTabs
      libraries={props.libraries}
      selected={effectiveSelected}
      onSelect={setSelected}
    />
  );
  return library ? (
    <LibraryMediaBrowserContent
      key={library.collection}
      root={props.root}
      config={props.config}
      groups={props.groups}
      library={library}
      tabs={tabs}
      onBeforeChange={props.onBeforeChange}
      onChanged={props.onChanged}
    />
  ) : (
    <PublicMediaBrowserContent
      key={PUBLIC_MEDIA_TAB}
      root={props.root}
      groups={props.groups}
      tabs={tabs}
      onBeforeChange={props.onBeforeChange}
      onChanged={(options) => props.onChanged(options)}
    />
  );
}

/** Media browser shown as one of the left sidebar's two views. */
export function MediaSidebar(props: {
  root: string;
  config: PagesConfig;
  groups: FileGroup[];
  libraries: MediaLibrary[];
  onBeforeChange: () => Promise<void>;
  onChanged: (options?: { silent?: boolean }) => void;
}) {
  return (
    <MediaBrowserContent
      root={props.root}
      config={props.config}
      groups={props.groups}
      libraries={props.libraries}
      onBeforeChange={props.onBeforeChange}
      onChanged={props.onChanged}
    />
  );
}

import { useState, type ReactNode } from "react";
import { Alert, Button, Text } from "@mantine/core";
import { FolderPlus, MousePointer2, Upload } from "lucide-react";
import type { MediaLibrary, PagesConfig } from "@posto/core/pagescms/config";
import type { ImageLibraryAsset } from "@posto/core/project/mediaLibrary";
import type { FileEntry, FileGroup } from "@posto/ipc";
import {
  CreateImageLibraryFolderDialog,
  DeleteFileMediaItemsDialog,
  DeleteImageLibraryAssetsDialog,
  FileMediaEditDialog,
  ImageLibraryBrowser,
  ImageLibraryEditDialog,
  MediaLibraryTabs,
  MoveFileMediaItemsDialog,
  MoveImageLibraryAssetsDialog,
  PUBLIC_MEDIA_TAB,
  PublicMediaBrowser,
  chooseAndImportPublicMedia,
  useImageLibraryAssets,
  usePublicMediaFiles,
} from "@posto/editor";

/** Mobile image-library browser with the shared grid and sticky actions. */
function LibraryMediaPane(props: {
  root: string;
  config: PagesConfig;
  groups: FileGroup[];
  library: MediaLibrary;
  tabs: ReactNode;
  onImport: (library: MediaLibrary) => void;
  onBeforeChange: () => Promise<void>;
  onChanged: (library: MediaLibrary, options?: { silent?: boolean }) => void;
}) {
  const [currentDirectory, setCurrentDirectory] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [editing, setEditing] = useState<ImageLibraryAsset | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [selectedDirectories, setSelectedDirectories] = useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const [moving, setMoving] = useState(false);
  const library = props.library;
  const libraryState = useImageLibraryAssets(props.root, library);
  const libraryRoot = `${props.root}/${library.base}`;

  return (
    <div className="mobile-media-pane">
      <div className="mobile-media-pane-scroll">
        {libraryState.error && (
          <Text c="red" size="sm">
            Could not read image library: {libraryState.error}
          </Text>
        )}
        <ImageLibraryBrowser
          rootDirectory={libraryRoot}
          currentDirectory={currentDirectory}
          directories={libraryState.directories}
          assets={libraryState.assets}
          toolbar={props.tabs}
          onDirectoryChange={setCurrentDirectory}
          onEdit={setEditing}
          selectionMode={selectionMode}
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
      <div className="mobile-media-pane-footer">
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
            <div className="media-secondary-actions">
              <Button
                fullWidth
                variant={selectionMode ? "light" : "default"}
                leftSection={<MousePointer2 size={18} />}
                onClick={() => {
                  setSelected(new Set());
                  setSelectedDirectories(new Set());
                  setSelectionMode((current) => !current);
                }}
              >
                Select
              </Button>
              <Button
                fullWidth
                variant="default"
                leftSection={<FolderPlus size={18} />}
                onClick={() => setCreatingFolder(true)}
              >
                New folder
              </Button>
            </div>
            <Button
              fullWidth
              leftSection={<Upload size={18} />}
              onClick={() => props.onImport(library)}
            >
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
          onCreated={() => void libraryState.refresh()}
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
            void libraryState.refresh();
            props.onChanged(library, options);
          }}
        />
      )}
      {deleting && (
        <DeleteImageLibraryAssetsDialog
          libraryRoot={libraryRoot}
          assets={libraryState.assets.filter((asset) => selected.has(asset.metadataPath))}
          directories={[...selectedDirectories]}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setSelected(new Set());
            setSelectedDirectories(new Set());
            setSelectionMode(false);
            void libraryState.refresh();
            props.onChanged(library, { silent: true });
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
          directories={libraryState.directories}
          assets={libraryState.assets}
          movingAssets={libraryState.assets.filter((asset) => selected.has(asset.metadataPath))}
          movingDirectories={[...selectedDirectories]}
          onClose={() => setMoving(false)}
          onBeforeMove={props.onBeforeChange}
          onRefresh={() => void libraryState.refresh()}
          onMoved={() => {
            setSelected(new Set());
            setSelectedDirectories(new Set());
            setSelectionMode(false);
            void libraryState.refresh();
            props.onChanged(library);
          }}
        />
      )}
    </div>
  );
}

function PublicMediaPane(props: {
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
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [selectedDirectories, setSelectedDirectories] = useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const [moving, setMoving] = useState(false);
  const [editing, setEditing] = useState<FileEntry | null>(null);

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

  return (
    <div className="mobile-media-pane">
      <div className="mobile-media-pane-scroll">
        {(error || state.error) && (
          <Alert color="red" m="xs">
            {error ?? `Could not read public media: ${state.error}`}
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
          selectionMode={selectionMode}
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
      <div className="mobile-media-pane-footer">
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
            <div className="media-secondary-actions">
              <Button
                fullWidth
                variant={selectionMode ? "light" : "default"}
                leftSection={<MousePointer2 size={18} />}
                onClick={() => {
                  setSelected(new Set());
                  setSelectedDirectories(new Set());
                  setSelectionMode((current) => !current);
                }}
              >
                Select
              </Button>
              <Button
                fullWidth
                variant="default"
                leftSection={<FolderPlus size={18} />}
                onClick={() => setCreatingFolder(true)}
              >
                New folder
              </Button>
            </div>
            <Button
              fullWidth
              leftSection={<Upload size={18} />}
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
            setSelectionMode(false);
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
            setSelectionMode(false);
            void state.refresh();
            props.onChanged();
          }}
        />
      )}
    </div>
  );
}

export function MediaLibraryPane(props: {
  root: string;
  config: PagesConfig;
  groups: FileGroup[];
  libraries: MediaLibrary[];
  onImport: (library: MediaLibrary) => void;
  onBeforeChange: () => Promise<void>;
  onChanged: (library: MediaLibrary | null, options?: { silent?: boolean }) => void;
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
    <LibraryMediaPane
      key={library.collection}
      root={props.root}
      config={props.config}
      groups={props.groups}
      library={library}
      tabs={tabs}
      onImport={props.onImport}
      onBeforeChange={props.onBeforeChange}
      onChanged={(changedLibrary, options) => props.onChanged(changedLibrary, options)}
    />
  ) : (
    <PublicMediaPane
      key={PUBLIC_MEDIA_TAB}
      root={props.root}
      groups={props.groups}
      tabs={tabs}
      onBeforeChange={props.onBeforeChange}
      onChanged={(options) => props.onChanged(null, options)}
    />
  );
}

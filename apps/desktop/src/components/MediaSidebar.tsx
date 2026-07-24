import { useState } from "react";
import { Button, Select, Text } from "@mantine/core";
import { FolderPlus, Upload } from "lucide-react";
import type { MediaLibrary, PagesConfig } from "@posto/core/pagescms/config";
import {
  CreateImageLibraryFolderDialog,
  DeleteImageLibraryAssetsDialog,
  ImageLibraryBrowser,
  ImageLibraryEditDialog,
  ImageLibraryImportDialog,
  MoveImageLibraryAssetsDialog,
  refreshImageLibraryAssets,
  useImageLibraryAssets,
} from "@posto/editor";
import type { ImageLibraryAsset } from "@posto/core/project/mediaLibrary";
import type { FileGroup } from "@posto/ipc";

/** Browses one library's directories and assets (read-only, like the import
 * picker) with a sticky Import action — the desktop mirror of the mobile
 * settings Media pane. The hook only runs when a library exists. */
function MediaBrowserContent(props: {
  root: string;
  config: PagesConfig;
  groups: FileGroup[];
  libraries: MediaLibrary[];
  onBeforeChange: () => Promise<void>;
  onChanged: () => void;
}) {
  const [libraryIndex, setLibraryIndex] = useState(0);
  const [currentDirectory, setCurrentDirectory] = useState("");
  const [importing, setImporting] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [editing, setEditing] = useState<ImageLibraryAsset | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [selectedDirectories, setSelectedDirectories] = useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const [moving, setMoving] = useState(false);
  const library = props.libraries[libraryIndex] ?? props.libraries[0];
  const state = useImageLibraryAssets(props.root, library);
  const libraryRoot = `${props.root}/${library.base}`;

  return (
    <div className="media-drawer">
      <div className="media-drawer-scroll">
        {props.libraries.length > 1 && (
          <Select
            size="xs"
            mb="sm"
            allowDeselect={false}
            data={props.libraries.map((entry, index) => ({
              value: String(index),
              label: entry.collection,
            }))}
            value={String(libraryIndex)}
            onChange={(value) => {
              setLibraryIndex(Number(value ?? 0));
              setCurrentDirectory("");
              setSelectionMode(false);
              setSelected(new Set());
              setSelectedDirectories(new Set());
            }}
          />
        )}
        {state.error ? (
          <Text c="red" size="sm">
            Could not read image library: {state.error}
          </Text>
        ) : (
          <ImageLibraryBrowser
            rootDirectory={libraryRoot}
            currentDirectory={currentDirectory}
            directories={state.directories}
            assets={state.assets}
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
                    if (selectedDirectory.startsWith(`${directory}/`))
                      next.delete(selectedDirectory);
                  }
                  next.add(directory);
                }
                return next;
              });
              setSelected(
                (current) =>
                  new Set(
                    [...current].filter(
                      (metadataPath) => !metadataPath.startsWith(`${directory}/`),
                    ),
                  ),
              );
            }}
          />
        )}
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
            <div className="media-secondary-actions">
              <Button
                fullWidth
                variant={selectionMode ? "light" : "default"}
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
                leftSection={<FolderPlus size={16} />}
                onClick={() => setCreatingFolder(true)}
              >
                New folder
              </Button>
            </div>
            <Button fullWidth leftSection={<Upload size={16} />} onClick={() => setImporting(true)}>
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
          onChanged={() => {
            void state.refresh();
            props.onChanged();
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
            setSelectionMode(false);
            void state.refresh();
            props.onChanged();
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
            setSelectionMode(false);
            void state.refresh();
            props.onChanged();
          }}
        />
      )}
      {importing && (
        <ImageLibraryImportDialog
          root={props.root}
          library={library}
          config={props.config}
          groups={props.groups}
          onClose={() => setImporting(false)}
          onImported={() => {
            void refreshImageLibraryAssets(props.root, library);
            props.onChanged();
          }}
        />
      )}
    </div>
  );
}

/** Media-library browser shown as one of the left sidebar's two views. */
export function MediaSidebar(props: {
  root: string;
  config: PagesConfig;
  groups: FileGroup[];
  libraries: MediaLibrary[];
  onBeforeChange: () => Promise<void>;
  onChanged: () => void;
}) {
  if (props.libraries.length === 0) {
    return (
      <Text c="dimmed" size="sm" p="md">
        No media libraries found.
      </Text>
    );
  }
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

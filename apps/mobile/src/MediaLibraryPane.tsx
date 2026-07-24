import { useState } from "react";
import { Button, Select, Text } from "@mantine/core";
import { FolderPlus, Upload } from "lucide-react";
import type { MediaLibrary, PagesConfig } from "@posto/core/pagescms/config";
import type { ImageLibraryAsset } from "@posto/core/project/mediaLibrary";
import type { FileGroup } from "@posto/ipc";
import {
  CreateImageLibraryFolderDialog,
  DeleteImageLibraryAssetsDialog,
  ImageLibraryBrowser,
  ImageLibraryEditDialog,
  MoveImageLibraryAssetsDialog,
  useImageLibraryAssets,
} from "@posto/editor";

/** Read-only mobile media browser: the same directory/asset grid as the import
 * picker, minus the tap-to-pick affordance, with a sticky Import action. The
 * caller only renders this when at least one image library exists. */
export function MediaLibraryPane(props: {
  root: string;
  config: PagesConfig;
  groups: FileGroup[];
  libraries: MediaLibrary[];
  onImport: (library: MediaLibrary) => void;
  onChanged: (library: MediaLibrary) => void;
}) {
  const [libraryIndex, setLibraryIndex] = useState(0);
  const [currentDirectory, setCurrentDirectory] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [editing, setEditing] = useState<ImageLibraryAsset | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [selectedDirectories, setSelectedDirectories] = useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const [moving, setMoving] = useState(false);
  const library = props.libraries[libraryIndex] ?? props.libraries[0];
  const libraryState = useImageLibraryAssets(props.root, library);
  const libraryRoot = `${props.root}/${library.base}`;

  return (
    <div className="mobile-media-pane">
      <div className="mobile-media-pane-scroll">
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
        {libraryState.error ? (
          <Text c="red" size="sm">
            Could not read image library: {libraryState.error}
          </Text>
        ) : (
          <ImageLibraryBrowser
            rootDirectory={libraryRoot}
            currentDirectory={currentDirectory}
            directories={libraryState.directories}
            assets={libraryState.assets}
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
          onClose={() => setEditing(null)}
          onChanged={() => {
            void libraryState.refresh();
            props.onChanged(library);
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
            props.onChanged(library);
          }}
        />
      )}
      {moving && (
        <MoveImageLibraryAssetsDialog
          libraryRoot={libraryRoot}
          directories={libraryState.directories}
          assets={libraryState.assets}
          movingAssets={libraryState.assets.filter((asset) => selected.has(asset.metadataPath))}
          movingDirectories={[...selectedDirectories]}
          onClose={() => setMoving(false)}
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

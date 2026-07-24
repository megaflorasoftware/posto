import { useState } from "react";
import { Button, Select, Text } from "@mantine/core";
import { Upload } from "lucide-react";
import type { MediaLibrary, PagesConfig } from "@posto/core/pagescms/config";
import {
  ImageLibraryBrowser,
  ImageLibraryImportDialog,
  refreshImageLibraryAssets,
  useImageLibraryAssets,
} from "@posto/editor";
import type { FileGroup } from "@posto/ipc";

/** Browses one library's directories and assets (read-only, like the import
 * picker) with a sticky Import action — the desktop mirror of the mobile
 * settings Media pane. The hook only runs when a library exists. */
function MediaBrowserContent(props: {
  root: string;
  config: PagesConfig;
  groups: FileGroup[];
  libraries: MediaLibrary[];
  onImported: () => void;
}) {
  const [libraryIndex, setLibraryIndex] = useState(0);
  const [currentDirectory, setCurrentDirectory] = useState("");
  const [importing, setImporting] = useState(false);
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
          />
        )}
      </div>
      <div className="media-drawer-footer">
        <Button fullWidth leftSection={<Upload size={16} />} onClick={() => setImporting(true)}>
          Import images
        </Button>
      </div>
      {importing && (
        <ImageLibraryImportDialog
          root={props.root}
          library={library}
          config={props.config}
          groups={props.groups}
          onClose={() => setImporting(false)}
          onImported={() => {
            void refreshImageLibraryAssets(props.root, library);
            props.onImported();
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
  onImported: () => void;
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
      onImported={props.onImported}
    />
  );
}

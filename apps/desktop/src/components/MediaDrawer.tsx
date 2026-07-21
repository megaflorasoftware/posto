import { useState } from "react";
import { Button, Drawer, Select, Text } from "@mantine/core";
import { Upload } from "lucide-react";
import type { AstroImageLibrary, PagesConfig } from "@posto/core/pagescms/config";
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
function MediaBrowser(props: {
  root: string;
  config: PagesConfig;
  groups: FileGroup[];
  libraries: AstroImageLibrary[];
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
          <Text c="red" size="sm">Could not read image library: {state.error}</Text>
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

/** Right-side drawer holding the media grid, opened from the header's image
 * button. */
export function MediaDrawer(props: {
  opened: boolean;
  onClose: () => void;
  root: string;
  config: PagesConfig;
  groups: FileGroup[];
  onImported: () => void;
}) {
  const libraries = props.config.imageLibraries ?? [];
  return (
    <Drawer
      opened={props.opened}
      onClose={props.onClose}
      position="right"
      size={520}
      title="Media"
      classNames={{ content: "media-drawer-content", body: "media-drawer-body" }}
    >
      {libraries.length === 0 ? (
        <Text c="dimmed" size="sm" p="md">No Astro image libraries found.</Text>
      ) : (
        <MediaBrowser
          root={props.root}
          config={props.config}
          groups={props.groups}
          libraries={libraries}
          onImported={props.onImported}
        />
      )}
    </Drawer>
  );
}

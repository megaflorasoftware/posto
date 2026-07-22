import { useState } from "react";
import { Button, Select, Text } from "@mantine/core";
import { Upload } from "lucide-react";
import type { MediaLibrary } from "@posto/core/pagescms/config";
import { ImageLibraryBrowser, useImageLibraryAssets } from "@posto/editor";

/** Read-only mobile media browser: the same directory/asset grid as the import
 * picker, minus the tap-to-pick affordance, with a sticky Import action. The
 * caller only renders this when at least one image library exists. */
export function MediaLibraryPane(props: {
  root: string;
  libraries: MediaLibrary[];
  onImport: (library: MediaLibrary) => void;
}) {
  const [libraryIndex, setLibraryIndex] = useState(0);
  const [currentDirectory, setCurrentDirectory] = useState("");
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
          />
        )}
      </div>
      <div className="mobile-media-pane-footer">
        <Button
          fullWidth
          leftSection={<Upload size={18} />}
          onClick={() => props.onImport(library)}
        >
          Import images
        </Button>
      </div>
    </div>
  );
}

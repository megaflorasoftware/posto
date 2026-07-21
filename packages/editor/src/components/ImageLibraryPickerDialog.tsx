import { useState } from "react";
import { Alert, Button } from "@mantine/core";
import type { ImageLibraryAsset } from "@posto/core/astro/imageLibrary";
import type { AstroImageLibrary } from "@posto/core/pagescms/config";
import { openPath } from "@posto/ipc";
import { Dialog } from "./Dialog";
import { ImageLibraryBrowser } from "./ImageLibraryBrowser";

export function ImageLibraryPickerDialog(props: {
  root: string;
  library: AstroImageLibrary;
  assets: ImageLibraryAsset[];
  directories: string[];
  directory?: string;
  error?: string | null;
  onClose: () => void;
  onPick: (asset: ImageLibraryAsset) => void;
  onImport: () => void;
}) {
  const directory = props.directory ?? `${props.root}/${props.library.base}`;
  const [currentDirectory, setCurrentDirectory] = useState("");
  const openDirectory = currentDirectory ? `${directory}/${currentDirectory}` : directory;
  return (
    <Dialog
      opened
      onClose={props.onClose}
      title={`Choose from ${props.library.collection}`}
      size="xl"
    >
      {props.error && (
        <Alert color="red" mb="sm">
          {props.error}
        </Alert>
      )}
      <ImageLibraryBrowser
        rootDirectory={directory}
        currentDirectory={currentDirectory}
        directories={props.directories}
        assets={props.assets}
        onDirectoryChange={setCurrentDirectory}
        onPick={props.onPick}
      />
      <div className="image-library-picker-actions">
        <Button
          className="image-library-open-directory"
          fullWidth
          variant="outline"
          onClick={() => void openPath(openDirectory)}
        >
          Open Media Library
        </Button>
        <Button fullWidth onClick={props.onImport}>
          Import image
        </Button>
      </div>
    </Dialog>
  );
}

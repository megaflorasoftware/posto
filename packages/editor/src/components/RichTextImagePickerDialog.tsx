import { useState } from "react";
import { Alert, Select } from "@mantine/core";
import {
  imageLibraryContainsAsset,
  resolveImageLibraryLocation,
} from "@posto/core/astro/imageLibrary";
import {
  expandMediaEntry,
  mediaOutputPath,
  type AstroImageLibrary,
  type MediaEntry,
  type PagesConfig,
} from "@posto/core/pagescms/config";
import { useImageLibraryAssets } from "../hooks/useImageLibraryAssets";
import { Dialog } from "./Dialog";
import { ImageLibraryPickerDialog } from "./ImageLibraryPickerDialog";

function defaultMedia(library: AstroImageLibrary): MediaEntry {
  const input = library.base.replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
  return { name: `astro:${library.collection}`, input, output: `/${input}` };
}

function LibraryGrid(props: {
  root: string;
  library: AstroImageLibrary;
  subset: string;
  media: MediaEntry;
  onClose: () => void;
  onPick: (outputPath: string) => void;
}) {
  const state = useImageLibraryAssets(props.root, props.library);
  const assets = state.assets.filter((asset) =>
    imageLibraryContainsAsset(props.library, props.root, asset, props.subset),
  );
  const directory = `${props.root}/${props.library.base}${props.subset ? `/${props.subset}` : ""}`;
  return (
    <ImageLibraryPickerDialog
      root={props.root}
      library={props.library}
      assets={assets}
      directory={directory}
      error={state.error}
      onClose={props.onClose}
      onPick={(asset) => {
        const output = asset.imagePath
          ? mediaOutputPath(props.root, props.media, asset.imagePath)
          : null;
        if (output) props.onPick(output);
      }}
    />
  );
}

/** Image insertion for Markdown/MDX bodies. An explicit collection mediaDir
 * selects a library (or subset); otherwise authors choose a discovered one. */
export function RichTextImagePickerDialog(props: {
  root: string;
  config: PagesConfig;
  configuredMedia: MediaEntry | null;
  templateValues: Record<string, unknown>;
  onClose: () => void;
  onPick: (outputPath: string) => void;
}) {
  const libraries = props.config.imageLibraries ?? [];
  const expandedMedia = props.configuredMedia
    ? expandMediaEntry(props.configuredMedia, props.templateValues)
    : null;
  const configured = expandedMedia
    ? resolveImageLibraryLocation(libraries, expandedMedia.input)
    : null;
  const [selectedCollection, setSelectedCollection] = useState<string | null>(null);

  if (props.configuredMedia && !expandedMedia) {
    return (
      <Dialog opened onClose={props.onClose} title="Choose image" size="lg">
        <Alert color="red">
          This collection’s media-library template cannot be resolved until its referenced fields have values.
        </Alert>
      </Dialog>
    );
  }

  if (expandedMedia && !configured) {
    return (
      <Dialog opened onClose={props.onClose} title="Choose image" size="lg">
        <Alert color="red">
          This collection’s configured media folder ({expandedMedia.input}) is not a recognized Astro image library or an included subfolder of one.
        </Alert>
      </Dialog>
    );
  }

  if (configured && expandedMedia) {
    return (
      <LibraryGrid
        root={props.root}
        library={configured.library}
        subset={configured.subset}
        media={expandedMedia}
        onClose={props.onClose}
        onPick={props.onPick}
      />
    );
  }

  const selected = libraries.find((library) => library.collection === selectedCollection) ?? null;
  if (selected) {
    return (
      <LibraryGrid
        root={props.root}
        library={selected}
        subset=""
        media={defaultMedia(selected)}
        onClose={props.onClose}
        onPick={props.onPick}
      />
    );
  }

  return (
    <Dialog opened onClose={props.onClose} title="Choose image library" size="sm">
      {libraries.length === 0 ? (
        <Alert color="red">This project has no recognized Astro image libraries.</Alert>
      ) : (
        <Select
          label="Image library"
          placeholder="Choose a library"
          data={libraries.map((library) => ({ value: library.collection, label: library.collection }))}
          value={selectedCollection}
          onChange={setSelectedCollection}
        />
      )}
    </Dialog>
  );
}

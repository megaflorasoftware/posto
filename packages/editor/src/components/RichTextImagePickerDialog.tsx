import { useState } from "react";
import { Alert } from "@mantine/core";
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
import type { FileGroup } from "@posto/ipc";
import { useImageLibraryAssets } from "../hooks/useImageLibraryAssets";
import { Dialog } from "./Dialog";
import { ImageLibraryImportDialog } from "./ImageLibraryImportDialog";
import { ImageLibraryList } from "./ImageLibraryList";
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
  config: PagesConfig;
  groups: FileGroup[];
  onClose: () => void;
  onPick: (outputPath: string) => void;
}) {
  const [importOpen, setImportOpen] = useState(false);
  const state = useImageLibraryAssets(props.root, props.library);
  const assets = state.assets.filter((asset) =>
    imageLibraryContainsAsset(props.library, props.root, asset, props.subset),
  );
  const directory = `${props.root}/${props.library.base}${props.subset ? `/${props.subset}` : ""}`;
  return importOpen ? (
    <ImageLibraryImportDialog
      root={props.root}
      library={props.library}
      config={props.config}
      groups={props.groups}
      initialFolder={props.subset}
      onClose={() => setImportOpen(false)}
      onImported={(result) => {
        void state.refresh();
        const output = mediaOutputPath(props.root, props.media, result.imagePath);
        if (output) props.onPick(output);
      }}
    />
  ) : (
    <ImageLibraryPickerDialog
      root={props.root}
      library={props.library}
      assets={assets}
      directories={state.directories}
      directory={directory}
      error={state.error}
      onClose={props.onClose}
      onImport={() => setImportOpen(true)}
      onPick={(asset) => {
        const output = asset.imagePath
          ? mediaOutputPath(props.root, props.media, asset.imagePath)
          : null;
        if (output) props.onPick(output);
      }}
    />
  );
}

/** Image insertion for Markdown/MDX bodies. An explicit collection media source
 * selects a library (or subset); otherwise authors choose a discovered one. */
export function RichTextImagePickerDialog(props: {
  root: string;
  config: PagesConfig;
  configuredMedia: MediaEntry | null;
  templateValues: Record<string, unknown>;
  groups: FileGroup[];
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
          This collection’s media-library template cannot be resolved until its referenced fields
          have values.
        </Alert>
      </Dialog>
    );
  }

  if (expandedMedia && !configured) {
    return (
      <Dialog opened onClose={props.onClose} title="Choose image" size="lg">
        <Alert color="red">
          This collection’s configured media folder ({expandedMedia.input}) is not a recognized
          Astro image library or an included subfolder of one.
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
        config={props.config}
        groups={props.groups}
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
        config={props.config}
        groups={props.groups}
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
        <ImageLibraryList
          libraries={libraries}
          onChoose={(library) => setSelectedCollection(library.collection)}
        />
      )}
    </Dialog>
  );
}

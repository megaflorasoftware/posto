import { useState, type ReactNode } from "react";
import { Alert, Button } from "@mantine/core";
import {
  imageLibraryContainsAsset,
  resolveImageLibraryLocation,
} from "@posto/core/project/mediaLibrary";
import {
  expandMediaEntry,
  mediaOutputPath,
  type MediaLibrary,
  type MediaEntry,
  type PagesConfig,
} from "@posto/core/pagescms/config";
import { openPath, type FileGroup } from "@posto/ipc";
import { refreshImageLibraryAssets, useImageLibraryAssets } from "../hooks/useImageLibraryAssets";
import { chooseAndImportPublicMedia, usePublicMediaFiles } from "../hooks/usePublicMediaFiles";
import { markdownMediaKind, publicMediaOutputPath, type MarkdownMediaPick } from "../markdownMedia";
import { Dialog } from "./Dialog";
import { ImageLibraryImportDialog } from "./ImageLibraryImportDialog";
import { ImageLibraryPickerDialog } from "./ImageLibraryPickerDialog";
import { MediaLibraryTabs, PUBLIC_MEDIA_TAB } from "./MediaLibraryTabs";
import { PublicMediaBrowser } from "./PublicMediaBrowser";

function defaultMedia(library: MediaLibrary): MediaEntry {
  const input = library.base.replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
  return { name: `astro:${library.collection}`, input, output: `/${input}` };
}

function LibraryGrid(props: {
  root: string;
  library: MediaLibrary;
  libraries: MediaLibrary[];
  subset: string;
  media: MediaEntry;
  config: PagesConfig;
  groups: FileGroup[];
  toolbar: ReactNode;
  importSourcePaths?: string[];
  onClose: () => void;
  onPick: (media: MarkdownMediaPick) => void;
}) {
  const [importOpen, setImportOpen] = useState(() => !!props.importSourcePaths?.length);
  const state = useImageLibraryAssets(props.root, props.library);
  const assets = state.assets.filter((asset) =>
    imageLibraryContainsAsset(props.library, props.root, asset, props.subset),
  );
  const directory = `${props.root}/${props.library.base}${props.subset ? `/${props.subset}` : ""}`;
  return importOpen ? (
    <ImageLibraryImportDialog
      root={props.root}
      library={props.library}
      libraries={props.libraries}
      config={props.config}
      groups={props.groups}
      sourcePaths={props.importSourcePaths}
      initialFolder={props.subset}
      onClose={() => {
        setImportOpen(false);
        if (props.importSourcePaths?.length) props.onClose();
      }}
      onImported={(result, importedLibrary, draft) => {
        void refreshImageLibraryAssets(props.root, importedLibrary);
        const media =
          importedLibrary.collection === props.library.collection
            ? props.media
            : defaultMedia(importedLibrary);
        const output = mediaOutputPath(props.root, media, result.imagePath);
        if (output) {
          props.onPick({
            outputPath: output,
            label: result.imagePath.split("/").pop() ?? "image",
            kind: "image",
            alt: typeof draft.metadata.alt === "string" ? draft.metadata.alt : undefined,
          });
        }
      }}
      onPublicImported={(path) => {
        const outputPath = publicMediaOutputPath(props.root, path);
        if (!outputPath) return;
        props.onPick({
          outputPath,
          label: path.split("/").pop() ?? "image",
          kind: markdownMediaKind(path),
        });
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
      toolbar={props.toolbar}
      onClose={props.onClose}
      onImport={() => setImportOpen(true)}
      onPick={(asset) => {
        const output = asset.imagePath
          ? mediaOutputPath(props.root, props.media, asset.imagePath)
          : null;
        if (output) {
          props.onPick({
            outputPath: output,
            label: asset.imagePath?.split("/").pop() ?? asset.entryId,
            kind: "image",
            alt: typeof asset.metadata.alt === "string" ? asset.metadata.alt : undefined,
          });
        }
      }}
    />
  );
}

function PublicGrid(props: {
  root: string;
  toolbar: ReactNode;
  onClose: () => void;
  onPick: (media: MarkdownMediaPick) => void;
}) {
  const state = usePublicMediaFiles(props.root);
  const [currentDirectory, setCurrentDirectory] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openDirectory = currentDirectory
    ? `${state.publicRoot}/${currentDirectory}`
    : state.publicRoot;

  const pick = (path: string, name: string) => {
    const outputPath = publicMediaOutputPath(props.root, path);
    if (!outputPath) return;
    props.onPick({ outputPath, label: name, kind: markdownMediaKind(path) });
  };

  const importFile = async () => {
    setImporting(true);
    setError(null);
    try {
      const imported = await chooseAndImportPublicMedia(props.root, currentDirectory, {
        multiple: false,
      });
      if (imported[0]) {
        await state.refresh();
        pick(imported[0], imported[0].split("/").pop() ?? "media");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog opened onClose={props.onClose} title="Choose from public" size="xl">
      {(error || state.error) && (
        <Alert color="red" mb="sm">
          {error ?? `Could not read public media: ${state.error}`}
        </Alert>
      )}
      <PublicMediaBrowser
        rootDirectory={state.publicRoot}
        currentDirectory={currentDirectory}
        directories={state.directories}
        files={state.files}
        toolbar={props.toolbar}
        onDirectoryChange={setCurrentDirectory}
        onPick={(file) => pick(file.path, file.name)}
      />
      <div className="image-library-picker-actions">
        <Button fullWidth variant="outline" onClick={() => void openPath(openDirectory)}>
          Open public folder
        </Button>
        <Button fullWidth loading={importing} onClick={() => void importFile()}>
          Import file
        </Button>
      </div>
    </Dialog>
  );
}

/** Media insertion for Markdown/MDX bodies. Images use Markdown image syntax,
 * audio/video use CommonMark raw HTML, and other public files use links. */
export function RichTextImagePickerDialog(props: {
  root: string;
  config: PagesConfig;
  configuredMedia: MediaEntry | null;
  templateValues: Record<string, unknown>;
  groups: FileGroup[];
  /** Immediately opens the import flow for files dropped onto the editor. */
  importSourcePaths?: string[];
  onClose: () => void;
  onPick: (media: MarkdownMediaPick) => void;
}) {
  const libraries = props.config.mediaLibraries ?? [];
  const expandedMedia = props.configuredMedia
    ? expandMediaEntry(props.configuredMedia, props.templateValues)
    : null;
  const configured = expandedMedia
    ? resolveImageLibraryLocation(libraries, expandedMedia.input)
    : null;
  const [selectedCollection, setSelectedCollection] = useState(
    configured?.library.collection ??
      (props.importSourcePaths?.length
        ? (libraries[0]?.collection ?? PUBLIC_MEDIA_TAB)
        : props.configuredMedia
          ? PUBLIC_MEDIA_TAB
          : (libraries[0]?.collection ?? PUBLIC_MEDIA_TAB)),
  );
  const selected = libraries.find((library) => library.collection === selectedCollection) ?? null;
  const effectiveSelection = selected ? selectedCollection : PUBLIC_MEDIA_TAB;
  const toolbar = (
    <MediaLibraryTabs
      libraries={libraries}
      selected={effectiveSelection}
      onSelect={setSelectedCollection}
    />
  );

  if (selected) {
    const selectedConfigured =
      configured?.library.collection === selected.collection && expandedMedia ? configured : null;
    return (
      <LibraryGrid
        key={selected.collection}
        root={props.root}
        library={selected}
        libraries={libraries}
        subset={selectedConfigured?.subset ?? ""}
        media={selectedConfigured ? expandedMedia! : defaultMedia(selected)}
        config={props.config}
        groups={props.groups}
        toolbar={toolbar}
        importSourcePaths={props.importSourcePaths}
        onClose={props.onClose}
        onPick={props.onPick}
      />
    );
  }

  return (
    <PublicGrid root={props.root} toolbar={toolbar} onClose={props.onClose} onPick={props.onPick} />
  );
}

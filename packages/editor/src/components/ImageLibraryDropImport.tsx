import { useEffect, useState } from "react";
import type { FieldContext } from "./FieldEditor";
import { onFileDrop } from "@posto/ipc";
import { Dialog } from "./Dialog";
import { ImageLibraryImportDialog } from "./ImageLibraryImportDialog";
import { ImageLibraryList } from "./ImageLibraryList";

const DROPPED_IMAGE = /\.(?:avif|gif|jpe?g|png|svg|tiff?|webp)$/i;

export function ImageLibraryDropImport(props: {
  root: string;
  config: FieldContext["config"];
  groups: FieldContext["groups"];
  onImported: () => void;
  onError?: (message: string) => void;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [collection, setCollection] = useState<string | null>(null);
  const libraries = props.config.imageLibraries ?? [];
  useEffect(() => onFileDrop((paths) => {
    const images = paths.filter((path) => DROPPED_IMAGE.test(path));
    if (images.length === 0) return;
    if (images.length > 1) {
      props.onError?.("Image libraries currently import one image at a time.");
      return;
    }
    if (libraries.length === 0) {
      props.onError?.("This project has no editable Astro image library.");
      return;
    }
    setSource(images[0]);
    setCollection(libraries.length === 1 ? libraries[0].collection : null);
  }), [libraries, props.onError]);
  const library = libraries.find((candidate) => candidate.collection === collection) ?? null;
  const close = () => { setSource(null); setCollection(null); };
  if (!source) return null;
  if (!library) {
    return (
      <Dialog opened onClose={close} title="Choose image library" size="sm">
        <ImageLibraryList
          libraries={libraries}
          onChoose={(candidate) => setCollection(candidate.collection)}
        />
      </Dialog>
    );
  }
  return (
    <ImageLibraryImportDialog
      root={props.root}
      library={library}
      config={props.config}
      groups={props.groups}
      sourcePath={source}
      onClose={close}
      onImported={() => { props.onImported(); close(); }}
    />
  );
}

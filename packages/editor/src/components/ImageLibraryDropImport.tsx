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
  const [sources, setSources] = useState<string[] | null>(null);
  const [collection, setCollection] = useState<string | null>(null);
  const libraries = props.config.mediaLibraries ?? [];
  useEffect(
    () =>
      onFileDrop(
        (paths) => {
          const images = paths.filter((path) => DROPPED_IMAGE.test(path));
          if (images.length === 0) return;
          if (libraries.length === 0) {
            props.onError?.("This project has no editable media library.");
            return;
          }
          setSources(images);
          setCollection(libraries.length === 1 ? libraries[0].collection : null);
        },
        { priority: 0 },
      ),
    [libraries, props.onError],
  );
  const library = libraries.find((candidate) => candidate.collection === collection) ?? null;
  const close = () => {
    setSources(null);
    setCollection(null);
  };
  if (!sources) return null;
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
      sourcePaths={sources}
      onClose={close}
      onImported={() => {
        props.onImported();
      }}
    />
  );
}

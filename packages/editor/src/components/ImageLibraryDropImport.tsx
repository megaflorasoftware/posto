import { useEffect, useState } from "react";
import type { FieldContext } from "./FieldEditor";
import { onFileDrop } from "@posto/ipc";
import { ImageLibraryImportDialog } from "./ImageLibraryImportDialog";

const DROPPED_IMAGE = /\.(?:avif|gif|jpe?g|png|svg|tiff?|webp)$/i;

export function ImageLibraryDropImport(props: {
  root: string;
  config: FieldContext["config"];
  groups: FieldContext["groups"];
  onImported: () => void;
  onError?: (message: string) => void;
}) {
  const [sources, setSources] = useState<string[] | null>(null);
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
        },
        { priority: 0 },
      ),
    [libraries, props.onError],
  );
  const close = () => {
    setSources(null);
  };
  if (!sources) return null;
  const library = libraries[0];
  if (!library) return null;
  return (
    <ImageLibraryImportDialog
      root={props.root}
      library={library}
      libraries={libraries}
      config={props.config}
      groups={props.groups}
      sourcePaths={sources}
      onClose={close}
      onImported={() => {
        props.onImported();
      }}
      onPublicImported={() => props.onImported()}
    />
  );
}

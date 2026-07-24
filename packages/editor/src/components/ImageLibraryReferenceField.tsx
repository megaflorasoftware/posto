import { useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "@mantine/core";
import { Image as ImageIcon, Pencil } from "lucide-react";
import { serializeImageLibraryMetadata } from "@posto/core/project/mediaLibrary";
import type { MediaLibrary, Field } from "@posto/core/pagescms/config";
import type { ValuePath } from "@posto/core/pagescms/frontmatter";
import { validateForm } from "@posto/core/pagescms/validate";
import { invoke } from "@posto/ipc";
import { AUTOSAVE_DELAY_MS } from "../autosave";
import { useImageLibraryAssets } from "../hooks/useImageLibraryAssets";
import {
  editValueAtPath,
  imageLibraryMetadataFields,
  metadataExtension,
  valueAtPath,
} from "../imageLibraryMetadata";
import { ImageLibraryImportDialog } from "./ImageLibraryImportDialog";
import { ImageLibraryPickerDialog } from "./ImageLibraryPickerDialog";
import { CachedImage } from "./CachedImage";
import { FieldEditor, type FieldContext } from "./FieldEditor";
import { useMediaDropZone } from "./MediaDragDrop";

export function ImageLibraryReferenceField(props: {
  field: Field;
  path: ValuePath;
  ctx: FieldContext;
  library: MediaLibrary;
}) {
  const [importOpen, setImportOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [metadata, setMetadata] = useState<Record<string, unknown>>({});
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const metadataRef = useRef(metadata);
  const metadataDirtyRef = useRef(false);
  const metadataRevisionRef = useRef(0);
  const metadataSaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const activeMetadataSave = useRef<Promise<void> | null>(null);
  const libraryState = useImageLibraryAssets(props.ctx.root, props.library);
  const value = props.ctx.value(props.path);
  const selected = typeof value === "string" ? value : null;
  const selectedAsset = libraryState.assets.find((asset) => asset.entryId === selected);
  const missing = selected && !libraryState.loading && !selectedAsset;
  const metadataFields = useMemo(() => imageLibraryMetadataFields(props.library), [props.library]);
  const metadataErrors = validateForm(metadataFields, metadata);

  useEffect(() => {
    const next = structuredClone(selectedAsset?.metadata ?? {});
    metadataRef.current = next;
    metadataDirtyRef.current = false;
    metadataRevisionRef.current += 1;
    clearTimeout(metadataSaveTimer.current);
    metadataSaveTimer.current = undefined;
    setMetadata(next);
    setMetadataError(null);
  }, [selectedAsset?.metadataPath]);

  const writeMetadata = (
    asset: NonNullable<typeof selectedAsset>,
    nextMetadata: Record<string, unknown>,
    revision: number,
  ): Promise<void> => {
    const previous = activeMetadataSave.current ?? Promise.resolve();
    const task = previous
      .then(() =>
        invoke("write_text_file", {
          path: asset.metadataPath,
          content: serializeImageLibraryMetadata(
            nextMetadata,
            metadataExtension(asset.metadataPath),
          ),
        }),
      )
      .then(() => {
        if (metadataRevisionRef.current === revision) {
          metadataDirtyRef.current = false;
        }
        setMetadataError(null);
      })
      .catch((error) => {
        setMetadataError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (activeMetadataSave.current === task) {
          activeMetadataSave.current = null;
        }
      });
    activeMetadataSave.current = task;
    return task;
  };

  const flushMetadata = (): Promise<void> => {
    clearTimeout(metadataSaveTimer.current);
    metadataSaveTimer.current = undefined;
    if (selectedAsset && metadataDirtyRef.current) {
      const current = metadataRef.current;
      if (validateForm(metadataFields, current).size === 0) {
        return writeMetadata(selectedAsset, current, metadataRevisionRef.current);
      }
    }
    return activeMetadataSave.current ?? Promise.resolve();
  };

  useEffect(
    () => () => {
      clearTimeout(metadataSaveTimer.current);
      if (
        selectedAsset &&
        metadataDirtyRef.current &&
        validateForm(metadataFields, metadataRef.current).size === 0
      ) {
        void writeMetadata(selectedAsset, metadataRef.current, metadataRevisionRef.current);
      }
    },
    [selectedAsset?.metadataPath, metadataFields],
  );

  const updateMetadata = (path: ValuePath, value: unknown) => {
    const next = editValueAtPath(metadataRef.current, path, value);
    metadataRef.current = next;
    metadataDirtyRef.current = true;
    metadataRevisionRef.current += 1;
    const revision = metadataRevisionRef.current;
    setMetadata(next);
    setMetadataError(null);
    clearTimeout(metadataSaveTimer.current);
    metadataSaveTimer.current = undefined;
    if (selectedAsset && validateForm(metadataFields, next).size === 0) {
      metadataSaveTimer.current = setTimeout(() => {
        metadataSaveTimer.current = undefined;
        void writeMetadata(selectedAsset, next, revision);
      }, AUTOSAVE_DELAY_MS);
    }
  };
  const imageDrop = useMediaDropZone({
    id: `image-library-field:${props.ctx.root}:${props.path.join(".")}`,
    accepts: (dragged) =>
      dragged.kind === "image" && dragged.library?.collection === props.library.collection,
    onDrop: (dragged) => {
      const entryId = dragged.library?.entryId;
      if (!entryId) return;
      void flushMetadata().then(() => props.ctx.edit(props.path, entryId));
    },
  });
  const metadataCtx: FieldContext = {
    config: props.ctx.config,
    root: props.ctx.root,
    entry: null,
    groups: props.ctx.groups,
    entryIds: props.ctx.entryIds,
    errors: () => metadataErrors,
    templateValues: () => metadata,
    value: (path) => valueAtPath(metadata, path),
    edit: updateMetadata,
    listAppend: (path, value) => {
      const list = valueAtPath(metadata, path);
      updateMetadata(path, [...(Array.isArray(list) ? list : []), value]);
    },
    listRemove: (path, index) => {
      const list = valueAtPath(metadata, path);
      if (Array.isArray(list))
        updateMetadata(
          path,
          list.filter((_item, itemIndex) => itemIndex !== index),
        );
    },
    listMove: (path, from, to) => {
      const list = valueAtPath(metadata, path);
      if (!Array.isArray(list)) return;
      const moved = [...list];
      const [item] = moved.splice(from, 1);
      moved.splice(to, 0, item);
      updateMetadata(path, moved);
    },
  };

  return (
    <>
      {libraryState.error && (
        <Alert color="yellow" mb="xs">
          Could not read image library: {libraryState.error}
        </Alert>
      )}
      {missing && (
        <Alert color="yellow" mb="xs">
          The selected image entry is missing.
        </Alert>
      )}
      <div className="image-library-reference-item">
        <button
          ref={imageDrop.setNodeRef}
          type="button"
          className={`image-library-reference${imageDrop.isAccepting ? " is-drag-over" : ""}`}
          aria-label={selected ? "Change image" : "Choose image"}
          onClick={() => setPickerOpen(true)}
        >
          <span className="image-library-reference-preview">
            <CachedImage
              path={selectedAsset?.imagePath}
              alt=""
              thumbnailWidth={160}
              thumbnailHeight={160}
              fallback={<ImageIcon size={20} />}
            />
          </span>
          <span className="image-library-reference-edit">
            <Pencil size={20} />
          </span>
        </button>
        {selectedAsset && (
          <div className="image-library-reference-metadata">
            {metadataError && (
              <Alert color="red" mb="xs">
                Could not save image metadata: {metadataError}
              </Alert>
            )}
            <div className="form-fields image-library-metadata-fields">
              {metadataFields.map((field) => (
                <FieldEditor key={field.name} field={field} path={[field.name]} ctx={metadataCtx} />
              ))}
            </div>
          </div>
        )}
      </div>
      {pickerOpen && (
        <ImageLibraryPickerDialog
          root={props.ctx.root}
          library={props.library}
          assets={libraryState.assets}
          directories={libraryState.directories}
          onClose={() => setPickerOpen(false)}
          onImport={() => {
            setPickerOpen(false);
            setImportOpen(true);
          }}
          onPick={(asset) => {
            void flushMetadata().then(() => {
              props.ctx.edit(props.path, asset.entryId);
              setPickerOpen(false);
            });
          }}
        />
      )}
      {importOpen && (
        <ImageLibraryImportDialog
          root={props.ctx.root}
          library={props.library}
          config={props.ctx.config}
          groups={props.ctx.groups}
          onClose={() => setImportOpen(false)}
          onImported={(result) => {
            props.ctx.edit(props.path, result.entryId);
            void libraryState.refresh();
          }}
        />
      )}
    </>
  );
}

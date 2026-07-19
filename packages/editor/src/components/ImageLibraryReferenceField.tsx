import { useState } from "react";
import { Alert } from "@mantine/core";
import { Image as ImageIcon, Pencil } from "lucide-react";
import type { AstroImageLibrary, Field } from "@posto/core/pagescms/config";
import type { ValuePath } from "@posto/core/pagescms/frontmatter";
import { assetUrl } from "@posto/ipc";
import { useImageLibraryAssets } from "../hooks/useImageLibraryAssets";
import { ImageLibraryImportDialog } from "./ImageLibraryImportDialog";
import { ImageLibraryPickerDialog } from "./ImageLibraryPickerDialog";
import type { FieldContext } from "./FieldEditor";

export function ImageLibraryReferenceField(props: {
  field: Field;
  path: ValuePath;
  ctx: FieldContext;
  library: AstroImageLibrary;
}) {
  const [importOpen, setImportOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const libraryState = useImageLibraryAssets(props.ctx.root, props.library);
  const value = props.ctx.value(props.path);
  const selected = typeof value === "string" ? value : null;
  const selectedAsset = libraryState.assets.find((asset) => asset.entryId === selected);
  const missing = selected && !libraryState.loading && !selectedAsset;
  const thumbnail = selectedAsset?.imagePath ? assetUrl(selectedAsset.imagePath) : null;

  return (
    <>
      {libraryState.error && <Alert color="yellow" mb="xs">Could not read image library: {libraryState.error}</Alert>}
      {missing && <Alert color="yellow" mb="xs">The selected image entry is missing.</Alert>}
      <button
        type="button"
        className="image-library-reference"
        aria-label={selected ? "Change image" : "Choose image"}
        onClick={() => setPickerOpen(true)}
      >
        <span className="image-library-reference-preview">
          {thumbnail ? <img src={thumbnail} alt="" /> : <ImageIcon size={20} />}
        </span>
        <span className="image-library-reference-edit"><Pencil size={20} /></span>
      </button>
      {pickerOpen && (
        <ImageLibraryPickerDialog
          root={props.ctx.root}
          library={props.library}
          assets={libraryState.assets}
          onClose={() => setPickerOpen(false)}
          onImport={() => {
            setPickerOpen(false);
            setImportOpen(true);
          }}
          onPick={(asset) => {
            props.ctx.edit(props.path, asset.entryId);
            setPickerOpen(false);
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

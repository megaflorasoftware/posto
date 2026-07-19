import { useState } from "react";
import { ActionIcon, Alert, Button, TextInput } from "@mantine/core";
import { Image as ImageIcon, X } from "lucide-react";
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
      <div className="image-library-reference">
        <span className="image-library-reference-thumbnail">
          {thumbnail ? <img src={thumbnail} alt="" /> : <ImageIcon size={20} />}
        </span>
        <div className="image-library-reference-controls">
          <TextInput size="xs" readOnly value={selected ?? ""} placeholder="No image selected" error={missing ? "Missing image entry" : undefined} />
          <Button size="xs" variant="default" onClick={() => setPickerOpen(true)}>Choose…</Button>
          <Button size="xs" variant="default" onClick={() => setImportOpen(true)}>Import…</Button>
          {selected && !props.field.required && (
            <ActionIcon variant="subtle" color="gray" size="sm" title="Clear" onClick={() => props.ctx.edit(props.path, undefined)}>
              <X size={14} />
            </ActionIcon>
          )}
        </div>
      </div>
      {pickerOpen && (
        <ImageLibraryPickerDialog
          root={props.ctx.root}
          library={props.library}
          assets={libraryState.assets}
          onClose={() => setPickerOpen(false)}
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
          onImported={(entryId) => {
            props.ctx.edit(props.path, entryId);
            void libraryState.refresh();
          }}
        />
      )}
    </>
  );
}

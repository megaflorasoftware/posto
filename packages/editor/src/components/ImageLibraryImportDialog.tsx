import { useMemo } from "react";
import { Alert, Button, Select, TextInput } from "@mantine/core";
import type { AstroImageLibrary, Field, PagesConfig } from "@posto/core/pagescms/config";
import type { ValuePath } from "@posto/core/pagescms/frontmatter";
import { validateForm } from "@posto/core/pagescms/validate";
import type { FileGroup } from "@posto/ipc";
import { useImageLibraryImport } from "../hooks/useImageLibraryImport";
import { Dialog } from "./Dialog";
import { FieldEditor, type FieldContext } from "./FieldEditor";

function withoutImageField(fields: Field[], imagePath: string[], prefix: string[] = []): Field[] {
  return fields.flatMap((field) => {
    const path = [...prefix, field.name];
    if (path.length === imagePath.length && path.every((part, index) => part === imagePath[index])) return [];
    return [{ ...field, fields: field.fields ? withoutImageField(field.fields, imagePath, path) : undefined }];
  });
}

function valueAt(root: unknown, path: ValuePath): unknown {
  let value = root;
  for (const key of path) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}

function editValue(root: Record<string, unknown>, path: ValuePath, value: unknown): Record<string, unknown> {
  const next = structuredClone(root);
  let target: Record<string | number, unknown> = next;
  path.forEach((key, index) => {
    if (index === path.length - 1) {
      if (value === undefined) delete target[key];
      else target[key] = value;
      return;
    }
    const nextKey = path[index + 1];
    if (!target[key] || typeof target[key] !== "object") target[key] = typeof nextKey === "number" ? [] : {};
    target = target[key] as Record<string | number, unknown>;
  });
  return next;
}

export function ImageLibraryImportDialog(props: {
  root: string;
  library: AstroImageLibrary;
  config: PagesConfig;
  groups: FileGroup[];
  sourcePath?: string;
  onClose: () => void;
  onImported: (entryId: string) => void;
}) {
  const metadataFields = useMemo(
    () => withoutImageField(props.library.fields, props.library.imageFieldPath),
    [props.library],
  );
  const importer = useImageLibraryImport({
    root: props.root,
    library: props.library,
    initialSourcePath: props.sourcePath,
    onImported: (result) => props.onImported(result.entryId),
  });
  const errors = validateForm(metadataFields, importer.draft.metadata);
  const update = (path: ValuePath, value: unknown) => {
    importer.setDraft((draft) => ({ ...draft, metadata: editValue(draft.metadata, path, value) }));
  };
  const fieldCtx: FieldContext = {
    config: props.config,
    root: props.root,
    entry: null,
    groups: props.groups,
    errors: () => errors,
    templateValues: () => importer.draft.metadata,
    value: (path) => valueAt(importer.draft.metadata, path),
    edit: update,
    listAppend: (path, value) => {
      const list = valueAt(importer.draft.metadata, path);
      update(path, [...(Array.isArray(list) ? list : []), value]);
    },
    listRemove: (path, index) => {
      const list = valueAt(importer.draft.metadata, path);
      if (Array.isArray(list)) update(path, list.filter((_item, itemIndex) => itemIndex !== index));
    },
    listMove: (path, from, to) => {
      const list = valueAt(importer.draft.metadata, path);
      if (!Array.isArray(list)) return;
      const moved = [...list];
      const [item] = moved.splice(from, 1);
      moved.splice(to, 0, item);
      update(path, moved);
    },
  };

  return (
    <Dialog opened onClose={props.onClose} title={`Import into ${props.library.collection}`} size="lg">
      {importer.error && <Alert color="red" mb="sm">{importer.error}</Alert>}
      <div className="image-library-import-source">
        <TextInput size="xs" readOnly label="Image" placeholder="Choose an image" value={importer.draft.sourceImagePath ?? ""} />
        <Button size="xs" variant="default" onClick={() => void importer.chooseSource()}>Choose…</Button>
      </div>
      <TextInput
        size="xs"
        label="Destination folder"
        description="Optional path inside the library"
        value={importer.draft.folder}
        onChange={(event) => importer.setDraft((draft) => ({ ...draft, folder: event.currentTarget.value }))}
      />
      <TextInput
        size="xs"
        label="Filename"
        value={importer.draft.filename}
        onChange={(event) => importer.setDraft((draft) => ({ ...draft, filename: event.currentTarget.value }))}
      />
      {props.library.metadataExtensions.length > 1 && (
        <Select
          size="xs"
          label="Metadata format"
          data={props.library.metadataExtensions}
          value={importer.draft.metadataExtension ?? null}
          onChange={(value) => importer.setDraft((draft) => ({ ...draft, metadataExtension: value as typeof draft.metadataExtension }))}
        />
      )}
      <div className="form-fields image-library-metadata-fields">
        {metadataFields.map((field) => <FieldEditor key={field.name} field={field} path={[field.name]} ctx={fieldCtx} />)}
      </div>
      <Button
        fullWidth
        mt="md"
        loading={importer.pending}
        disabled={!importer.draft.sourceImagePath || errors.size > 0}
        onClick={() => void importer.execute().then((result) => { if (result) props.onClose(); })}
      >
        Import image
      </Button>
    </Dialog>
  );
}

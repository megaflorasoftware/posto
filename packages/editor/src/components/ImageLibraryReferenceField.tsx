import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Select, TextInput } from "@mantine/core";
import {
  discoverImageLibraryAssets,
  type ImageLibraryAsset,
} from "@posto/core/astro/imageLibrary";
import type { AstroImageLibrary, Field } from "@posto/core/pagescms/config";
import { validateForm } from "@posto/core/pagescms/validate";
import type { ValuePath } from "@posto/core/pagescms/frontmatter";
import { invoke, onFileDrop, type FileEntry } from "@posto/ipc";
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
  ctx: FieldContext;
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
    onImported: (result) => props.onImported(result.entryId),
  });
  useEffect(() => {
    if (props.sourcePath) importer.setSource(props.sourcePath);
  }, [props.sourcePath]);
  const errors = validateForm(metadataFields, importer.draft.metadata);
  const update = (path: ValuePath, value: unknown) => {
    importer.setDraft((draft) => ({ ...draft, metadata: editValue(draft.metadata, path, value) }));
  };
  const fieldCtx: FieldContext = {
    ...props.ctx,
    entry: null,
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
        <TextInput
          size="xs"
          readOnly
          label="Image"
          placeholder="Choose an image"
          value={importer.draft.sourceImagePath ?? ""}
        />
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

const DROPPED_IMAGE = /\.(?:avif|gif|jpe?g|png|svg|tiff?|webp)$/i;

/** Desktop-level drop integration. Contextual and global imports both render
 * the same schema-driven dialog and execute through the same controller. */
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
  const ctx: FieldContext = {
    config: props.config,
    root: props.root,
    entry: null,
    groups: props.groups,
    errors: () => new Map(),
    templateValues: () => ({}),
    value: () => undefined,
    edit: () => {},
    listAppend: () => {},
    listRemove: () => {},
    listMove: () => {},
  };
  if (!source) return null;
  if (!library) {
    return (
      <Dialog opened onClose={close} title="Choose image library" size="sm">
        <Select
          label="Library"
          data={libraries.map((candidate) => ({ value: candidate.collection, label: candidate.collection }))}
          value={collection}
          onChange={setCollection}
        />
      </Dialog>
    );
  }
  return (
    <ImageLibraryImportDialog
      root={props.root}
      library={library}
      ctx={ctx}
      sourcePath={source}
      onClose={close}
      onImported={() => { props.onImported(); close(); }}
    />
  );
}

export function ImageLibraryReferenceField(props: {
  field: Field;
  path: ValuePath;
  ctx: FieldContext;
  library: AstroImageLibrary;
}) {
  const [assets, setAssets] = useState<ImageLibraryAsset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const root = `${props.ctx.root}/${props.library.base}`;
  useEffect(() => {
    let cancelled = false;
    invoke<FileEntry[]>("list_dir_files", { dir: root, extensions: [] })
      .then(async (files) => {
        const metadata = files.filter((file) => props.library.metadataExtensions.includes(file.name.split(".").pop()?.toLowerCase() as never));
        const documents = await Promise.all(metadata.map(async (file) => ({ path: file.path, content: await invoke<string>("read_text_file", { path: file.path }) })));
        if (!cancelled) {
          setAssets(discoverImageLibraryAssets(props.library, props.ctx.root, documents, files.map((file) => file.path)));
          setError(null);
        }
      })
      .catch((caught) => { if (!cancelled) setError(String(caught)); });
    return () => { cancelled = true; };
  }, [root, props.library, refresh]);
  const value = valueAt(props.ctx.templateValues(), props.path);
  const selected = typeof value === "string" ? value : null;
  const options = assets.map((asset) => ({
    value: asset.entryId,
    label: asset.health.includes("valid") ? asset.entryId : `${asset.entryId} (${asset.health.join(", ")})`,
    disabled: !asset.health.includes("valid"),
  }));
  if (selected && !options.some((option) => option.value === selected)) {
    options.unshift({ value: selected, label: `${selected} (missing)`, disabled: false });
  }
  return (
    <>
      {error && <Alert color="yellow" mb="xs">Could not read image library: {error}</Alert>}
      <div className="image-library-reference">
        <Select
          size="xs"
          clearable={!props.field.required}
          searchable
          data={options}
          value={selected}
          onChange={(next) => props.ctx.edit(props.path, next || undefined)}
        />
        <Button size="xs" variant="default" onClick={() => setImportOpen(true)}>Import…</Button>
      </div>
      {importOpen && (
        <ImageLibraryImportDialog
          root={props.ctx.root}
          library={props.library}
          ctx={props.ctx}
          onClose={() => setImportOpen(false)}
          onImported={(entryId) => {
            props.ctx.edit(props.path, entryId);
            setRefresh((value) => value + 1);
          }}
        />
      )}
    </>
  );
}

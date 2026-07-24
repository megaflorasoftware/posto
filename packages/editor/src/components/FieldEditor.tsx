import { useEffect, useState, type ReactNode } from "react";
import { ActionIcon, Button, NumberInput, Switch, Textarea, TextInput } from "@mantine/core";
import { Check, GripVertical, Image, Pencil, RefreshCw, X } from "lucide-react";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { ContentEntry, Field, PagesConfig } from "@posto/core/pagescms/config";
import {
  collectionExtension,
  expandFieldTemplate,
  matchCollectionForDir,
  mediaInputPath,
  resolveMedia,
  resolveMediaForValue,
} from "@posto/core/pagescms/config";
import type { EntryIdSource } from "@posto/core/project/entryIds";
import { expandEntryName } from "@posto/core/posto/config";
import { applyCollectionPrefs } from "../collectionPrefs";
import type { ValuePath } from "@posto/core/pagescms/frontmatter";
import type { Errors } from "@posto/core/pagescms/validate";
import type { FileEntry, FileGroup } from "@posto/ipc";
import { invoke } from "@posto/ipc";
import { CachedImage } from "./CachedImage";
import { ImagePicker } from "./ImagePicker";
import { ImageLibraryReferenceField } from "./ImageLibraryReferenceField";
import { FieldRowsAction, FieldTemplateActions } from "./FieldTemplateActions";
import { AdaptiveSelect } from "./AdaptiveSelect";
import { useMediaDropZone, type PostoListDragData } from "./MediaDragDrop";

export interface FieldContext {
  config: PagesConfig;
  root: string;
  /** Collection entry the edited file belongs to; scopes media resolution. */
  entry: ContentEntry | null;
  groups: FileGroup[];
  /** Adapter-owned entry ID behavior; absent adapters store reference paths. */
  entryIds?: EntryIdSource | null;
  errors: () => Errors;
  /** Current top-level frontmatter used to expand per-entry settings. */
  templateValues: () => Record<string, unknown>;
  /** Current value at a frontmatter path. */
  value: (path: ValuePath) => unknown;
  edit: (path: ValuePath, value: unknown) => void;
  listAppend: (path: ValuePath, value: unknown) => void;
  listRemove: (path: ValuePath, index: number) => void;
  listMove: (path: ValuePath, from: number, to: number) => void;
  /** Reloads the effective collection config after an item-level template edit. */
  onPostoSaved?: () => void;
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  return "";
}

/** Initial value for a newly added list item, built from nested defaults. */
function newItemValue(field: Field): unknown {
  if (field.type === "object") {
    const item: Record<string, unknown> = {};
    for (const child of field.fields ?? []) {
      item[child.name] = child.default ?? (child.type === "object" ? newItemValue(child) : "");
    }
    return item;
  }
  return field.default ?? "";
}

interface SelectValue {
  value: string;
  label: string;
}

function selectValues(field: Field): SelectValue[] {
  const values = field.options?.values;
  if (!Array.isArray(values)) return [];
  return values.map((v) => {
    if (v && typeof v === "object") {
      const item = v as Record<string, unknown>;
      const value = asString(item.value ?? item.name);
      return { value, label: asString(item.label) || value };
    }
    return { value: asString(v), label: asString(v) };
  });
}

export function FieldEditor(props: { field: Field; path: ValuePath; ctx: FieldContext }) {
  if (props.field.hidden) return null;
  return props.field.list ? (
    <ListField field={props.field} path={props.path} ctx={props.ctx} />
  ) : (
    <SingleField field={props.field} path={props.path} ctx={props.ctx} />
  );
}

/** Text-like fields with an image-ish name get a "Choose image" CTA even
 * though their type isn't `image` (Astro props and inferred frontmatter
 * declare image paths as plain strings). */
const IMAGE_NAME = /^(src|image|img|imgsrc)$/i;

function imagePickable(field: Field): boolean {
  return (
    !field.list && (field.type === "string" || field.type === "text") && IMAGE_NAME.test(field.name)
  );
}

/** Right-aligned text button across from the label; opens the media picker
 * and writes the picked image's output path as the field's value. */
function PickImageCta(props: { field: Field; path: ValuePath; ctx: FieldContext }) {
  const [open, setOpen] = useState(false);
  const values = props.ctx.templateValues();
  const currentValue = props.ctx.value(props.path);
  const media =
    typeof currentValue === "string" && currentValue !== ""
      ? resolveMediaForValue(props.ctx.config, props.field, currentValue, props.ctx.entry, values)
      : resolveMedia(props.ctx.config, props.field, props.ctx.entry, values);
  if (!media) return null;
  return (
    <>
      <button type="button" className="pick-image-cta" onClick={() => setOpen(true)}>
        Choose image
      </button>
      {open && (
        <ImagePicker
          root={props.ctx.root}
          media={media}
          onClose={() => setOpen(false)}
          onPick={(outputPath) => {
            setOpen(false);
            props.ctx.edit(props.path, outputPath);
          }}
        />
      )}
    </>
  );
}

/** Label + description + control + inline error, shared by all field kinds. */
function FieldShell(props: {
  field: Field;
  path: ValuePath;
  ctx: FieldContext;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const error = props.ctx.errors().get(props.path.join("."));
  return (
    <div className={`form-field${error ? " invalid" : ""}`}>
      {props.field.label !== false && (
        <div className="field-label-row">
          <label className="field-label">
            {typeof props.field.label === "string" ? props.field.label : props.field.name}
            {props.field.required && <span className="field-required">*</span>}
          </label>
          {imagePickable(props.field) && (
            <PickImageCta field={props.field} path={props.path} ctx={props.ctx} />
          )}
          {props.actions}
        </div>
      )}
      {props.children}
      {props.field.description && (
        <div className="field-description">{props.field.description}</div>
      )}
      {error && <div className="field-error">{error}</div>}
    </div>
  );
}

function SingleField(props: { field: Field; path: ValuePath; ctx: FieldContext }) {
  const value = props.ctx.value(props.path);
  // Cleared text-like inputs delete the key so optional fields don't leave
  // `key: ""` litter behind in the frontmatter.
  const editText = (raw: string) => props.ctx.edit(props.path, raw === "" ? undefined : raw);
  const schemaName = props.path
    .filter((part): part is string => typeof part === "string")
    .join(".");
  const templateSchema = props.ctx.entry?.fieldSchemas?.[schemaName];
  const fieldLabel = typeof props.field.label === "string" ? props.field.label : props.field.name;
  const templatable = !props.path.some((part) => typeof part === "number");
  const generate = (template: string) => {
    const expanded = expandFieldTemplate(template, props.ctx.templateValues());
    if (expanded !== null) props.ctx.edit(props.path, expanded);
  };
  const templateActions =
    templatable && props.ctx.entry && props.ctx.onPostoSaved ? (
      <span className="field-template-actions">
        <FieldTemplateActions
          root={props.ctx.root}
          collection={props.ctx.entry}
          fieldName={schemaName}
          label={fieldLabel}
          onPostoSaved={props.ctx.onPostoSaved}
          onGenerate={generate}
        />
        <FieldRowsAction
          root={props.ctx.root}
          collection={props.ctx.entry}
          fieldName={schemaName}
          label={fieldLabel}
          onPostoSaved={props.ctx.onPostoSaved}
        />
      </span>
    ) : null;

  const control = () => {
    const field = props.field;
    switch (field.type) {
      case "string": {
        const rows = templateSchema?.rows ?? 1;
        const regenerate =
          templateSchema?.template && templateSchema.editBehavior === "manual" ? (
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              title={`Regenerate ${fieldLabel} from its template`}
              aria-label={`Regenerate ${fieldLabel} from its template`}
              onClick={() => generate(templateSchema.template!)}
            >
              <RefreshCw size={15} />
            </ActionIcon>
          ) : undefined;
        return rows > 1 ? (
          <Textarea
            className="templated-control"
            size="xs"
            rows={rows}
            disabled={templateSchema?.editBehavior === "controlled"}
            value={asString(value)}
            rightSection={regenerate}
            rightSectionPointerEvents="all"
            onChange={(e) => editText(e.currentTarget.value)}
          />
        ) : (
          <TextInput
            className="templated-control"
            size="xs"
            disabled={templateSchema?.editBehavior === "controlled"}
            value={asString(value)}
            rightSection={regenerate}
            rightSectionPointerEvents="all"
            onChange={(e) => editText(e.currentTarget.value)}
          />
        );
      }
      case "number":
        return (
          <NumberInput
            size="xs"
            min={typeof field.options?.min === "number" ? field.options.min : undefined}
            max={typeof field.options?.max === "number" ? field.options.max : undefined}
            value={typeof value === "number" ? value : asString(value)}
            onChange={(raw) =>
              props.ctx.edit(
                props.path,
                raw === "" ? undefined : typeof raw === "number" ? raw : Number(raw),
              )
            }
          />
        );
      case "date":
        return (
          <TextInput
            size="xs"
            type={field.options?.time ? "datetime-local" : "date"}
            value={asString(value)}
            onChange={(e) => {
              let raw = e.currentTarget.value;
              // datetime-local omits seconds, but a YAML timestamp needs
              // them — and only real timestamps satisfy date-typed schemas.
              if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) raw += ":00";
              editText(raw);
            }}
          />
        );
      case "boolean":
        return (
          <Switch
            size="sm"
            checked={value === true}
            onChange={(e) => props.ctx.edit(props.path, e.currentTarget.checked)}
          />
        );
      case "select":
        return (
          <AdaptiveSelect
            size="xs"
            aria-label={fieldLabel}
            clearable={!field.required}
            searchable
            // Large option sets (e.g. icon-name enums) would render thousands
            // of dropdown items; cap what's shown and let search narrow it.
            limit={50}
            nothingFoundMessage="No matches"
            data={selectValues(field)}
            value={asString(value) || null}
            onChange={(raw) => editText(raw ?? "")}
          />
        );
      case "image":
        return <ImageField field={field} path={props.path} ctx={props.ctx} />;
      case "reference":
        return <ReferenceField field={field} path={props.path} ctx={props.ctx} />;
      case "object":
        return (
          <div className="object-fields">
            {(field.fields ?? []).map((child) => (
              <FieldEditor
                key={child.name}
                field={child}
                path={[...props.path, child.name]}
                ctx={props.ctx}
              />
            ))}
          </div>
        );
      default:
        // text and anything the form doesn't know how to render
        return (
          <Textarea
            size="xs"
            autosize
            minRows={3}
            value={asString(value)}
            onChange={(e) => editText(e.currentTarget.value)}
          />
        );
    }
  };

  return (
    <FieldShell
      field={props.field}
      path={props.path}
      ctx={props.ctx}
      actions={props.field.type === "string" ? templateActions : undefined}
    >
      {control()}
    </FieldShell>
  );
}

/** Remaps expansion indices after an item moves from `from` to `to`. */
function remapAfterMove(expanded: Set<number>, from: number, to: number): Set<number> {
  const next = new Set<number>();
  for (const i of expanded) {
    if (i === from) next.add(to);
    else if (from < to && i > from && i <= to) next.add(i - 1);
    else if (to < from && i >= to && i < from) next.add(i + 1);
    else next.add(i);
  }
  return next;
}

function remapAfterRemove(expanded: Set<number>, removed: number): Set<number> {
  const next = new Set<number>();
  for (const i of expanded) {
    if (i === removed) continue;
    next.add(i > removed ? i - 1 : i);
  }
  return next;
}

interface ImageDescendant {
  field: Field;
  path: string[];
}

/** First visible image anywhere in an object item. Astro schemas commonly
 * wrap the preview image in a nested object, so direct-child lookup is not
 * sufficient. */
function imageDescendant(field: Field, path: string[] = []): ImageDescendant | null {
  for (const child of field.fields ?? []) {
    if (child.hidden) continue;
    const childPath = [...path, child.name];
    if (child.type === "image") return { field: child, path: childPath };
    const nested = imageDescendant(child, childPath);
    if (nested) return nested;
  }
  return null;
}

/** Read the first usable string at a descendant path. Image arrays use their
 * first item; nested object arrays use their first object. */
function descendantString(value: unknown, path: string[]): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = descendantString(item, path);
      if (found) return found;
    }
    return null;
  }
  if (path.length === 0) return typeof value === "string" && value !== "" ? value : null;
  if (!value || typeof value !== "object") return null;
  const [head, ...tail] = path;
  return descendantString((value as Record<string, unknown>)[head], tail);
}

/**
 * One list row, draggable by its handle (dnd-kit sortable, the pattern
 * Mantine's DnD examples use). Rows are identified by index: order only
 * changes at drop time, so index ids stay stable for the whole drag.
 */
function SortableRow(props: {
  groupId: string;
  index: number;
  className: string;
  onMove: (from: number, to: number) => void;
  children: ReactNode;
}) {
  const id = `${props.groupId}:${props.index}`;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    data: {
      kind: "posto-list-item",
      groupId: props.groupId,
      index: props.index,
      onMove: props.onMove,
    } satisfies PostoListDragData,
  });
  return (
    <div
      ref={setNodeRef}
      className={`${props.className}${isDragging ? " dragging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <span className="drag-handle" title="Drag to reorder" {...attributes} {...listeners}>
        <GripVertical size={14} />
      </span>
      {props.children}
    </div>
  );
}

function ListField(props: { field: Field; path: ValuePath; ctx: FieldContext }) {
  const rawItems = props.ctx.value(props.path);
  const items = Array.isArray(rawItems) ? rawItems : [];
  const limits = typeof props.field.list === "object" ? props.field.list : {};
  const itemField: Field = { ...props.field, list: undefined, label: false, required: false };
  const isObjectList = props.field.type === "object";
  const previewImage = imageDescendant(props.field);
  const sortableGroupId = `field-list:${props.ctx.root}:${props.path.join(".")}`;

  // Object-list items collapse to a summary row; existing items start
  // collapsed, newly added ones open for editing.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  function setItemExpanded(index: number, on: boolean) {
    setExpanded((current) => {
      const next = new Set(current);
      if (on) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  function addItem() {
    const newIndex = items.length;
    props.ctx.listAppend(props.path, newItemValue(props.field));
    if (isObjectList) setItemExpanded(newIndex, true);
  }

  function removeItem(index: number) {
    props.ctx.listRemove(props.path, index);
    setExpanded((current) => remapAfterRemove(current, index));
  }

  function moveItem(from: number, to: number) {
    props.ctx.listMove(props.path, from, to);
    setExpanded((current) => remapAfterMove(current, from, to));
  }

  function itemRecord(index: number): Record<string, unknown> {
    const item = props.ctx.value([...props.path, index]);
    return item && typeof item === "object" && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : {};
  }

  function itemSummary(index: number): string {
    const record = itemRecord(index);
    if (previewImage) {
      const value = descendantString(record, previewImage.path);
      if (value) return value.split("/").pop() ?? value;
    }
    for (const child of props.field.fields ?? []) {
      const value = record[child.name];
      if (typeof value === "string" && value.trim() !== "") {
        return child.type === "reference" ? referenceLabel(props.ctx, value) : value;
      }
      if (typeof value === "number") return String(value);
    }
    return `Item ${index + 1}`;
  }

  function thumbPath(index: number): string | null {
    if (!previewImage) return null;
    const value = descendantString(itemRecord(index), previewImage.path);
    if (!value) return null;
    const media = resolveMedia(
      props.ctx.config,
      previewImage.field,
      props.ctx.entry,
      props.ctx.templateValues(),
    );
    if (!media) return null;
    const absolute = mediaInputPath(props.ctx.root, media, value);
    return absolute;
  }

  const objectRow = (index: number) => {
    const thumb = thumbPath(index);
    return expanded.has(index) ? (
      <SortableRow
        key={index}
        groupId={sortableGroupId}
        index={index}
        className="list-item expanded-item"
        onMove={moveItem}
      >
        <div className="list-item-body">
          <FieldEditor field={itemField} path={[...props.path, index]} ctx={props.ctx} />
        </div>
        <div className="list-item-actions">
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            title="Done"
            onClick={() => setItemExpanded(index, false)}
          >
            <Check size={14} />
          </ActionIcon>
        </div>
      </SortableRow>
    ) : (
      <SortableRow
        key={index}
        groupId={sortableGroupId}
        index={index}
        className="list-item collapsed-item"
        onMove={moveItem}
      >
        {previewImage &&
          (thumb ? (
            <CachedImage
              className="thumb"
              path={thumb}
              alt=""
              thumbnailWidth={64}
              thumbnailHeight={64}
              fallback={
                <span className="thumb thumb-placeholder">
                  <Image size={16} />
                </span>
              }
            />
          ) : (
            <span className="thumb thumb-placeholder">
              <Image size={16} />
            </span>
          ))}
        <span className="item-summary">{itemSummary(index)}</span>
        <div className="list-item-actions">
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            title="Edit"
            onClick={() => setItemExpanded(index, true)}
          >
            <Pencil size={14} />
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            disabled={items.length <= (limits.min ?? 0)}
            title="Remove"
            onClick={() => removeItem(index)}
          >
            <X size={14} />
          </ActionIcon>
        </div>
      </SortableRow>
    );
  };

  const scalarRow = (index: number) => (
    <SortableRow
      key={index}
      groupId={sortableGroupId}
      index={index}
      className="list-item scalar-item"
      onMove={moveItem}
    >
      <div className="list-item-body">
        <FieldEditor field={itemField} path={[...props.path, index]} ctx={props.ctx} />
      </div>
      <div className="list-item-actions">
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          disabled={items.length <= (limits.min ?? 0)}
          title="Remove"
          onClick={() => removeItem(index)}
        >
          <X size={14} />
        </ActionIcon>
      </div>
    </SortableRow>
  );

  return (
    <FieldShell field={props.field} path={props.path} ctx={props.ctx}>
      <div className="list-field">
        <SortableContext
          items={items.map((_item, index) => `${sortableGroupId}:${index}`)}
          strategy={verticalListSortingStrategy}
        >
          {items.map((_item, index) => (isObjectList ? objectRow(index) : scalarRow(index)))}
        </SortableContext>
        <Button
          size="xs"
          variant="default"
          disabled={limits.max !== undefined && items.length >= limits.max}
          onClick={addItem}
        >
          Add item
        </Button>
      </div>
    </FieldShell>
  );
}

function ImageField(props: { field: Field; path: ValuePath; ctx: FieldContext }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const values = props.ctx.templateValues();
  const media = resolveMedia(props.ctx.config, props.field, props.ctx.entry, values);
  const value = asString(props.ctx.value(props.path));
  const valueMedia = value
    ? resolveMediaForValue(props.ctx.config, props.field, value, props.ctx.entry, values)
    : null;
  const libraryMedia = (props.ctx.config.mediaLibraries ?? []).map((library) => {
    const input = library.base.replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
    return { name: `library:${library.collection}`, input, output: `/${input}` };
  });
  let decodedValue = value;
  try {
    decodedValue = decodeURIComponent(value);
  } catch {
    // Preserve malformed percent escapes so the field remains editable.
  }
  const previewPath = value
    ? ([valueMedia, media, ...props.ctx.config.media, ...libraryMedia]
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
        .map((candidate) => mediaInputPath(props.ctx.root, candidate, value))
        .find((candidate): candidate is string => candidate !== null) ??
      (value.startsWith("/") ? `${props.ctx.root}/public${decodedValue}` : null))
    : null;

  const imageDrop = useMediaDropZone({
    id: `image-field:${props.ctx.root}:${props.path.join(".")}`,
    accepts: (dragged) => dragged.kind === "image",
    onDrop: (dragged) => props.ctx.edit(props.path, dragged.outputPath),
  });

  return (
    <div className="image-field-wrap">
      <button
        ref={imageDrop.setNodeRef}
        type="button"
        className={`image-field-preview${imageDrop.isAccepting ? " is-drag-over" : ""}`}
        aria-label={value ? "Change image" : "Choose image"}
        aria-disabled={!media}
        onClick={() => media && setPickerOpen(true)}
      >
        <CachedImage
          path={previewPath}
          alt=""
          thumbnailWidth={160}
          thumbnailHeight={160}
          fallback={<Image size={22} />}
        />
      </button>
      <div className="image-field">
        <TextInput size="xs" readOnly placeholder="No image selected" value={value} />
        <Button size="xs" variant="default" disabled={!media} onClick={() => setPickerOpen(true)}>
          Browse…
        </Button>
        {value && (
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            title="Clear"
            onClick={() => props.ctx.edit(props.path, undefined)}
          >
            <X size={14} />
          </ActionIcon>
        )}
        {pickerOpen && media && (
          <ImagePicker
            root={props.ctx.root}
            media={media}
            onClose={() => setPickerOpen(false)}
            onPick={(outputPath) => {
              setPickerOpen(false);
              props.ctx.edit(props.path, outputPath);
            }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Display label for a stored reference value (a repo-root-relative file
 * path): the target file's frontmatter title, else its filename, else the
 * raw value when the file isn't among the listed groups.
 */
function referenceLabel(ctx: FieldContext, value: string): string {
  const path = ctx.root + "/" + value;
  for (const group of ctx.groups) {
    const file = group.files.find((f) => f.path === path);
    if (file) {
      const collection = matchCollectionForDir(ctx.config, ctx.root, group.path);
      const label = collection?.entryName
        ? expandEntryName(collection.entryName, file.frontmatter)
        : null;
      return label || file.title || file.name;
    }
  }
  return value;
}

/**
 * Expands a Pages CMS reference `value`/`label` template for one file:
 * `{name}` (filename with extension), `{path}` (repo-root-relative),
 * `{filename}` (name without extension), `{extension}`, and `{primary}`
 * (frontmatter title when known, else the bare filename). Unknown tokens
 * expand to "" like Pages CMS.
 */
function referenceTemplate(template: string, root: string, file: FileEntry): string {
  const dot = file.name.lastIndexOf(".");
  const bare = dot > 0 ? file.name.slice(0, dot) : file.name;
  const data: Record<string, string> = {
    name: file.name,
    path: file.path.slice(root.length + 1),
    filename: bare,
    extension: dot > 0 ? file.name.slice(dot + 1) : "",
    primary: file.title ?? bare,
  };
  return template.replace(/\{([^}]+)\}/g, (_, token: string) => data[token] ?? "");
}

function ReferenceField(props: { field: Field; path: ValuePath; ctx: FieldContext }) {
  const imageLibrary = props.ctx.config.mediaLibraries?.find(
    (library) => library.collection === props.field.options?.collection,
  );
  if (props.field.options?.idScheme === "framework" && props.ctx.entryIds && imageLibrary) {
    return <ImageLibraryReferenceField {...props} library={imageLibrary} />;
  }
  const collection = props.ctx.config.content.find(
    (entry) => entry.type === "collection" && entry.name === props.field.options?.collection,
  );
  // Options come from listing the collection's folder directly — the sidebar
  // groups only hold markdown/text files, but references can target any file
  // type (layouts, components, data files, …). The extension implied by the
  // collection's `filename`/`extension` settings filters the list; without
  // one, every file in the folder is offered.
  const dir = collection ? props.ctx.root + "/" + collection.path : null;
  const extension = collection ? collectionExtension(collection) : null;
  const [listed, setListed] = useState<FileEntry[]>([]);
  useEffect(() => {
    if (collection?.dataFile) {
      setListed(
        props.ctx.groups.find((group) => group.dataCollection === collection.name)?.files ?? [],
      );
      return;
    }
    if (!dir) return;
    let cancelled = false;
    invoke<FileEntry[]>("list_dir_files", { dir, extensions: extension ? [extension] : [] })
      .then((files) => {
        if (!cancelled) setListed(files);
      })
      .catch(() => {
        if (!cancelled) setListed([]);
      });
    return () => {
      cancelled = true;
    };
  }, [dir, extension, collection?.dataFile, collection?.name, props.ctx.groups]);

  // list_dir_files carries no frontmatter; recover title and frontmatter from
  // the sidebar groups, then apply the collection's `.posto` preferences so
  // the dropdown shows the same entry labels in the same order as the sidebar.
  const known = new Map<string, FileEntry>();
  for (const group of props.ctx.groups) {
    for (const file of group.files) known.set(file.path, file);
  }
  const enriched = listed.map((file) => {
    if (file.dataEntry) return file;
    const match = known.get(file.path);
    return match
      ? { ...file, title: file.title ?? match.title, frontmatter: match.frontmatter }
      : file;
  });
  const ordered = collection ? applyCollectionPrefs(enriched, collection) : enriched;

  const valueTemplate =
    typeof props.field.options?.value === "string" ? props.field.options.value : null;
  const labelTemplate =
    typeof props.field.options?.label === "string" ? props.field.options.label : null;
  const seen = new Set<string>();
  // Astro `reference()` frontmatter holds the entry id, not a path; ids come
  // from the same default-`generateId` rules Astro applies (frontmatter slug
  // override, slugified base-relative path).
  const frameworkBase =
    props.field.options?.idScheme === "framework" && props.ctx.entryIds && collection
      ? props.ctx.root + "/" + collection.path + "/"
      : null;
  const files = ordered
    .map((file) => ({
      // Pages CMS stores the repo-root-relative path by default.
      value: frameworkBase
        ? (file.dataEntry?.id ??
          props.ctx.entryIds!.derive(file.path.slice(frameworkBase.length), file.frontmatter?.slug))
        : valueTemplate
          ? referenceTemplate(valueTemplate, props.ctx.root, file)
          : file.path.slice(props.ctx.root.length + 1),
      label:
        (labelTemplate
          ? referenceTemplate(labelTemplate, props.ctx.root, file)
          : (file.title ?? file.name)) || file.name,
    }))
    .filter((option) => {
      if (option.value === "" || seen.has(option.value)) return false;
      seen.add(option.value);
      return true;
    });
  const value = asString(props.ctx.value(props.path));
  const missing = value !== "" && !files.some((f) => f.value === value);

  return (
    <AdaptiveSelect
      size="xs"
      aria-label={typeof props.field.label === "string" ? props.field.label : props.field.name}
      clearable={!props.field.required}
      searchable
      placeholder={collection ? undefined : "Unknown collection"}
      data={missing ? [{ value, label: `${value} (missing)` }, ...files] : files}
      value={value || null}
      onChange={(raw) => props.ctx.edit(props.path, raw === null || raw === "" ? undefined : raw)}
    />
  );
}

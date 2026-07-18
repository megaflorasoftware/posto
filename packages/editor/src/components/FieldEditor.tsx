import { useEffect, useState, type ReactNode } from "react";
import { ActionIcon, Button, NumberInput, Select, Switch, Textarea, TextInput } from "@mantine/core";
import { Check, GripVertical, Image, Pencil, X } from "lucide-react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { ContentEntry, Field, PagesConfig } from "@posto/core/pagescms/config";
import { collectionExtension, mediaInputPath, resolveMedia } from "@posto/core/pagescms/config";
import type { ValuePath } from "@posto/core/pagescms/frontmatter";
import type { Errors } from "@posto/core/pagescms/validate";
import type { FileEntry, FileGroup } from "@posto/ipc";
import { assetUrl, invoke } from "@posto/ipc";
import { ImagePicker } from "./ImagePicker";

export interface FieldContext {
  config: PagesConfig;
  root: string;
  /** Collection entry the edited file belongs to; scopes media resolution. */
  entry: ContentEntry | null;
  groups: FileGroup[];
  errors: () => Errors;
  /** Current value at a frontmatter path. */
  value: (path: ValuePath) => unknown;
  edit: (path: ValuePath, value: unknown) => void;
  listAppend: (path: ValuePath, value: unknown) => void;
  listRemove: (path: ValuePath, index: number) => void;
  listMove: (path: ValuePath, from: number, to: number) => void;
}

function asString(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : String(value);
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
    !field.list &&
    (field.type === "string" || field.type === "text") &&
    IMAGE_NAME.test(field.name)
  );
}

/** Right-aligned text button across from the label; opens the media picker
 * and writes the picked image's output path as the field's value. */
function PickImageCta(props: { field: Field; path: ValuePath; ctx: FieldContext }) {
  const [open, setOpen] = useState(false);
  const media = resolveMedia(props.ctx.config, props.field, props.ctx.entry);
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
        </div>
      )}
      {props.children}
      {props.field.description && <div className="field-description">{props.field.description}</div>}
      {error && <div className="field-error">{error}</div>}
    </div>
  );
}

function SingleField(props: { field: Field; path: ValuePath; ctx: FieldContext }) {
  const value = props.ctx.value(props.path);
  // Cleared text-like inputs delete the key so optional fields don't leave
  // `key: ""` litter behind in the frontmatter.
  const editText = (raw: string) => props.ctx.edit(props.path, raw === "" ? undefined : raw);

  const control = () => {
    const field = props.field;
    switch (field.type) {
      case "string":
        return (
          <TextInput
            size="xs"
            value={asString(value)}
            onChange={(e) => editText(e.currentTarget.value)}
          />
        );
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
            onChange={(e) => editText(e.currentTarget.value)}
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
          <Select
            size="xs"
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
    <FieldShell field={props.field} path={props.path} ctx={props.ctx}>
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

/**
 * One list row, draggable by its handle (dnd-kit sortable, the pattern
 * Mantine's DnD examples use). Rows are identified by index: order only
 * changes at drop time, so index ids stay stable for the whole drag.
 */
function SortableRow(props: { index: number; className: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: String(props.index),
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
  const imageChild = props.field.fields?.find((f) => f.type === "image" && !f.hidden);

  // Object-list items collapse to a summary row; existing items start
  // collapsed, newly added ones open for editing.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Drags start from the handle only (and need 5px of travel), so text
  // selection and clicks inside item fields keep working.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    moveItem(Number(active.id), Number(over.id));
  }

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
    if (imageChild) {
      const value = record[imageChild.name];
      if (typeof value === "string" && value !== "") {
        return value.split("/").pop() ?? value;
      }
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

  function thumbSrc(index: number): string | null {
    if (!imageChild) return null;
    const value = itemRecord(index)[imageChild.name];
    if (typeof value !== "string" || value === "") return null;
    const media = resolveMedia(props.ctx.config, imageChild, props.ctx.entry);
    if (!media) return null;
    const absolute = mediaInputPath(props.ctx.root, media, value);
    return absolute ? assetUrl(absolute) : null;
  }

  const objectRow = (index: number) => {
    const thumb = thumbSrc(index);
    return expanded.has(index) ? (
      <SortableRow key={index} index={index} className="list-item expanded-item">
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
      <SortableRow key={index} index={index} className="list-item collapsed-item">
        {imageChild &&
          (thumb ? (
            <img className="thumb" src={thumb} alt="" />
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
    <SortableRow key={index} index={index} className="list-item scalar-item">
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
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext
            items={items.map((_item, index) => String(index))}
            strategy={verticalListSortingStrategy}
          >
            {items.map((_item, index) => (isObjectList ? objectRow(index) : scalarRow(index)))}
          </SortableContext>
        </DndContext>
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
  const media = resolveMedia(props.ctx.config, props.field, props.ctx.entry);
  const value = asString(props.ctx.value(props.path));

  return (
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
    if (file) return file.title ?? file.name;
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
  }, [dir, extension]);

  // list_dir_files carries no frontmatter titles; recover them from the
  // sidebar groups so markdown options keep their human labels.
  const titles = new Map<string, string>();
  for (const group of props.ctx.groups) {
    for (const file of group.files) {
      if (file.title) titles.set(file.path, file.title);
    }
  }

  const valueTemplate =
    typeof props.field.options?.value === "string" ? props.field.options.value : null;
  const labelTemplate =
    typeof props.field.options?.label === "string" ? props.field.options.label : null;
  const seen = new Set<string>();
  const files = listed
    .map((file) => ({ ...file, title: file.title ?? titles.get(file.path) ?? null }))
    .map((file) => ({
      // Pages CMS stores the repo-root-relative path by default.
      value: valueTemplate
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
    <Select
      size="xs"
      clearable={!props.field.required}
      searchable
      placeholder={collection ? undefined : "Unknown collection"}
      data={missing ? [{ value, label: `${value} (missing)` }, ...files] : files}
      value={value || null}
      onChange={(raw) => props.ctx.edit(props.path, raw === null || raw === "" ? undefined : raw)}
    />
  );
}

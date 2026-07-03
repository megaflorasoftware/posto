import { useState, type ReactNode } from "react";
import { ActionIcon, Button, NumberInput, Select, Switch, Textarea, TextInput } from "@mantine/core";

import type { Field, PagesConfig } from "../pagescms/config";
import { mediaInputPath, resolveMedia } from "../pagescms/config";
import type { ValuePath } from "../pagescms/frontmatter";
import type { Errors } from "../pagescms/validate";
import type { FileGroup } from "../ipc";
import { assetUrl } from "../ipc";
import { ImagePicker } from "./ImagePicker";

export interface FieldContext {
  config: PagesConfig;
  root: string;
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
        <label className="field-label">
          {typeof props.field.label === "string" ? props.field.label : props.field.name}
          {props.field.required && <span className="field-required">*</span>}
        </label>
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
  // Rows only become draggable while the pointer is down on their handle, so
  // text selection inside expanded item fields keeps working.
  const [dragArmed, setDragArmed] = useState<number | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

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

  function resetDrag() {
    setDragArmed(null);
    setDragFrom(null);
    setDragOver(null);
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
    const media = resolveMedia(props.ctx.config, imageChild);
    if (!media) return null;
    const absolute = mediaInputPath(props.ctx.root, media, value);
    return absolute ? assetUrl(absolute) : null;
  }

  const dragHandle = (index: number) => (
    <span
      className="drag-handle"
      title="Drag to reorder"
      onMouseDown={() => setDragArmed(index)}
      onMouseUp={() => setDragArmed(null)}
    >
      ⠿
    </span>
  );

  const dragProps = (index: number) => ({
    draggable: dragArmed === index,
    onDragStart: (e: React.DragEvent) => {
      setDragFrom(index);
      e.dataTransfer.setData("text/plain", String(index));
      e.dataTransfer.effectAllowed = "move";
    },
    onDragEnd: resetDrag,
    onDragOver: (e: React.DragEvent) => {
      if (dragFrom === null) return;
      e.preventDefault();
      setDragOver(index);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      if (dragFrom !== null && dragFrom !== index) moveItem(dragFrom, index);
      resetDrag();
    },
  });

  const objectRow = (index: number) => {
    const thumb = thumbSrc(index);
    return expanded.has(index) ? (
      <div
        key={index}
        className={`list-item expanded-item${dragOver === index ? " drag-over" : ""}`}
        {...dragProps(index)}
      >
        {dragHandle(index)}
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
            ✓
          </ActionIcon>
        </div>
      </div>
    ) : (
      <div
        key={index}
        className={`list-item collapsed-item${dragOver === index ? " drag-over" : ""}`}
        {...dragProps(index)}
      >
        {dragHandle(index)}
        {imageChild &&
          (thumb ? (
            <img className="thumb" src={thumb} alt="" />
          ) : (
            <span className="thumb thumb-placeholder">🖼</span>
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
            ✎
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            disabled={items.length <= (limits.min ?? 0)}
            title="Remove"
            onClick={() => removeItem(index)}
          >
            ✕
          </ActionIcon>
        </div>
      </div>
    );
  };

  const scalarRow = (index: number) => (
    <div key={index} className="list-item">
      <div className="list-item-body">
        <FieldEditor field={itemField} path={[...props.path, index]} ctx={props.ctx} />
      </div>
      <div className="list-item-actions">
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          disabled={index === 0}
          title="Move up"
          onClick={() => props.ctx.listMove(props.path, index, index - 1)}
        >
          ↑
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          disabled={index === items.length - 1}
          title="Move down"
          onClick={() => props.ctx.listMove(props.path, index, index + 1)}
        >
          ↓
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          disabled={items.length <= (limits.min ?? 0)}
          title="Remove"
          onClick={() => removeItem(index)}
        >
          ✕
        </ActionIcon>
      </div>
    </div>
  );

  return (
    <FieldShell field={props.field} path={props.path} ctx={props.ctx}>
      <div className="list-field">
        {items.map((_item, index) => (isObjectList ? objectRow(index) : scalarRow(index)))}
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
  const media = resolveMedia(props.ctx.config, props.field);
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
          ✕
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

function ReferenceField(props: { field: Field; path: ValuePath; ctx: FieldContext }) {
  const collection = props.ctx.config.content.find(
    (entry) => entry.type === "collection" && entry.name === props.field.options?.collection,
  );
  const files = (() => {
    if (!collection) return [];
    const dir = props.ctx.root + "/" + collection.path;
    return props.ctx.groups
      .filter((group) => group.path === dir || group.path.startsWith(dir + "/"))
      .flatMap((group) => group.files)
      .map((file) => ({
        // Pages CMS stores the repo-root-relative path by default.
        value: file.path.slice(props.ctx.root.length + 1),
        label: file.title ?? file.name,
      }));
  })();
  const value = asString(props.ctx.value(props.path));
  const missing = value !== "" && !files.some((f) => f.value === value);

  return (
    <Select
      size="xs"
      clearable={!props.field.required}
      placeholder={collection ? undefined : "Unknown collection"}
      data={missing ? [{ value, label: `${value} (missing)` }, ...files] : files}
      value={value || null}
      onChange={(raw) => props.ctx.edit(props.path, raw === null || raw === "" ? undefined : raw)}
    />
  );
}

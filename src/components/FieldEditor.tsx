import { For, Show, createSignal, type JSX } from "solid-js";

import "@awesome.me/webawesome/dist/components/input/input.js";
import "@awesome.me/webawesome/dist/components/textarea/textarea.js";
import "@awesome.me/webawesome/dist/components/select/select.js";
import "@awesome.me/webawesome/dist/components/option/option.js";
import "@awesome.me/webawesome/dist/components/switch/switch.js";

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
  /** Reactive read of the current value at a frontmatter path. */
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
  return (
    <Show when={!props.field.hidden}>
      <Show
        when={props.field.list}
        fallback={<SingleField field={props.field} path={props.path} ctx={props.ctx} />}
      >
        <ListField field={props.field} path={props.path} ctx={props.ctx} />
      </Show>
    </Show>
  );
}

/** Label + description + control + inline error, shared by all field kinds. */
function FieldShell(props: {
  field: Field;
  path: ValuePath;
  ctx: FieldContext;
  children: JSX.Element;
}) {
  const error = () => props.ctx.errors().get(props.path.join("."));
  return (
    <div class="form-field" classList={{ invalid: !!error() }}>
      <Show when={props.field.label !== false}>
        <label class="field-label">
          {typeof props.field.label === "string" ? props.field.label : props.field.name}
          <Show when={props.field.required}>
            <span class="field-required">*</span>
          </Show>
        </label>
      </Show>
      {props.children}
      <Show when={props.field.description}>
        <div class="field-description">{props.field.description}</div>
      </Show>
      <Show when={error()}>
        <div class="field-error">{error()}</div>
      </Show>
    </div>
  );
}

function SingleField(props: { field: Field; path: ValuePath; ctx: FieldContext }) {
  const value = () => props.ctx.value(props.path);
  // Cleared text-like inputs delete the key so optional fields don't leave
  // `key: ""` litter behind in the frontmatter.
  const editText = (raw: string) => props.ctx.edit(props.path, raw === "" ? undefined : raw);

  const control = () => {
    const field = props.field;
    switch (field.type) {
      case "string":
        return (
          <wa-input
            attr:size="s"
            prop:value={asString(value())}
            on:input={(e: InputEvent) => editText((e.target as HTMLInputElement).value)}
          />
        );
      case "number":
        return (
          <wa-input
            attr:size="s"
            attr:type="number"
            attr:min={props.field.options?.min}
            attr:max={props.field.options?.max}
            prop:value={asString(value())}
            on:input={(e: InputEvent) => {
              const raw = (e.target as HTMLInputElement).value;
              props.ctx.edit(props.path, raw === "" ? undefined : Number(raw));
            }}
          />
        );
      case "date":
        return (
          <wa-input
            attr:size="s"
            attr:type={field.options?.time ? "datetime-local" : "date"}
            prop:value={asString(value())}
            on:input={(e: InputEvent) => editText((e.target as HTMLInputElement).value)}
          />
        );
      case "boolean":
        return (
          <wa-switch
            attr:size="s"
            prop:checked={value() === true}
            on:change={(e: Event) =>
              props.ctx.edit(props.path, (e.target as HTMLInputElement).checked)
            }
          />
        );
      case "select":
        return (
          <wa-select
            attr:size="s"
            attr:with-clear={!field.required || undefined}
            prop:value={asString(value())}
            on:input={(e: Event) => editText((e.target as HTMLSelectElement).value)}
          >
            <For each={selectValues(field)}>
              {(option) => (
                <wa-option attr:value={option.value}>{option.label}</wa-option>
              )}
            </For>
          </wa-select>
        );
      case "image":
        return <ImageField field={field} path={props.path} ctx={props.ctx} />;
      case "reference":
        return <ReferenceField field={field} path={props.path} ctx={props.ctx} />;
      case "object":
        return (
          <div class="object-fields">
            <For each={field.fields ?? []}>
              {(child) => (
                <FieldEditor field={child} path={[...props.path, child.name]} ctx={props.ctx} />
              )}
            </For>
          </div>
        );
      default:
        // text and anything the form doesn't know how to render
        return (
          <wa-textarea
            attr:size="s"
            attr:rows="3"
            attr:resize="auto"
            prop:value={asString(value())}
            on:input={(e: InputEvent) => editText((e.target as HTMLTextAreaElement).value)}
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
  const items = () => {
    const value = props.ctx.value(props.path);
    return Array.isArray(value) ? value : [];
  };
  const limits = () => (typeof props.field.list === "object" ? props.field.list : {});
  const itemField = (): Field => ({ ...props.field, list: undefined, label: false, required: false });
  const isObjectList = () => props.field.type === "object";
  const imageChild = () => props.field.fields?.find((f) => f.type === "image" && !f.hidden);

  // Object-list items collapse to a summary row; existing items start
  // collapsed, newly added ones open for editing.
  const [expanded, setExpanded] = createSignal<Set<number>>(new Set());
  // Rows only become draggable while the pointer is down on their handle, so
  // text selection inside expanded item fields keeps working.
  const [dragArmed, setDragArmed] = createSignal<number | null>(null);
  const [dragFrom, setDragFrom] = createSignal<number | null>(null);
  const [dragOver, setDragOver] = createSignal<number | null>(null);

  function setItemExpanded(index: number, on: boolean) {
    const next = new Set(expanded());
    if (on) next.add(index);
    else next.delete(index);
    setExpanded(next);
  }

  function addItem() {
    const newIndex = items().length;
    props.ctx.listAppend(props.path, newItemValue(props.field));
    if (isObjectList()) setItemExpanded(newIndex, true);
  }

  function removeItem(index: number) {
    props.ctx.listRemove(props.path, index);
    setExpanded(remapAfterRemove(expanded(), index));
  }

  function moveItem(from: number, to: number) {
    props.ctx.listMove(props.path, from, to);
    setExpanded(remapAfterMove(expanded(), from, to));
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
    const img = imageChild();
    if (img) {
      const value = record[img.name];
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
    const img = imageChild();
    if (!img) return null;
    const value = itemRecord(index)[img.name];
    if (typeof value !== "string" || value === "") return null;
    const media = resolveMedia(props.ctx.config, img);
    if (!media) return null;
    const absolute = mediaInputPath(props.ctx.root, media, value);
    return absolute ? assetUrl(absolute) : null;
  }

  const dragHandle = (index: number) => (
    <span
      class="drag-handle"
      title="Drag to reorder"
      onMouseDown={() => setDragArmed(index)}
      onMouseUp={() => setDragArmed(null)}
    >
      ⠿
    </span>
  );

  // Static handlers only — the reactive `draggable` flag is bound inline on
  // each row (values inside a spread don't reliably update in Solid).
  const dragProps = (index: () => number) => ({
    onDragStart: (e: DragEvent) => {
      setDragFrom(index());
      e.dataTransfer?.setData("text/plain", String(index()));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    },
    onDragEnd: resetDrag,
    onDragOver: (e: DragEvent) => {
      if (dragFrom() === null) return;
      e.preventDefault();
      setDragOver(index());
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const from = dragFrom();
      if (from !== null && from !== index()) moveItem(from, index());
      resetDrag();
    },
  });

  const objectRow = (index: () => number) => (
    <Show
      when={expanded().has(index())}
      fallback={
        <div
          class="list-item collapsed-item"
          classList={{ "drag-over": dragOver() === index() }}
          draggable={dragArmed() === index()}
          {...dragProps(index)}
        >
          {dragHandle(index())}
          <Show when={imageChild()}>
            <Show
              when={thumbSrc(index())}
              fallback={<span class="thumb thumb-placeholder">🖼</span>}
            >
              {(src) => <img class="thumb" src={src()} alt="" />}
            </Show>
          </Show>
          <span class="item-summary">{itemSummary(index())}</span>
          <div class="list-item-actions">
            <wa-button
              attr:size="s"
              attr:appearance="plain"
              title="Edit"
              onClick={() => setItemExpanded(index(), true)}
            >
              ✎
            </wa-button>
            <wa-button
              attr:size="s"
              attr:appearance="plain"
              attr:disabled={items().length <= (limits().min ?? 0) || undefined}
              title="Remove"
              onClick={() => removeItem(index())}
            >
              ✕
            </wa-button>
          </div>
        </div>
      }
    >
      <div
        class="list-item expanded-item"
        classList={{ "drag-over": dragOver() === index() }}
        draggable={dragArmed() === index()}
        {...dragProps(index)}
      >
        {dragHandle(index())}
        <div class="list-item-body">
          <FieldEditor field={itemField()} path={[...props.path, index()]} ctx={props.ctx} />
        </div>
        <div class="list-item-actions">
          <wa-button
            attr:size="s"
            attr:appearance="plain"
            title="Done"
            onClick={() => setItemExpanded(index(), false)}
          >
            ✓
          </wa-button>
        </div>
      </div>
    </Show>
  );

  const scalarRow = (index: () => number) => (
    <div class="list-item">
      <div class="list-item-body">
        <FieldEditor field={itemField()} path={[...props.path, index()]} ctx={props.ctx} />
      </div>
      <div class="list-item-actions">
        <wa-button
          attr:size="s"
          attr:appearance="plain"
          attr:disabled={index() === 0 || undefined}
          title="Move up"
          onClick={() => props.ctx.listMove(props.path, index(), index() - 1)}
        >
          ↑
        </wa-button>
        <wa-button
          attr:size="s"
          attr:appearance="plain"
          attr:disabled={index() === items().length - 1 || undefined}
          title="Move down"
          onClick={() => props.ctx.listMove(props.path, index(), index() + 1)}
        >
          ↓
        </wa-button>
        <wa-button
          attr:size="s"
          attr:appearance="plain"
          attr:disabled={items().length <= (limits().min ?? 0) || undefined}
          title="Remove"
          onClick={() => removeItem(index())}
        >
          ✕
        </wa-button>
      </div>
    </div>
  );

  return (
    <FieldShell field={props.field} path={props.path} ctx={props.ctx}>
      <div class="list-field">
        <For each={items()}>
          {(_item, index) => (isObjectList() ? objectRow(index) : scalarRow(index))}
        </For>
        <wa-button
          attr:size="s"
          attr:disabled={
            (limits().max !== undefined && items().length >= limits().max!) || undefined
          }
          onClick={addItem}
        >
          Add item
        </wa-button>
      </div>
    </FieldShell>
  );
}

function ImageField(props: { field: Field; path: ValuePath; ctx: FieldContext }) {
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const media = () => resolveMedia(props.ctx.config, props.field);
  const value = () => asString(props.ctx.value(props.path));

  return (
    <div class="image-field">
      <wa-input
        attr:size="s"
        attr:readonly={true}
        attr:placeholder="No image selected"
        prop:value={value()}
      />
      <wa-button
        attr:size="s"
        attr:disabled={!media() || undefined}
        onClick={() => setPickerOpen(true)}
      >
        Browse…
      </wa-button>
      <Show when={value()}>
        <wa-button
          attr:size="s"
          attr:appearance="plain"
          title="Clear"
          onClick={() => props.ctx.edit(props.path, undefined)}
        >
          ✕
        </wa-button>
      </Show>
      <Show when={pickerOpen() && media()}>
        {(m) => (
          <ImagePicker
            root={props.ctx.root}
            media={m()}
            onClose={() => setPickerOpen(false)}
            onPick={(outputPath) => {
              setPickerOpen(false);
              props.ctx.edit(props.path, outputPath);
            }}
          />
        )}
      </Show>
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
  const collection = () =>
    props.ctx.config.content.find(
      (entry) => entry.type === "collection" && entry.name === props.field.options?.collection,
    );
  const files = () => {
    const target = collection();
    if (!target) return [];
    const dir = props.ctx.root + "/" + target.path;
    return props.ctx.groups
      .filter((group) => group.path === dir || group.path.startsWith(dir + "/"))
      .flatMap((group) => group.files)
      .map((file) => ({
        // Pages CMS stores the repo-root-relative path by default.
        value: file.path.slice(props.ctx.root.length + 1),
        label: file.title ?? file.name,
      }));
  };
  const value = () => asString(props.ctx.value(props.path));
  const missing = () => value() !== "" && !files().some((f) => f.value === value());

  return (
    <wa-select
      attr:size="s"
      attr:with-clear={!props.field.required || undefined}
      attr:placeholder={collection() ? undefined : "Unknown collection"}
      prop:value={value()}
      on:input={(e: Event) => {
        const raw = (e.target as HTMLSelectElement).value;
        props.ctx.edit(props.path, raw === "" ? undefined : raw);
      }}
    >
      <Show when={missing()}>
        <wa-option attr:value={value()}>{value()} (missing)</wa-option>
      </Show>
      <For each={files()}>
        {(file) => <wa-option attr:value={file.value}>{file.label}</wa-option>}
      </For>
    </wa-select>
  );
}

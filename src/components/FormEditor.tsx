import { For, Show, createEffect, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";

import type { ContentEntry, Field, PagesConfig } from "../pagescms/config";
import { frontmatterFields, inferFields } from "../pagescms/config";
import {
  type ParsedFile,
  type ValuePath,
  appendListItem,
  deleteValue,
  getValue,
  moveListItem,
  parseFile,
  removeListItem,
  serializeFile,
  setValue,
} from "../pagescms/frontmatter";
import { type Errors, validateForm } from "../pagescms/validate";
import type { FileGroup } from "../ipc";
import { FieldEditor, type FieldContext } from "./FieldEditor";

function plainValues(parsed: ParsedFile): Record<string, unknown> {
  const js = parsed.doc.toJS();
  return js && typeof js === "object" && !Array.isArray(js)
    ? (js as Record<string, unknown>)
    : {};
}

/**
 * The Form tab. Owns the parsed YAML Document (kept outside Solid so edits
 * round-trip through the same nodes, preserving comments and key order) and
 * mirrors its values into a store for fine-grained control updates. Emits the
 * full serialized file on every edit; the parent decides whether to save.
 */
export function FormEditor(props: {
  content: string;
  /** null for markdown files without a schema — fields are inferred from the
   * frontmatter's shape instead, with no validation. */
  entry: ContentEntry | null;
  config: PagesConfig;
  root: string;
  groups: FileGroup[];
  onChange: (content: string, valid: boolean) => void;
}) {
  let parsed = parseFile(props.content);
  // Content emitted by this component; used to ignore the echo when it comes
  // back through props and only re-parse genuinely external changes.
  let lastEmitted: string | null = null;
  // Opening a file never dirties it: schema defaults for absent keys are
  // written together with the first real edit.
  let defaultsApplied = false;
  // The blank line separating frontmatter from body is kept out of the body
  // textarea but restored verbatim on save.
  let bodyPrefix = parsed.body.match(/^\r?\n/)?.[0] ?? "";

  // Inferred fields are recomputed only when external content arrives (file
  // switch, raw edits) — never from this component's own edits, so fields
  // don't shift around while the user types.
  const [inferred, setInferred] = createSignal<Field[]>(
    props.entry ? [] : inferFields(plainValues(parsed)),
  );
  const fields = () => (props.entry ? frontmatterFields(props.entry) : inferred());
  const [values, setValues] = createStore<Record<string, unknown>>(plainValues(parsed));
  const [body, setBody] = createSignal(parsed.body.slice(bodyPrefix.length));
  const [errors, setErrors] = createSignal<Errors>(validateForm(fields(), plainValues(parsed)));
  const [parseError, setParseError] = createSignal(parsed.error ?? null);

  createEffect(() => {
    const content = props.content;
    if (content === lastEmitted) return;
    parsed = parseFile(content);
    lastEmitted = null;
    defaultsApplied = false;
    setParseError(parsed.error ?? null);
    setValues(reconcile(plainValues(parsed)));
    if (!props.entry) setInferred(inferFields(plainValues(parsed)));
    bodyPrefix = parsed.body.match(/^\r?\n/)?.[0] ?? "";
    setBody(parsed.body.slice(bodyPrefix.length));
    setErrors(validateForm(fields(), plainValues(parsed)));
  });

  function materializeDefaults(fieldList: Field[], base: ValuePath) {
    for (const field of fieldList) {
      if (field.name === "body") continue;
      const path = [...base, field.name];
      const current = getValue(parsed.doc, path);
      if (current === undefined) {
        if (field.default !== undefined) setValue(parsed.doc, path, field.default);
      } else if (field.type === "object" && !field.list && field.fields) {
        materializeDefaults(field.fields, path);
      }
    }
  }

  function emit() {
    const current = plainValues(parsed);
    setValues(reconcile(current));
    const errs = validateForm(fields(), current);
    setErrors(errs);
    const content = serializeFile(parsed);
    lastEmitted = content;
    props.onChange(content, errs.size === 0);
  }

  function beforeEdit() {
    if (!defaultsApplied) {
      defaultsApplied = true;
      materializeDefaults(fields(), []);
    }
  }

  const ctx: FieldContext = {
    get config() {
      return props.config;
    },
    get root() {
      return props.root;
    },
    get groups() {
      return props.groups;
    },
    errors,
    value: (path) => {
      let v: unknown = values;
      for (const key of path) {
        if (v === null || typeof v !== "object") return undefined;
        v = (v as Record<string | number, unknown>)[key as string | number];
      }
      return v;
    },
    edit: (path, value) => {
      beforeEdit();
      // Without a schema, a cleared control writes "" instead of deleting the
      // key — inferred fields exist only while their key does.
      if (value === undefined && !props.entry) value = "";
      if (value === undefined) deleteValue(parsed.doc, path);
      else setValue(parsed.doc, path, value);
      emit();
    },
    listAppend: (path, value) => {
      beforeEdit();
      appendListItem(parsed.doc, path, value);
      emit();
    },
    listRemove: (path, index) => {
      beforeEdit();
      removeListItem(parsed.doc, path, index);
      emit();
    },
    listMove: (path, from, to) => {
      beforeEdit();
      moveListItem(parsed.doc, path, from, to);
      emit();
    },
  };

  function onBodyEdit(text: string) {
    beforeEdit();
    parsed.body = bodyPrefix + text;
    setBody(text);
    const content = serializeFile(parsed);
    lastEmitted = content;
    props.onChange(content, errors().size === 0);
  }

  return (
    <Show
      when={!parseError()}
      fallback={
        <div class="form-unavailable">
          <wa-callout variant="warning">
            Form editing is unavailable: the frontmatter has a YAML syntax error. Fix it in the
            Raw tab.
          </wa-callout>
        </div>
      }
    >
      <div class="form-editor">
        <div class="form-fields">
          <For each={fields()}>
            {(field) => <FieldEditor field={field} path={[field.name]} ctx={ctx} />}
          </For>
        </div>
        <div class="form-body">
          <label class="field-label">Body</label>
          <textarea
            class="editor form-body-editor"
            spellcheck={false}
            value={body()}
            onInput={(e) => onBodyEdit(e.currentTarget.value)}
          />
        </div>
      </div>
    </Show>
  );
}

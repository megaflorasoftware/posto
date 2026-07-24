import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert } from "@mantine/core";

import type { ContentEntry, Field, PagesConfig } from "@posto/core/pagescms/config";
import { expandFieldTemplate, frontmatterFields, inferFields } from "@posto/core/pagescms/config";
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
} from "@posto/core/pagescms/frontmatter";
import { type Errors, validateForm } from "@posto/core/pagescms/validate";
import type { FileGroup } from "@posto/ipc";
import type { ComponentSchemaSource } from "@posto/core/project/adapter";
import type { EntryIdSource } from "@posto/core/project/entryIds";
import { BodyEditor } from "./BodyEditor";
import { FieldEditor, type FieldContext } from "./FieldEditor";

/** Schema field a frontmatter path lands on; numeric list indices stay on
 * the list's own field definition. Null for paths the schema doesn't know. */
function fieldAt(fields: Field[], path: ValuePath): Field | null {
  let scope = fields;
  let found: Field | null = null;
  for (const key of path) {
    if (typeof key === "number") continue;
    found = scope.find((f) => f.name === key) ?? null;
    if (!found) return null;
    scope = found.fields ?? [];
  }
  return found;
}

function plainValues(parsed: ParsedFile): Record<string, unknown> {
  const js = parsed.doc.toJS();
  return js && typeof js === "object" && !Array.isArray(js) ? (js as Record<string, unknown>) : {};
}

/**
 * The Form tab. Owns the parsed YAML Document (kept in refs outside React so
 * edits round-trip through the same nodes, preserving comments and key order)
 * and mirrors its values into state for control updates. Emits the full
 * serialized file on every edit; the parent decides whether to save.
 */
export function FormEditor(props: {
  content: string;
  /** Absolute path of the open file; decides rich vs plain body editing. */
  path: string;
  /** null for markdown files without a schema — fields are inferred from the
   * frontmatter's shape instead, with no validation. */
  entry: ContentEntry | null;
  config: PagesConfig;
  root: string;
  groups: FileGroup[];
  componentBlocks: ComponentSchemaSource | null;
  entryIds: EntryIdSource | null;
  componentSchemaVersion?: number;
  fieldsHeader?: ReactNode;
  onChange: (content: string, valid: boolean) => void;
  onPostoSaved?: () => void;
}) {
  const parsedRef = useRef<ParsedFile>(null as unknown as ParsedFile);
  // Content emitted by this component; used to ignore the echo when it comes
  // back through props and only re-parse genuinely external changes.
  const lastEmitted = useRef<string | null>(null);
  // Content already reflected in local state, so the effect below only reacts
  // to changes it hasn't seen (React re-runs it after our own setStates too).
  const processed = useRef<string | null>(null);
  // Opening a file never dirties it: schema defaults for absent keys are
  // written together with the first real edit.
  const defaultsApplied = useRef(false);
  // The blank line separating frontmatter from body is kept out of the body
  // textarea but restored verbatim on save.
  const bodyPrefix = useRef("");

  if (processed.current === null) {
    parsedRef.current = parseFile(props.content);
    bodyPrefix.current = parsedRef.current.body.match(/^\r?\n/)?.[0] ?? "";
    processed.current = props.content;
  }

  // Inferred fields are recomputed only when external content arrives (file
  // switch, raw edits) — never from this component's own edits, so fields
  // don't shift around while the user types.
  const [inferred, setInferred] = useState<Field[]>(() =>
    props.entry ? [] : inferFields(plainValues(parsedRef.current)),
  );
  const fields = props.entry ? frontmatterFields(props.entry) : inferred;
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    plainValues(parsedRef.current),
  );
  const [body, setBody] = useState(() => parsedRef.current.body.slice(bodyPrefix.current.length));
  const [errors, setErrors] = useState<Errors>(() =>
    validateForm(fields, plainValues(parsedRef.current)),
  );
  const [parseError, setParseError] = useState(() => parsedRef.current.error ?? null);

  useEffect(() => {
    const content = props.content;
    if (content === processed.current) return;
    processed.current = content;
    if (content === lastEmitted.current) return;
    const parsed = parseFile(content);
    parsedRef.current = parsed;
    lastEmitted.current = null;
    defaultsApplied.current = false;
    setParseError(parsed.error ?? null);
    const current = plainValues(parsed);
    setValues(current);
    let fieldList = fields;
    if (!props.entry) {
      fieldList = inferFields(current);
      setInferred(fieldList);
    }
    bodyPrefix.current = parsed.body.match(/^\r?\n/)?.[0] ?? "";
    setBody(parsed.body.slice(bodyPrefix.current.length));
    setErrors(validateForm(fieldList, current));
  });

  function materializeDefaults(fieldList: Field[], base: ValuePath) {
    for (const field of fieldList) {
      if (field.name === "body") continue;
      const path = [...base, field.name];
      const current = getValue(parsedRef.current.doc, path);
      if (current === undefined) {
        if (field.default !== undefined) {
          setValue(parsedRef.current.doc, path, field.default, {
            dateField: field.type === "date",
          });
        }
      } else if (field.type === "object" && !field.list && field.fields) {
        materializeDefaults(field.fields, path);
      }
    }
  }

  function emit() {
    const current = plainValues(parsedRef.current);
    setValues(current);
    const errs = validateForm(fields, current);
    setErrors(errs);
    const content = serializeFile(parsedRef.current);
    lastEmitted.current = content;
    props.onChange(content, errs.size === 0);
  }

  /** Recompute every controlled field after an item edit. Unrelated
   * templates resolve to their existing value, while repeated passes let
   * controlled fields feed one another without relying on fragile path-key
   * comparisons for nested schemas. */
  function applyControlledTemplates() {
    const schemas = props.entry?.fieldSchemas;
    if (!schemas) return;
    const controlled = Object.entries(schemas).filter(
      ([name, schema]) =>
        name !== "filename" && schema.template && schema.editBehavior === "controlled",
    );
    for (let pass = 0; pass <= controlled.length; pass++) {
      let changed = false;
      for (const [name, schema] of Object.entries(schemas)) {
        if (name === "filename" || !schema.template || schema.editBehavior !== "controlled")
          continue;
        const values = plainValues(parsedRef.current);
        const expanded = expandFieldTemplate(schema.template, values);
        const path = name.split(".");
        if (expanded === null || getValue(parsedRef.current.doc, path) === expanded) continue;
        setValue(parsedRef.current.doc, path, expanded);
        changed = true;
      }
      if (!changed) break;
    }
  }

  function beforeEdit() {
    if (!defaultsApplied.current) {
      defaultsApplied.current = true;
      materializeDefaults(fields, []);
    }
  }

  const ctx: FieldContext = {
    config: props.config,
    root: props.root,
    entry: props.entry,
    groups: props.groups,
    entryIds: props.entryIds,
    errors: () => errors,
    templateValues: () => values,
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
      if (value === undefined) {
        deleteValue(parsedRef.current.doc, path);
      } else {
        setValue(parsedRef.current.doc, path, value, {
          dateField: fieldAt(fields, path)?.type === "date",
        });
      }
      applyControlledTemplates();
      emit();
    },
    listAppend: (path, value) => {
      beforeEdit();
      appendListItem(parsedRef.current.doc, path, value);
      emit();
    },
    listRemove: (path, index) => {
      beforeEdit();
      removeListItem(parsedRef.current.doc, path, index);
      emit();
    },
    listMove: (path, from, to) => {
      beforeEdit();
      moveListItem(parsedRef.current.doc, path, from, to);
      emit();
    },
    onPostoSaved: props.onPostoSaved,
  };

  function onBodyEdit(text: string) {
    beforeEdit();
    parsedRef.current.body = bodyPrefix.current + text;
    setBody(text);
    const content = serializeFile(parsedRef.current);
    lastEmitted.current = content;
    props.onChange(content, errors.size === 0);
  }

  if (parseError) {
    return (
      <div className="form-unavailable">
        <Alert color="yellow">
          Form editing is unavailable: the frontmatter has a YAML syntax error. Fix it in the raw
          file view.
        </Alert>
      </div>
    );
  }

  const media = props.entry?.media ?? null;
  const bodyEditor = /\.(md|mdx|markdown)$/i.test(props.path) ? (
    <BodyEditor
      value={body}
      path={props.path}
      mdx={/\.mdx$/i.test(props.path)}
      root={props.root}
      configuredMedia={media}
      entry={props.entry}
      templateValues={values}
      config={props.config}
      groups={props.groups}
      componentBlocks={props.componentBlocks}
      entryIds={props.entryIds}
      componentSchemaVersion={props.componentSchemaVersion}
      onChange={onBodyEdit}
    />
  ) : (
    <textarea
      className="editor"
      spellCheck={false}
      placeholder="Start writing..."
      value={body}
      onChange={(e) => onBodyEdit(e.currentTarget.value)}
    />
  );

  return (
    <div className="form-editor form-editor-combined">
      <div className="form-fields">
        {props.fieldsHeader}
        {fields.map((field) => (
          <FieldEditor key={field.name} field={field} path={[field.name]} ctx={ctx} />
        ))}
      </div>
      <section className="form-body-section" aria-label="Body">
        {bodyEditor}
      </section>
    </div>
  );
}

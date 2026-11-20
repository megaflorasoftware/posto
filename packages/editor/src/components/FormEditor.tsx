import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert } from "@mantine/core";

import type { ContentEntry, Field, PagesConfig } from "@posto/core/pagescms/config";
import { frontmatterFields, inferFields, plainDateField } from "@posto/core/pagescms/config";
import {
  type ParsedFile,
  appendListItem,
  deleteValue,
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
import { applyControlledTemplates, fieldAt, materializeDefaults, plainValues } from "../formModel";

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
  onBeforeMediaChange?: () => Promise<void>;
  onMediaChanged?: (options?: { silent?: boolean }) => void;
  onChange: (content: string, valid: boolean) => void;
  onPostoSaved?: () => void;
  onReferenceCreated?: (collection: ContentEntry) => Promise<void> | void;
}) {
  const [initialParsed] = useState(() => parseFile(props.content));
  const parsedRef = useRef<ParsedFile>(initialParsed);
  // Content emitted by this component; used to ignore the echo when it comes
  // back through props and only re-parse genuinely external changes.
  const lastEmitted = useRef<string | null>(null);
  // Content already reflected in local state, so the effect below only reacts
  // to changes it hasn't seen (React re-runs it after our own setStates too).
  const processed = useRef<string | null>(props.content);
  // Opening a file never dirties it: schema defaults for absent keys are
  // written together with the first real edit.
  const defaultsApplied = useRef(false);
  // The blank line separating frontmatter from body is kept out of the body
  // textarea but restored verbatim on save.
  const bodyPrefix = useRef(initialParsed.body.match(/^\r?\n/)?.[0] ?? "");

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

  function emit() {
    const current = plainValues(parsedRef.current);
    setValues(current);
    const errs = validateForm(fields, current);
    setErrors(errs);
    const content = serializeFile(parsedRef.current);
    lastEmitted.current = content;
    props.onChange(content, errs.size === 0);
  }

  function beforeEdit() {
    if (!defaultsApplied.current) {
      defaultsApplied.current = true;
      materializeDefaults(parsedRef.current.doc, fields, []);
    }
  }

  const ctx: FieldContext = {
    config: props.config,
    root: props.root,
    entry: props.entry,
    documentPath: props.path,
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
          dateField: plainDateField(fieldAt(fields, path)),
        });
      }
      applyControlledTemplates(parsedRef.current.doc, props.entry);
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
    onReferenceCreated: props.onReferenceCreated,
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
      onBeforeMediaChange={props.onBeforeMediaChange}
      onMediaChanged={props.onMediaChanged}
      onChange={onBodyEdit}
    />
  ) : (
    <>
      <label className="field-label" htmlFor="form-editor-body">
        Body
      </label>
      <textarea
        id="form-editor-body"
        className="editor"
        spellCheck={false}
        placeholder="Start writing..."
        value={body}
        onChange={(e) => onBodyEdit(e.currentTarget.value)}
      />
    </>
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

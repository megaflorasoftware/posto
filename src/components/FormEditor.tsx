import { useEffect, useRef, useState } from "react";
import { Alert } from "@mantine/core";

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
import { BodyEditor } from "./BodyEditor";
import { FieldEditor, type FieldContext } from "./FieldEditor";

function plainValues(parsed: ParsedFile): Record<string, unknown> {
  const js = parsed.doc.toJS();
  return js && typeof js === "object" && !Array.isArray(js)
    ? (js as Record<string, unknown>)
    : {};
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
  /** Which half of the form to show: frontmatter fields or the body editor. */
  view: "fields" | "body";
  /** null for markdown files without a schema — fields are inferred from the
   * frontmatter's shape instead, with no validation. */
  entry: ContentEntry | null;
  config: PagesConfig;
  root: string;
  groups: FileGroup[];
  onChange: (content: string, valid: boolean) => void;
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
        if (field.default !== undefined) setValue(parsedRef.current.doc, path, field.default);
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

  function beforeEdit() {
    if (!defaultsApplied.current) {
      defaultsApplied.current = true;
      materializeDefaults(fields, []);
    }
  }

  const ctx: FieldContext = {
    config: props.config,
    root: props.root,
    groups: props.groups,
    errors: () => errors,
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
      if (value === undefined) deleteValue(parsedRef.current.doc, path);
      else setValue(parsedRef.current.doc, path, value);
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
          Form editing is unavailable: the frontmatter has a YAML syntax error. Fix it in the Raw
          tab.
        </Alert>
      </div>
    );
  }

  if (props.view === "body") {
    // Rich editing for the markdown family (MDX mode adds import pills,
    // component cards, and raw-JSX preservation); plain text for anything else.
    return /\.(md|mdx|markdown)$/i.test(props.path) ? (
      <BodyEditor
        value={body}
        path={props.path}
        mdx={/\.mdx$/i.test(props.path)}
        root={props.root}
        media={props.config.media[0] ?? null}
        config={props.config}
        groups={props.groups}
        onChange={onBodyEdit}
      />
    ) : (
      <textarea
        className="editor"
        spellCheck={false}
        value={body}
        onChange={(e) => onBodyEdit(e.currentTarget.value)}
      />
    );
  }

  return (
    <div className="form-editor">
      <div className="form-fields">
        {fields.map((field) => (
          <FieldEditor key={field.name} field={field} path={[field.name]} ctx={ctx} />
        ))}
      </div>
    </div>
  );
}

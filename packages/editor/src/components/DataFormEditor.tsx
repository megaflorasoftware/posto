import { useEffect, useRef, useState } from "react";
import { Alert } from "@mantine/core";
import type { ContentEntry, Field, PagesConfig } from "@posto/core/pagescms/config";
import {
  appendDataListItem,
  dataDocumentEntries,
  dataEntryValues,
  deleteDataValue,
  moveDataListItem,
  parseDataDocument,
  removeDataListItem,
  serializeDataDocument,
  setDataValue,
  type DataEntryLocator,
  type ParsedDataDocument,
} from "@posto/core/astro/dataDocument";
import { validateForm, type Errors } from "@posto/core/pagescms/validate";
import type { FileEntry, FileGroup } from "@posto/ipc";
import { FieldEditor, type FieldContext } from "./FieldEditor";

function fieldAt(fields: Field[], path: (string | number)[]): Field | null {
  let scope = fields;
  let found: Field | null = null;
  for (const key of path) {
    if (typeof key === "number") continue;
    found = scope.find((field) => field.name === key) ?? null;
    if (!found) return null;
    scope = found.fields ?? [];
  }
  return found;
}

export function DataFormEditor(props: {
  content: string;
  entry: ContentEntry;
  dataEntry: NonNullable<FileEntry["dataEntry"]>;
  config: PagesConfig;
  root: string;
  groups: FileGroup[];
  onChange: (content: string, valid: boolean) => void;
  beforeMediaOperation?: () => void | Promise<void>;
}) {
  const parsedRef = useRef<ParsedDataDocument>(null as unknown as ParsedDataDocument);
  const locatorRef = useRef<DataEntryLocator>({ id: props.dataEntry.id, path: props.dataEntry.path });
  const processed = useRef<string | null>(null);
  const lastEmitted = useRef<string | null>(null);
  const defaultsApplied = useRef(false);
  const fields = props.entry.fields.filter((field) => field.name !== "body");

  function parse(content: string) {
    const parsed = parseDataDocument(content, props.dataEntry.format);
    const current = dataDocumentEntries(parsed).find((item) => item.id === props.dataEntry.id);
    if (current) locatorRef.current = current;
    return parsed;
  }

  if (processed.current === null) {
    parsedRef.current = parse(props.content);
    processed.current = props.content;
  }

  const initial = dataEntryValues(parsedRef.current, locatorRef.current) ?? {};
  const [values, setValues] = useState<Record<string, unknown>>(initial);
  const [errors, setErrors] = useState<Errors>(() => validateForm(fields, initial));
  const [parseError, setParseError] = useState(parsedRef.current.error ?? null);

  useEffect(() => {
    if (props.content === processed.current) return;
    processed.current = props.content;
    if (props.content === lastEmitted.current) return;
    parsedRef.current = parse(props.content);
    lastEmitted.current = null;
    defaultsApplied.current = false;
    setParseError(parsedRef.current.error ?? null);
    const current = dataEntryValues(parsedRef.current, locatorRef.current) ?? {};
    setValues(current);
    setErrors(validateForm(fields, current));
  });

  function materializeDefaults(fieldList: Field[], base: (string | number)[]) {
    const current = dataEntryValues(parsedRef.current, locatorRef.current) ?? {};
    for (const field of fieldList) {
      const path = [...base, field.name];
      let value: unknown = current;
      for (const key of path) {
        if (value === null || typeof value !== "object") {
          value = undefined;
          break;
        }
        value = (value as Record<string, unknown>)[String(key)];
      }
      if (value === undefined && field.default !== undefined) {
        setDataValue(parsedRef.current, [...locatorRef.current.path, ...path], field.default, {
          dateField: field.type === "date",
        });
      } else if (field.type === "object" && !field.list && field.fields) {
        materializeDefaults(field.fields, path);
      }
    }
  }

  function beforeEdit() {
    if (defaultsApplied.current) return;
    defaultsApplied.current = true;
    materializeDefaults(fields, []);
  }

  function emit() {
    const current = dataEntryValues(parsedRef.current, locatorRef.current) ?? {};
    setValues(current);
    const nextErrors = validateForm(fields, current);
    setErrors(nextErrors);
    const content = serializeDataDocument(parsedRef.current);
    lastEmitted.current = content;
    props.onChange(content, nextErrors.size === 0);
  }

  const fullPath = (path: (string | number)[]) => [...locatorRef.current.path, ...path];
  const ctx: FieldContext = {
    config: props.config,
    root: props.root,
    entry: props.entry,
    groups: props.groups,
    beforeMediaOperation: props.beforeMediaOperation,
    errors: () => errors,
    templateValues: () => values,
    value: (path) => {
      let value: unknown = values;
      for (const key of path) {
        if (value === null || typeof value !== "object") return undefined;
        value = (value as Record<string | number, unknown>)[key];
      }
      return value;
    },
    edit: (path, value) => {
      beforeEdit();
      if (value === undefined) deleteDataValue(parsedRef.current, fullPath(path));
      else {
        setDataValue(parsedRef.current, fullPath(path), value, {
          dateField: fieldAt(fields, path)?.type === "date",
        });
      }
      emit();
    },
    listAppend: (path, value) => {
      beforeEdit();
      appendDataListItem(parsedRef.current, fullPath(path), value);
      emit();
    },
    listRemove: (path, index) => {
      beforeEdit();
      removeDataListItem(parsedRef.current, fullPath(path), index);
      emit();
    },
    listMove: (path, from, to) => {
      beforeEdit();
      moveDataListItem(parsedRef.current, fullPath(path), from, to);
      emit();
    },
  };

  if (parseError) {
    return <Alert color="yellow">Form editing is unavailable: {parseError}</Alert>;
  }
  if (!dataEntryValues(parsedRef.current, locatorRef.current)) {
    return <Alert color="yellow">This entry no longer exists in the backing data file.</Alert>;
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

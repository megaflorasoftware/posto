/**
 * Headless form models behind the native editor: the same edit pipeline as
 * FormEditor (markdown frontmatter) and DataFormEditor (an entry inside a
 * JSON/YAML/TOML data document). Each keeps the parsed document between
 * edits so comments and key order survive, writes schema defaults with the
 * first real edit, recomputes controlled templates, and reports validity.
 */
import {
  expandFieldTemplate,
  frontmatterFields,
  inferFields,
  plainDateField,
  type ContentEntry,
  type Field,
} from "@posto/core/pagescms/config";
import {
  appendListItem,
  deleteValue,
  moveListItem,
  parseFile,
  removeListItem,
  serializeFile,
  setValue,
  type ParsedFile,
  type ValuePath,
} from "@posto/core/pagescms/frontmatter";
import { validateForm, type Errors } from "@posto/core/pagescms/validate";
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
  type DataDocumentFormat,
  type DataEntryLocator,
  type ParsedDataDocument,
} from "@posto/core/project/dataDocument";
import {
  applyControlledTemplates,
  fieldAt,
  materializeDefaults,
  plainValues,
} from "../../../../packages/editor/src/formModel";

/** Result of an edit: the whole serialized file and whether it validates. */
export interface FormEmit {
  content: string;
  valid: boolean;
}

export interface FormStore {
  readonly fields: Field[];
  readonly parseError: string | null;
  values(): Record<string, unknown>;
  errors(): Errors;
  edit(path: ValuePath, value: unknown): FormEmit;
  listAppend(path: ValuePath, value: unknown): FormEmit;
  listRemove(path: ValuePath, index: number): FormEmit;
  listMove(path: ValuePath, from: number, to: number): FormEmit;
}

export class FrontmatterForm implements FormStore {
  private parsed: ParsedFile;
  private defaultsApplied = false;
  private readonly bodyPrefix: string;
  readonly fields: Field[];
  private currentErrors: Errors;

  constructor(
    content: string,
    private readonly entry: ContentEntry | null,
  ) {
    this.parsed = parseFile(content);
    this.bodyPrefix = this.parsed.body.match(/^\r?\n/)?.[0] ?? "";
    // Without a schema the fields are inferred once per load, so they don't
    // shift around while the user types.
    this.fields = entry ? frontmatterFields(entry) : inferFields(plainValues(this.parsed));
    this.currentErrors = validateForm(this.fields, this.values());
  }

  get parseError(): string | null {
    return this.parsed.error ?? null;
  }

  values(): Record<string, unknown> {
    return plainValues(this.parsed);
  }

  errors(): Errors {
    return this.currentErrors;
  }

  /** The body as the editor shows it: without the frontmatter's blank line. */
  body(): string {
    return this.parsed.body.slice(this.bodyPrefix.length);
  }

  private beforeEdit() {
    if (this.defaultsApplied) return;
    this.defaultsApplied = true;
    materializeDefaults(this.parsed.doc, this.fields, []);
  }

  private emit(): FormEmit {
    this.currentErrors = validateForm(this.fields, this.values());
    return { content: serializeFile(this.parsed), valid: this.currentErrors.size === 0 };
  }

  edit(path: ValuePath, value: unknown): FormEmit {
    this.beforeEdit();
    // Without a schema, a cleared control writes "" instead of deleting the
    // key — inferred fields exist only while their key does.
    if (value === undefined && !this.entry) value = "";
    if (value === undefined) deleteValue(this.parsed.doc, path);
    else {
      setValue(this.parsed.doc, path, value, {
        dateField: plainDateField(fieldAt(this.fields, path)),
      });
    }
    applyControlledTemplates(this.parsed.doc, this.entry);
    return this.emit();
  }

  listAppend(path: ValuePath, value: unknown): FormEmit {
    this.beforeEdit();
    appendListItem(this.parsed.doc, path, value);
    return this.emit();
  }

  listRemove(path: ValuePath, index: number): FormEmit {
    this.beforeEdit();
    removeListItem(this.parsed.doc, path, index);
    return this.emit();
  }

  listMove(path: ValuePath, from: number, to: number): FormEmit {
    this.beforeEdit();
    moveListItem(this.parsed.doc, path, from, to);
    return this.emit();
  }

  /** Body edits keep the last validation result, as FormEditor does. */
  setBody(text: string): FormEmit {
    this.beforeEdit();
    this.parsed.body = this.bodyPrefix + text;
    return { content: serializeFile(this.parsed), valid: this.currentErrors.size === 0 };
  }
}

function valueAt(values: unknown, path: ValuePath): unknown {
  let current = values;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

export class DataEntryForm implements FormStore {
  private parsed: ParsedDataDocument;
  private locator: DataEntryLocator;
  private defaultsApplied = false;
  readonly fields: Field[];
  private currentErrors: Errors;

  constructor(
    content: string,
    private readonly entry: ContentEntry,
    dataEntry: { id: string; path: (string | number)[]; format: DataDocumentFormat },
  ) {
    this.parsed = parseDataDocument(content, dataEntry.format);
    this.locator = dataDocumentEntries(this.parsed).find((item) => item.id === dataEntry.id) ?? {
      id: dataEntry.id,
      path: dataEntry.path,
    };
    this.fields = entry.fields.filter((field) => field.name !== "body");
    this.currentErrors = validateForm(this.fields, this.values());
  }

  get parseError(): string | null {
    return this.parsed.error ?? null;
  }

  /** Null when the entry no longer exists in the document. */
  get missing(): boolean {
    return dataEntryValues(this.parsed, this.locator) === null;
  }

  values(): Record<string, unknown> {
    return dataEntryValues(this.parsed, this.locator) ?? {};
  }

  errors(): Errors {
    return this.currentErrors;
  }

  private full(path: ValuePath): ValuePath {
    return [...this.locator.path, ...path];
  }

  private materialize(fieldList: Field[], base: ValuePath) {
    const current = this.values();
    for (const field of fieldList) {
      const path = [...base, field.name];
      const value = valueAt(current, path);
      if (value === undefined && field.default !== undefined) {
        setDataValue(this.parsed, this.full(path), field.default, {
          dateField: plainDateField(field),
        });
      } else if (field.type === "object" && !field.list && field.fields) {
        this.materialize(field.fields, path);
      }
    }
  }

  private beforeEdit() {
    if (this.defaultsApplied) return;
    this.defaultsApplied = true;
    this.materialize(this.fields, []);
  }

  private applyControlledTemplates() {
    const schemas = this.entry.fieldSchemas;
    if (!schemas) return;
    const controlled = Object.entries(schemas).filter(
      ([name, schema]) =>
        name !== "filename" && schema.template && schema.editBehavior === "controlled",
    );
    for (let pass = 0; pass <= controlled.length; pass++) {
      let changed = false;
      for (const [name, schema] of controlled) {
        const values = this.values();
        const expanded = expandFieldTemplate(schema.template!, values);
        const path = name.split(".");
        if (expanded === null || valueAt(values, path) === expanded) continue;
        setDataValue(this.parsed, this.full(path), expanded);
        changed = true;
      }
      if (!changed) break;
    }
  }

  private emit(): FormEmit {
    this.currentErrors = validateForm(this.fields, this.values());
    return { content: serializeDataDocument(this.parsed), valid: this.currentErrors.size === 0 };
  }

  edit(path: ValuePath, value: unknown): FormEmit {
    this.beforeEdit();
    if (value === undefined) deleteDataValue(this.parsed, this.full(path));
    else {
      setDataValue(this.parsed, this.full(path), value, {
        dateField: plainDateField(fieldAt(this.fields, path)),
      });
    }
    this.applyControlledTemplates();
    return this.emit();
  }

  listAppend(path: ValuePath, value: unknown): FormEmit {
    this.beforeEdit();
    appendDataListItem(this.parsed, this.full(path), value);
    return this.emit();
  }

  listRemove(path: ValuePath, index: number): FormEmit {
    this.beforeEdit();
    removeDataListItem(this.parsed, this.full(path), index);
    return this.emit();
  }

  listMove(path: ValuePath, from: number, to: number): FormEmit {
    this.beforeEdit();
    moveDataListItem(this.parsed, this.full(path), from, to);
    return this.emit();
  }
}

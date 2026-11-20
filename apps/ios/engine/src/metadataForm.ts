/**
 * A form over a plain metadata object (image library entries, import drafts),
 * with the same edit/list API as the document forms so SwiftUI renders both
 * through one field renderer.
 */
import type { Field } from "@posto/core/pagescms/config";
import type { ValuePath } from "@posto/core/pagescms/frontmatter";
import { validateForm, type Errors } from "@posto/core/pagescms/validate";
import { editValueAtPath, valueAtPath } from "../../../../packages/editor/src/imageLibraryMetadata";
import type { FormEmit, FormStore } from "./forms";

export class MetadataForm implements FormStore {
  readonly parseError = null;
  private currentErrors: Errors;

  constructor(
    readonly fields: Field[],
    private metadata: Record<string, unknown>,
  ) {
    this.currentErrors = validateForm(fields, metadata);
  }

  values(): Record<string, unknown> {
    return this.metadata;
  }

  errors(): Errors {
    return this.currentErrors;
  }

  get valid(): boolean {
    return this.currentErrors.size === 0;
  }

  replace(metadata: Record<string, unknown>): void {
    this.metadata = metadata;
    this.currentErrors = validateForm(this.fields, metadata);
  }

  private emit(): FormEmit {
    this.currentErrors = validateForm(this.fields, this.metadata);
    return { content: "", valid: this.valid };
  }

  edit(path: ValuePath, value: unknown): FormEmit {
    this.metadata = editValueAtPath(this.metadata, path, value);
    return this.emit();
  }

  private list(path: ValuePath): unknown[] {
    const current = valueAtPath(this.metadata, path);
    return Array.isArray(current) ? [...current] : current === undefined ? [] : [current];
  }

  listAppend(path: ValuePath, value: unknown): FormEmit {
    this.metadata = editValueAtPath(this.metadata, path, [...this.list(path), value]);
    return this.emit();
  }

  listRemove(path: ValuePath, index: number): FormEmit {
    const items = this.list(path);
    items.splice(index, 1);
    this.metadata = editValueAtPath(this.metadata, path, items);
    return this.emit();
  }

  listMove(path: ValuePath, from: number, to: number): FormEmit {
    const items = this.list(path);
    if (to < 0 || to >= items.length) return this.emit();
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    this.metadata = editValueAtPath(this.metadata, path, items);
    return this.emit();
  }
}

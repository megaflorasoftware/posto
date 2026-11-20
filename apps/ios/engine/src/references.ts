/**
 * Creating a referenced entry from a reference field: a draft form over a
 * throwaway frontmatter document, seeded like a new file, that becomes a
 * real entry (a file, or a data-document item) on save. The same flow as
 * FieldEditor's ReferenceEntryDraft.
 */
import { Document } from "yaml";
import type { FileEntry, FileGroup } from "@posto/ipc";
import {
  entryFilenamePattern,
  newEntryValues,
  type ContentEntry,
  type Field,
} from "@posto/core/pagescms/config";
import { serializeFile, type ValuePath } from "@posto/core/pagescms/frontmatter";
import { createDataDocumentEntry } from "../../../../packages/editor/src/dataEntries";
import { fieldAt, referenceTemplate } from "../../../../packages/editor/src/formModel";
import { buildNewFileFromValues } from "../../../../packages/editor/src/newFile";
import { dateControls } from "./dates";
import { fieldViews } from "./fieldViews";
import { FrontmatterForm } from "./forms";
import { invoke } from "./host";
import type { RepoSession } from "./repo";

interface Draft {
  collection: ContentEntry;
  /** The reference field the new entry fills. */
  path: ValuePath;
  form: FrontmatterForm;
}

let draft: Draft | null = null;

export function referenceDraftForm(): FrontmatterForm {
  if (!draft) throw new Error("No entry is being created");
  return draft.form;
}

export function startReferenceDraft(repo: RepoSession, path: ValuePath) {
  const field = referenceField(repo, path);
  const name = typeof field?.options?.collection === "string" ? field.options.collection : null;
  const collection = repo.config.content.find(
    (entry) => entry.type === "collection" && entry.name === name,
  );
  if (!collection) throw new Error("The reference's collection is unavailable.");
  const seeded = new Document(newEntryValues(entryFilenamePattern(collection), collection));
  const content = serializeFile({ doc: seeded, body: "", hadFrontmatter: true });
  draft = { collection, path, form: new FrontmatterForm(content, collection) };
  return referenceDraftView(repo);
}

/** The schema field a document path lands on (list indices skipped). */
function referenceField(repo: RepoSession, path: ValuePath): Field | null {
  return fieldAt(repo.requireDocument().entry?.fields ?? [], path);
}

export function referenceDraftView(repo: RepoSession) {
  if (!draft) throw new Error("No entry is being created");
  const { form, collection } = draft;
  return {
    collection: { name: collection.name, label: collection.label ?? collection.name },
    fields: fieldViews(
      form.fields,
      collection,
      repo.config,
      repo.adapter.capabilities.entryIds !== null,
    ),
    values: form.values(),
    errors: Object.fromEntries(form.errors()),
    dates: dateControls(form.fields, form.values()),
  };
}

/** Creates the entry and points the reference field (or a new list item)
 * at it. */
export async function finishReferenceDraft(repo: RepoSession): Promise<void> {
  if (!draft) throw new Error("No entry is being created");
  const { collection, path, form } = draft;
  if (form.errors().size > 0) throw new Error("Fix the highlighted fields first.");
  const document = repo.requireDocument();
  const target = referenceField(repo, path);
  const values = form.values();
  const entryIds = repo.adapter.capabilities.entryIds;
  let referenceValue: string;
  if (collection.dataFile) {
    const group: FileGroup = repo.files.groups.find(
      (candidate) => candidate.dataCollection === collection.name,
    ) ?? {
      label: collection.label ?? collection.name,
      path: `${repo.root}/${collection.dataFile.path}`,
      files: [],
      dataCollection: collection.name,
    };
    referenceValue = await createDataDocumentEntry(group, collection, values);
  } else {
    const dir = `${repo.root}/${collection.path}`;
    const existing = await invoke<FileEntry[]>("list_dir_files", { dir, extensions: [] }).catch(
      () => [],
    );
    const created = buildNewFileFromValues(
      repo.root,
      { label: collection.label ?? collection.name, path: dir, files: existing },
      { config: repo.config },
      values,
    );
    await invoke("create_text_file", created);
    const createdFile: FileEntry = {
      name: created.path.slice(created.path.lastIndexOf("/") + 1),
      path: created.path,
      title:
        typeof values.title === "string"
          ? values.title
          : typeof values.name === "string"
            ? values.name
            : null,
      frontmatter: Object.fromEntries(
        Object.entries(values).flatMap(([key, value]) =>
          typeof value === "string" || typeof value === "number" || typeof value === "boolean"
            ? [[key, String(value)]]
            : [],
        ),
      ),
    };
    const valueTemplate = typeof target?.options?.value === "string" ? target.options.value : null;
    const frameworkBase = target?.options?.idScheme === "framework" && entryIds ? `${dir}/` : null;
    referenceValue = frameworkBase
      ? entryIds!.derive(created.path.slice(frameworkBase.length), createdFile.frontmatter?.slug)
      : valueTemplate
        ? referenceTemplate(valueTemplate, repo.root, createdFile)
        : created.path.slice(repo.root.length + 1);
  }
  await repo.files.refresh(repo.root).catch(() => {});
  await repo.files.refreshData(repo.root, repo.config, repo.adapter.capabilities.dataDocuments);
  if (target?.list) document.listAppend(path, referenceValue);
  else document.edit(path, referenceValue);
  draft = null;
  void repo.git.refreshLocalChanges();
  repo.changed();
}

export function cancelReferenceDraft(): void {
  draft = null;
}

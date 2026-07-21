import { invoke, type FileEntry, type FileGroup } from "@posto/ipc";
import type { ContentEntry } from "@posto/core/pagescms/config";
import {
  appendDataEntry,
  parseDataDocument,
  removeDataEntry,
  serializeDataDocument,
} from "@posto/core/astro/dataDocument";

function nextId(group: FileGroup): string {
  const taken = new Set(group.files.map((file) => file.name));
  if (!taken.has("untitled")) return "untitled";
  for (let index = 2; ; index++) {
    if (!taken.has(`untitled-${index}`)) return `untitled-${index}`;
  }
}

export async function createDataDocumentEntry(
  group: FileGroup,
  collection: ContentEntry,
): Promise<string> {
  if (!collection.dataFile) throw new Error("Collection is not backed by a data document");
  const source = await invoke<string>("read_text_file", { path: group.path });
  const parsed = parseDataDocument(source, collection.dataFile.format);
  if (parsed.error) throw new Error(parsed.error);
  const id = nextId(group);
  const value: Record<string, unknown> = { id };
  for (const field of collection.fields) {
    if (field.name === "body" || field.name === "id") continue;
    if (field.default !== undefined) value[field.name] = field.default;
  }
  const primary =
    collection.fields.find((field) => field.name === "title") ??
    collection.fields.find((field) => field.name === "name");
  if (primary && value[primary.name] === undefined) value[primary.name] = "Untitled";
  if (!appendDataEntry(parsed, value)) throw new Error("Unsupported data document shape");
  await invoke("write_text_file", { path: group.path, content: serializeDataDocument(parsed) });
  return id;
}

export async function deleteDataDocumentEntry(file: FileEntry): Promise<void> {
  if (!file.dataEntry) throw new Error("File is not a data-document entry");
  const source = await invoke<string>("read_text_file", { path: file.path });
  const parsed = parseDataDocument(source, file.dataEntry.format);
  if (parsed.error) throw new Error(parsed.error);
  const locator = {
    id: file.dataEntry.id,
    path: file.dataEntry.path,
  };
  removeDataEntry(parsed, locator);
  await invoke("write_text_file", { path: file.path, content: serializeDataDocument(parsed) });
}

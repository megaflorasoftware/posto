import { useEffect, useState } from "react";
import { Alert, Button, Select, TagsInput, TextInput } from "@mantine/core";
import { Dialog } from "./Dialog";

import { invoke } from "@posto/ipc";
import type { FileEntry } from "@posto/ipc";
import { DEFAULT_FILENAME_PATTERN, type ContentEntry } from "@posto/core/pagescms/config";
import {
  POSTO_COLLECTIONS_DIR,
  parsePostoCollection,
  updatePostoCollectionSource,
  type PostoCollectionSettings,
} from "@posto/core/posto/config";

/** Sort tokens are written as `fields.<name>`; the select works with the
 * bare field name. */
function bareFieldName(token: string): string {
  return token.startsWith("fields.") ? token.slice("fields.".length) : token;
}

/**
 * Per-collection `.posto` settings: display name, entry-label template,
 * filename template, media directory, sort, and pinned files. Every field is
 * optional — cleared fields fall back to the derived config — and saving
 * rewrites only the keys this form owns, so hand-added settings survive.
 */
export function CollectionSettingsDialog(props: {
  root: string;
  collection: ContentEntry;
  /** The collection's current files; suggestions for pinning. */
  files: FileEntry[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { collection } = props;
  const path = `${props.root}/${POSTO_COLLECTIONS_DIR}/${collection.name}.json`;

  // The file's current text, kept for the round-trip: unknown keys in it
  // must survive a save from this form. Undefined while loading.
  const [source, setSource] = useState<string | null | undefined>(undefined);
  const [displayName, setDisplayName] = useState("");
  const [entryName, setEntryName] = useState("");
  const [filename, setFilename] = useState("");
  const [mediaDir, setMediaDir] = useState("");
  const [sortBy, setSortBy] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [pinned, setPinned] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      let raw: string | null = null;
      try {
        raw = await invoke<string>("read_text_file", { path });
      } catch {
        // No settings file yet — the form starts from defaults.
      }
      if (!active) return;
      const settings = raw !== null ? parsePostoCollection(raw) : null;
      setSource(raw);
      setDisplayName(settings?.displayName ?? "");
      setEntryName(settings?.entryName ?? "");
      setFilename(settings?.filename ?? "");
      setMediaDir(settings?.mediaDir ?? "");
      setSortBy(settings?.sort ? bareFieldName(settings.sort.by) : null);
      setSortDirection(settings?.sort?.direction ?? "desc");
      setPinned(settings?.pinned ?? []);
    })();
    return () => {
      active = false;
    };
    // The dialog mounts per collection; path only changes across mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const sortFields = collection.fields
    .filter((field) => field.type !== "object" && !field.list)
    .map((field) => ({
      value: field.name,
      label: typeof field.label === "string" ? field.label : field.name,
    }));

  async function save() {
    const trimmed = (value: string) => (value.trim() === "" ? undefined : value.trim());
    const settings: PostoCollectionSettings = {
      displayName: trimmed(displayName),
      entryName: trimmed(entryName),
      filename: trimmed(filename),
      mediaDir: trimmed(mediaDir),
      sort: sortBy ? { by: `fields.${sortBy}`, direction: sortDirection } : undefined,
      pinned: pinned.length > 0 ? pinned : undefined,
    };
    setSaving(true);
    setError(null);
    try {
      await invoke("write_text_file", {
        path,
        content: updatePostoCollectionSource(source ?? null, settings),
      });
      props.onSaved();
      props.onClose();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  return (
    <Dialog opened onClose={props.onClose} title={`${collection.label ?? collection.name} settings`}>
      {error !== null && (
        <Alert color="red" mb="sm">
          {error}
        </Alert>
      )}
      {source !== undefined && (
        <>
          <TextInput
            size="xs"
            label="Display name"
            description="Shown as the collection's heading"
            placeholder={collection.name}
            value={displayName}
            onChange={(e) => setDisplayName(e.currentTarget.value)}
          />
          <TextInput
            size="xs"
            mt="sm"
            label="Entry label"
            description="Template over frontmatter for each entry's label"
            placeholder="{fields.title}"
            value={entryName}
            onChange={(e) => setEntryName(e.currentTarget.value)}
          />
          <TextInput
            size="xs"
            mt="sm"
            label="New file name"
            description="Template for created files"
            placeholder={collection.filename ?? DEFAULT_FILENAME_PATTERN}
            value={filename}
            onChange={(e) => setFilename(e.currentTarget.value)}
          />
          <TextInput
            size="xs"
            mt="sm"
            label="Media folder"
            description="Where this collection's images are picked from"
            placeholder="public/images"
            value={mediaDir}
            onChange={(e) => setMediaDir(e.currentTarget.value)}
          />
          <Select
            size="xs"
            mt="sm"
            label="Sort entries by"
            clearable
            data={sortFields}
            value={sortBy}
            onChange={setSortBy}
          />
          {sortBy !== null && (
            <Select
              size="xs"
              mt="sm"
              label="Direction"
              allowDeselect={false}
              data={[
                { value: "desc", label: "Descending (newest first)" },
                { value: "asc", label: "Ascending (oldest first)" },
              ]}
              value={sortDirection}
              onChange={(value) => setSortDirection(value === "asc" ? "asc" : "desc")}
            />
          )}
          <TagsInput
            size="xs"
            mt="sm"
            label="Pinned files"
            description="Kept at the top, in this order"
            data={props.files.map((file) => file.name)}
            value={pinned}
            onChange={setPinned}
          />
          <Button fullWidth mt="md" disabled={saving} onClick={() => void save()}>
            Save
          </Button>
        </>
      )}
    </Dialog>
  );
}

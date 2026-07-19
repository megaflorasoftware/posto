import { useEffect, useState } from "react";
import { Alert, Button, TextInput } from "@mantine/core";
import { Dialog } from "./Dialog";
import { AdaptiveSelect, AdaptiveTagsInput } from "./AdaptiveSelect";

import { invoke } from "@posto/ipc";
import type { FileEntry } from "@posto/ipc";
import type { ContentEntry } from "@posto/core/pagescms/config";
import {
  LABEL_SORT,
  POSTO_COLLECTIONS_DIR,
  parsePostoCollection,
  updatePostoCollectionSource,
  type PostoCollectionSettings,
} from "@posto/core/posto/config";

/** The select works with full sort tokens: `fields.<name>` for frontmatter
 * fields (normalizing hand-written bare names), LABEL_SORT for the entry
 * label. */
function sortToken(token: string): string {
  return token === LABEL_SORT || token.startsWith("fields.") ? token : `fields.${token}`;
}

/**
 * Per-collection `.posto` settings: display name, sort, and pinned files.
 * Item templates are intentionally configured beside each item field. Every field is
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
      setSortBy(settings?.sort ? sortToken(settings.sort.by) : null);
      setSortDirection(settings?.sort?.direction ?? "desc");
      setPinned(settings?.pinned ?? []);
    })();
    return () => {
      active = false;
    };
    // The dialog mounts per collection; path only changes across mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const sortFields = [
    { value: LABEL_SORT, label: "Entry label" },
    ...collection.fields
      .filter((field) => field.type !== "object" && !field.list)
      .map((field) => ({
        value: `fields.${field.name}`,
        label: typeof field.label === "string" ? field.label : field.name,
      })),
  ];

  async function save() {
    const trimmed = (value: string) => (value.trim() === "" ? undefined : value.trim());
    const settings: PostoCollectionSettings = {
      displayName: trimmed(displayName),
      sort: sortBy ? { by: sortBy, direction: sortDirection } : undefined,
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
          <AdaptiveSelect
            size="xs"
            mt="sm"
            label="Sort entries by"
            clearable
            data={sortFields}
            value={sortBy}
            onChange={setSortBy}
          />
          {sortBy !== null && (
            <AdaptiveSelect
              size="xs"
              mt="sm"
              label="Direction"
              allowDeselect={false}
              data={[
                { value: "desc", label: "Descending" },
                { value: "asc", label: "Ascending" },
              ]}
              value={sortDirection}
              onChange={(value) => setSortDirection(value === "asc" ? "asc" : "desc")}
            />
          )}
          <AdaptiveTagsInput
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

import { useState } from "react";
import { Alert, Button, TextInput } from "@mantine/core";
import { Dialog } from "./Dialog";
import { Document } from "yaml";

import { invoke } from "@posto/ipc";
import type { FileGroup } from "@posto/ipc";
import {
  collectionExtension,
  DEFAULT_FILENAME_PATTERN,
  generateFilename,
  matchCollectionForDir,
  primaryField,
  slugify,
  type ContentEntry,
  type PagesConfig,
} from "@posto/core/pagescms/config";

/**
 * "New file" dialog for a sidebar directory. When the directory belongs to a
 * `.pages.yml` collection, it asks for the primary field (usually the title)
 * and derives the filename from the collection's filename pattern, Pages CMS
 * style; the generated name stays editable. Directories without a schema get
 * a plain filename prompt.
 */
export function NewFileModal(props: {
  root: string;
  group: FileGroup;
  config: PagesConfig;
  /** Entries sourced from Astro collection schemas (a subset of `config.content`). */
  astroContent: ContentEntry[];
  onClose: () => void;
  onCreated: (path: string) => void;
}) {
  const entry = matchCollectionForDir(props.config, props.root, props.group.path);
  const primary = entry ? primaryField(entry) : null;

  const [primaryValue, setPrimaryValue] = useState("");
  const [filename, setFilename] = useState("");
  // Once the filename is edited by hand it stops following the primary field.
  const [filenameTouched, setFilenameTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Astro collections have no date-prefix convention — their entries are just
  // slug-named — so the Pages CMS date default only applies to `.pages.yml`
  // collections without an explicit `filename`.
  const astroEntry = entry !== null && props.astroContent.includes(entry);
  const pattern =
    entry?.filename ??
    (astroEntry && entry
      ? `{primary}.${collectionExtension(entry) ?? "md"}`
      : DEFAULT_FILENAME_PATTERN);
  const generated =
    entry && primary ? generateFilename(pattern, entry, { [primary.name]: primaryValue }) : "";
  const effectiveFilename = (filenameTouched || !entry ? filename : generated).trim();

  const invalid =
    effectiveFilename === "" ||
    effectiveFilename.includes("/") ||
    effectiveFilename.startsWith(".");

  function initialContent(): string {
    if (!entry || !/\.(md|mdx|markdown)$/i.test(effectiveFilename)) return "";
    const values: Record<string, unknown> = {};
    for (const field of entry.fields) {
      if (field.name === "body") continue;
      if (field.default !== undefined) values[field.name] = field.default;
    }
    if (primary && primaryValue.trim() !== "") values[primary.name] = primaryValue.trim();
    // A `slug` field starts out as the slugified primary value — the same slug
    // the filename pattern derives — so the entry's slug survives creation.
    const slugField = entry.fields.find((f) => f.name === "slug");
    if (
      slugField &&
      values[slugField.name] === undefined &&
      primary &&
      primaryValue.trim() !== ""
    ) {
      values[slugField.name] = slugify(primaryValue);
    }
    if (Object.keys(values).length === 0) return "";
    return `---\n${new Document(values).toString({ lineWidth: 0 })}---\n`;
  }

  async function create() {
    const path = props.group.path + "/" + effectiveFilename;
    setCreating(true);
    setError(null);
    try {
      await invoke("create_text_file", { path, content: initialContent() });
      props.onCreated(path);
    } catch (e) {
      setError(String(e));
      setCreating(false);
    }
  }

  const primaryLabel =
    primary && typeof primary.label === "string" ? primary.label : (primary?.name ?? "");

  return (
    <Dialog opened onClose={props.onClose} title={`New file in ${props.group.label || "root"}`}>
      {error !== null && (
        <Alert color="red" mb="sm">
          {error}
        </Alert>
      )}
      {entry && primary && (
        <TextInput
          size="xs"
          label={primaryLabel}
          data-autofocus
          value={primaryValue}
          onChange={(e) => setPrimaryValue(e.currentTarget.value)}
        />
      )}
      <TextInput
        size="xs"
        mt={entry && primary ? "sm" : 0}
        label="Filename"
        placeholder={entry ? undefined : "my-page.md"}
        data-autofocus={!(entry && primary) || undefined}
        value={filenameTouched || !entry ? filename : generated}
        onChange={(e) => {
          setFilenameTouched(true);
          setFilename(e.currentTarget.value);
        }}
      />
      <Button fullWidth mt="md" disabled={invalid || creating} onClick={() => void create()}>
        Create
      </Button>
    </Dialog>
  );
}

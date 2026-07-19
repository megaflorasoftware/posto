import { useMemo } from "react";
import { Alert, Badge, Tabs } from "@mantine/core";
import type { FileEntry, FileGroup } from "@posto/ipc";
import { EMPTY_CONFIG, type ContentEntry, type PagesConfig } from "@posto/core/pagescms/config";
import { parseFile, type ParsedFile } from "@posto/core/pagescms/frontmatter";
import { FormEditor } from "./FormEditor";
import { DataFormEditor } from "./DataFormEditor";
import type { SaveState } from "../hooks/useCurrentFile";

export type EditorTab = "fields" | "body" | "raw";

// Whether the Fields tab would have anything to show: a matched schema entry,
// or existing frontmatter to infer fields from. A broken frontmatter block
// still counts — FormEditor's YAML-error alert explains it.
export function contentHasFields(entry: unknown, parsed: ParsedFile): boolean {
  if (entry !== null) return true;
  if (parsed.hadFrontmatter && parsed.error) return true;
  const values: unknown = parsed.doc.toJS();
  return !!values && typeof values === "object" && Object.keys(values).length > 0;
}

/** The editor pane's content: file header with save state, and the
 * Fields/Body/Raw tab host around FormEditor / the raw textarea. */
export function EditorPane(props: {
  root: string;
  filePath: string | null;
  fileContent: string;
  saveState: SaveState;
  entry: ContentEntry | null;
  dataEntry?: FileEntry["dataEntry"];
  /** Which schema source the entry came from, for the header badge. */
  entrySource: "astro" | "pages" | null;
  config: PagesConfig | null;
  configError: string | null;
  /** Whether Astro schemas exist to fall back on when `.pages.yml` is broken. */
  hasAstroFallback: boolean;
  groups: FileGroup[];
  editorTab: EditorTab;
  onTabChange: (tab: EditorTab) => void;
  onEdit: (content: string) => void;
  onFormEdit: (content: string, valid: boolean) => void;
}) {
  const { filePath, fileContent, entry, editorTab, dataEntry } = props;

  const fileName = dataEntry?.id ?? filePath?.split("/").pop() ?? "";

  // Markdown files always get a Form tab: schema-driven when a content entry
  // matches, otherwise with fields inferred from the frontmatter's shape.
  const showForm = entry !== null || /\.(md|mdx|markdown)$/i.test(filePath ?? "");

  // Whether the Fields tab has anything to show. README-style files (no
  // schema, no frontmatter) hide the tab and land on Body instead.
  const hasFields = useMemo(() => {
    if (entry !== null) return true;
    if (!showForm) return false;
    return contentHasFields(null, parseFile(fileContent));
  }, [entry, showForm, fileContent]);

  // The sticky tab choice, remapped while Fields is hidden; the state keeps
  // "fields" so schema-backed files still open on their form.
  const activeTab = dataEntry && editorTab === "body"
    ? "fields"
    : !hasFields && editorTab === "fields" ? "body" : editorTab;

  if (!filePath) {
    return <div className="pane-placeholder">Select a file to edit</div>;
  }

  const rawEditor = (
    <textarea
      className="editor"
      spellCheck={false}
      value={fileContent}
      onChange={(e) => props.onEdit(e.currentTarget.value)}
    />
  );

  return (
    <>
      <div className="pane-header">
        <span className="pane-title">{fileName}</span>
        <span
          className={`save-state${
            props.saveState === "error" || props.saveState === "invalid" ? " error" : ""
          }`}
        >
          {props.saveState === "saved"
            ? "Saved"
            : props.saveState === "saving"
              ? "Saving…"
              : props.saveState === "invalid"
                ? "Not saved — fix errors"
                : "Save failed"}
        </span>
        {entry && (
          <Badge
            size="sm"
            variant="light"
            color={props.entrySource === "astro" ? "grape" : "blue"}
            title={
              props.entrySource === "astro"
                ? "Schema from Astro content collections"
                : "Schema from .pages.yml"
            }
          >
            {props.entrySource === "astro" ? "Astro" : ".pages.yml"}
          </Badge>
        )}
      </div>
      {props.configError && (
        <Alert color="yellow" className="config-error">
          {props.hasAstroFallback
            ? `.pages.yml is invalid (falling back to Astro collection schemas) — ${props.configError}`
            : `Form editing disabled: .pages.yml is invalid — ${props.configError}`}
        </Alert>
      )}
      {(props.config?.imageLibraryDiagnostics?.length ?? 0) > 0 && (
        <Alert color="yellow" className="config-error">
          {props.config!.imageLibraryDiagnostics!.map((diagnostic) => diagnostic.message).join(" ")}
        </Alert>
      )}
      {!showForm ? (
        rawEditor
      ) : (
        <Tabs
          className="pane-tabs"
          value={activeTab}
          onChange={(value) => props.onTabChange(value as EditorTab)}
        >
          <Tabs.List>
            {hasFields && <Tabs.Tab value="fields">Fields</Tabs.Tab>}
            {!dataEntry && <Tabs.Tab value="body">Body</Tabs.Tab>}
            <Tabs.Tab value="raw">Raw</Tabs.Tab>
          </Tabs.List>
          {activeTab === "raw" ? (
            rawEditor
          ) : dataEntry && entry ? (
            <DataFormEditor
              key={`${filePath}:${dataEntry.collection}:${dataEntry.id}`}
              content={fileContent}
              entry={entry}
              dataEntry={dataEntry}
              config={props.config ?? EMPTY_CONFIG}
              root={props.root}
              groups={props.groups}
              onChange={props.onFormEdit}
            />
          ) : (
            // One FormEditor spans the Fields and Body tabs so the
            // parsed document survives switching between them.
            <FormEditor
              key={filePath}
              path={filePath}
              view={activeTab}
              content={fileContent}
              entry={entry}
              config={props.config ?? EMPTY_CONFIG}
              root={props.root}
              groups={props.groups}
              onChange={props.onFormEdit}
            />
          )}
        </Tabs>
      )}
    </>
  );
}

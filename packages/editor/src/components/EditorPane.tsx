import { useEffect, useMemo, useState } from "react";
import { ActionIcon, Alert, Tabs, TextInput } from "@mantine/core";
import { RefreshCw } from "lucide-react";
import type { FileEntry, FileGroup } from "@posto/ipc";
import { EMPTY_CONFIG, type ContentEntry, type PagesConfig } from "@posto/core/pagescms/config";
import { parseFile, type ParsedFile } from "@posto/core/pagescms/frontmatter";
import { FormEditor } from "./FormEditor";
import { DataFormEditor } from "./DataFormEditor";
import type { SaveState } from "../hooks/useCurrentFile";
import { FieldTemplateActions } from "./FieldTemplateActions";

export type EditorTab = "fields" | "body" | "raw";

export function editorTabsForFile(input: {
  filePath: string | null;
  fileContent: string;
  entry: ContentEntry | null;
  dataEntry?: FileEntry["dataEntry"];
}): EditorTab[] {
  if (!input.filePath) return [];
  const showForm = input.entry !== null || /\.(md|mdx|markdown)$/i.test(input.filePath);
  if (!showForm) return ["raw"];
  const hasFields = input.entry !== null || contentHasFields(null, parseFile(input.fileContent));
  return [
    ...(hasFields ? ["fields" as const] : []),
    ...(!input.dataEntry ? ["body" as const] : []),
    "raw",
  ];
}

export function resolveEditorTab(tabs: EditorTab[], requested: EditorTab): EditorTab {
  if (tabs.includes(requested)) return requested;
  if (tabs.includes("fields")) return "fields";
  return tabs[0] ?? "raw";
}

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
  onRenameFile: (filename: string) => Promise<boolean>;
  onRefreshFilename: (template: string) => void;
  onPostoSaved: () => void;
  hideTabList?: boolean;
  filenamePlacement?: "header" | "fields";
}) {
  const { filePath, fileContent, entry, editorTab, dataEntry } = props;

  const fileName = dataEntry?.id ?? filePath?.split("/").pop() ?? "";
  const filenameSchema = entry?.fieldSchemas?.filename ?? (entry?.filename
    ? { template: entry.filename, editBehavior: "controlled" as const }
    : undefined);
  const [filenameDraft, setFilenameDraft] = useState(fileName);
  useEffect(() => setFilenameDraft(fileName), [fileName]);

  async function commitFilename() {
    const next = filenameDraft.trim();
    if (next === fileName) return;
    if (next === "" || next.includes("/") || next === "." || next === "..") {
      setFilenameDraft(fileName);
      return;
    }
    if (!(await props.onRenameFile(next))) setFilenameDraft(fileName);
  }

  const tabs = useMemo(
    () => editorTabsForFile({ filePath, fileContent, entry, dataEntry }),
    [filePath, fileContent, entry, dataEntry],
  );
  const showForm = tabs.length > 1;
  const activeTab = resolveEditorTab(tabs, editorTab);

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

  const filenameReadOnly = !!dataEntry || !!(
    filenameSchema?.template && filenameSchema.editBehavior === "controlled"
  );
  const filenameInput = (
    <TextInput
      className="pane-filename-input"
      size="xs"
      aria-label="Filename"
      value={filenameDraft}
      readOnly={filenameReadOnly}
      rightSection={!filenameReadOnly && filenameSchema?.template && filenameSchema.editBehavior === "manual" ? (
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          title="Regenerate Filename from its template"
          aria-label="Regenerate Filename from its template"
          onClick={() => props.onRefreshFilename(filenameSchema.template!)}
        >
          <RefreshCw size={15} />
        </ActionIcon>
      ) : undefined}
      rightSectionPointerEvents="all"
      onChange={(event) => setFilenameDraft(event.currentTarget.value)}
      onBlur={() => void commitFilename()}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setFilenameDraft(fileName);
          event.currentTarget.blur();
        }
      }}
    />
  );
  const filenameActions = entry && !dataEntry ? (
    <FieldTemplateActions
      root={props.root}
      collection={entry}
      fieldName="filename"
      label="Filename"
      schema={filenameSchema}
      onPostoSaved={props.onPostoSaved}
      onGenerate={props.onRefreshFilename}
    />
  ) : null;
  const filenameField = (
    <div className="form-field pane-filename-field">
      <div className="field-label-row">
        <span className="field-label">Filename</span>
        {filenameActions}
      </div>
      {filenameInput}
    </div>
  );

  return (
    <>
      {(props.filenamePlacement ?? "header") === "header" && (
        <div className="pane-header">
          {filenameReadOnly ? (
            <div className="pane-filename-text">{fileName}</div>
          ) : (
            filenameInput
          )}
          {filenameActions}
        </div>
      )}
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
          {!props.hideTabList && (
            <Tabs.List>
              {tabs.map((tab) => (
                <Tabs.Tab key={tab} value={tab} tt="capitalize">{tab}</Tabs.Tab>
              ))}
            </Tabs.List>
          )}
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
              fieldsHeader={(props.filenamePlacement ?? "header") === "fields" ? filenameField : undefined}
              onChange={props.onFormEdit}
              onPostoSaved={props.onPostoSaved}
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
              fieldsHeader={(props.filenamePlacement ?? "header") === "fields" ? filenameField : undefined}
              onChange={props.onFormEdit}
              onPostoSaved={props.onPostoSaved}
            />
          )}
        </Tabs>
      )}
    </>
  );
}

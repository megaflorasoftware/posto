import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ActionIcon, Alert, TextInput } from "@mantine/core";
import { Code2, Maximize2, RefreshCw } from "lucide-react";
import type { FileEntry, FileGroup } from "@posto/ipc";
import { EMPTY_CONFIG, type ContentEntry, type PagesConfig } from "@posto/core/pagescms/config";
import { FormEditor } from "./FormEditor";
import { DataFormEditor } from "./DataFormEditor";
import type { SaveState } from "../hooks/useCurrentFile";
import { FieldTemplateActions } from "./FieldTemplateActions";
import type { ProjectType } from "@posto/core/project/detect";
import type { ComponentSchemaSource, ProjectIO } from "@posto/core/project/adapter";
import type { EntryIdSource } from "@posto/core/project/entryIds";
import { parseFile } from "@posto/core/pagescms/frontmatter";
import { ProjectIOProvider } from "../projectIO";

export type EditorTab = "content" | "raw";

export function editorTabsForFile(input: {
  filePath: string | null;
  fileContent: string;
  entry: ContentEntry | null;
  dataEntry?: FileEntry["dataEntry"];
  developerMode?: boolean;
}): EditorTab[] {
  if (!input.filePath) return [];
  const showForm = input.entry !== null || /\.(md|mdx|markdown)$/i.test(input.filePath);
  if (!showForm) return ["raw"];
  // Raw source is normally a developer-only escape hatch, but malformed
  // frontmatter cannot be repaired through the form editor. Open only the raw
  // view in that case so every user has a recovery path.
  if (/\.(md|mdx|markdown)$/i.test(input.filePath) && parseFile(input.fileContent).error) {
    return ["raw"];
  }
  return ["content", ...((input.developerMode ?? true) ? (["raw"] as const) : [])];
}

export function resolveEditorTab(tabs: EditorTab[], requested: EditorTab): EditorTab {
  if (tabs.includes(requested)) return requested;
  if (tabs.includes("content")) return "content";
  return tabs[0] ?? "raw";
}

/** The editor pane's content: file header with save state, and the
 * continuous fields/body editor or the developer-only raw textarea. */
export function EditorPane(props: {
  root: string;
  projectIO: ProjectIO;
  filePath: string | null;
  fileContent: string;
  saveState: SaveState;
  entry: ContentEntry | null;
  dataEntry?: FileEntry["dataEntry"];
  /** Which schema source the entry came from, for the header badge. */
  entrySource: ProjectType | "pages" | null;
  config: PagesConfig | null;
  configError: string | null;
  /** Whether Astro schemas exist to fall back on when `.pages.yml` is broken. */
  hasDerivedFallback: boolean;
  componentBlocks: ComponentSchemaSource | null;
  entryIds: EntryIdSource | null;
  componentSchemaVersion?: number;
  groups: FileGroup[];
  editorTab: EditorTab;
  onTabChange: (tab: EditorTab) => void;
  onEdit: (content: string) => void;
  onFormEdit: (content: string, valid: boolean) => void;
  onRenameFile: (filename: string) => Promise<boolean>;
  onRefreshFilename: (template: string) => void;
  onPostoSaved: () => void;
  onBeforeMediaChange?: () => Promise<void>;
  onMediaChanged?: (options?: { silent?: boolean }) => void;
  /** Reveals controls that write repository-level Posto configuration. */
  developerMode?: boolean;
  /** Opens the desktop editor in its distraction-free workspace. */
  onFullscreen?: () => void;
  /** Control rendered before the filename, used by the fullscreen header. */
  headerLeading?: ReactNode;
  hideHeader?: boolean;
  filenamePlacement?: "header" | "fields";
}) {
  const { filePath, fileContent, entry, editorTab, dataEntry } = props;
  const developerMode = props.developerMode ?? true;

  const fileName = dataEntry?.id ?? filePath?.split("/").pop() ?? "";
  const filenameSchema =
    entry?.fieldSchemas?.filename ??
    (entry?.filename
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
    () => editorTabsForFile({ filePath, fileContent, entry, dataEntry, developerMode }),
    [filePath, fileContent, entry, dataEntry, developerMode],
  );
  const activeTab = resolveEditorTab(tabs, editorTab);
  const showForm = activeTab !== "raw";

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

  const filenameReadOnly =
    !!dataEntry || !!(filenameSchema?.template && filenameSchema.editBehavior === "controlled");
  const filenameInput = (
    <TextInput
      className="pane-filename-input"
      size="xs"
      aria-label="Filename"
      value={filenameDraft}
      readOnly={filenameReadOnly}
      rightSection={
        !filenameReadOnly &&
        filenameSchema?.template &&
        filenameSchema.editBehavior === "manual" ? (
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
        ) : undefined
      }
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
  const filenameActions =
    developerMode && entry && !dataEntry ? (
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
    <ProjectIOProvider value={props.projectIO}>
      {!props.hideHeader && (props.filenamePlacement ?? "header") === "header" && (
        <div className="pane-header" data-tauri-drag-region>
          {props.headerLeading}
          <div className="pane-filename-header-control">
            {filenameReadOnly ? (
              <div className="pane-filename-text">{fileName}</div>
            ) : (
              filenameInput
            )}
            {filenameActions}
          </div>
          <div className="pane-header-actions">
            {developerMode && showForm && (
              <ActionIcon
                size={26}
                variant="default"
                title="Show raw file"
                aria-label="Show raw file"
                onClick={() => props.onTabChange("raw")}
              >
                <Code2 size={13} />
              </ActionIcon>
            )}
            {developerMode && !showForm && tabs.includes("content") && (
              <ActionIcon
                size={26}
                variant="default"
                title="Show visual editor"
                aria-label="Show visual editor"
                onClick={() => props.onTabChange("content")}
              >
                <Code2 size={13} />
              </ActionIcon>
            )}
            {props.onFullscreen && (
              <ActionIcon
                size={26}
                variant="default"
                title="Open fullscreen editor"
                aria-label="Open fullscreen editor"
                onClick={props.onFullscreen}
              >
                <Maximize2 size={13} />
              </ActionIcon>
            )}
          </div>
        </div>
      )}
      {props.configError && (
        <Alert color="yellow" className="config-error">
          {`Schema configuration issue${props.hasDerivedFallback ? " (using the last available schemas)" : ""} — ${props.configError}`}
        </Alert>
      )}
      <div className="pane-content">
        {!showForm ? (
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
            entryIds={props.entryIds}
            fieldsHeader={
              (props.filenamePlacement ?? "header") === "fields" ? filenameField : undefined
            }
            onChange={props.onFormEdit}
            onPostoSaved={developerMode ? props.onPostoSaved : undefined}
          />
        ) : (
          // One FormEditor owns fields and body so edits round-trip through
          // the same parsed document.
          <FormEditor
            key={filePath}
            path={filePath}
            content={fileContent}
            entry={entry}
            config={props.config ?? EMPTY_CONFIG}
            root={props.root}
            groups={props.groups}
            componentBlocks={props.componentBlocks}
            entryIds={props.entryIds}
            componentSchemaVersion={props.componentSchemaVersion}
            fieldsHeader={
              (props.filenamePlacement ?? "header") === "fields" ? filenameField : undefined
            }
            onChange={props.onFormEdit}
            onPostoSaved={developerMode ? props.onPostoSaved : undefined}
            onBeforeMediaChange={props.onBeforeMediaChange}
            onMediaChanged={props.onMediaChanged}
          />
        )}
      </div>
    </ProjectIOProvider>
  );
}

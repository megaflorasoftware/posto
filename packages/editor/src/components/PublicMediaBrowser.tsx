import type { ReactNode } from "react";
import { ActionIcon } from "@mantine/core";
import { File, FileAudio, FileText, FileVideo, Pencil, Trash2 } from "lucide-react";
import type { FileEntry } from "@posto/ipc";
import { markdownMediaKind } from "../markdownMedia";
import { CachedImage } from "./CachedImage";
import type { MarkdownMediaPick } from "../markdownMedia";
import {
  MediaDragPreview,
  type MediaDragPayload,
  type MediaSidebarDragSource,
} from "./MediaDragDrop";
import { PickerCardSelection } from "./PickerCardSelection";
import { PickerDirectoryCard } from "./PickerDirectoryCard";

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function relative(root: string, path: string): string | null {
  const base = normalize(root);
  const target = normalize(path);
  if (target === base) return "";
  return target.startsWith(`${base}/`) ? target.slice(base.length + 1) : null;
}

function dirname(path: string): string {
  const normalized = normalize(path);
  return normalized.slice(0, normalized.lastIndexOf("/"));
}

function parent(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function extension(path: string): string {
  const name = path.split("/").pop() ?? "";
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
}

export function FileMediaPlaceholder(props: { path: string; size?: number }) {
  const size = props.size ?? 34;
  const path = props.path;
  const kind = markdownMediaKind(path);
  if (kind === "audio") return <FileAudio size={size} />;
  if (kind === "video") return <FileVideo size={size} />;
  if (extension(path) === "pdf") return <FileText size={size} />;
  return <File size={size} />;
}

export function FileMediaPreview(props: {
  file: FileEntry;
  loading?: "eager" | "lazy";
  draggable?: boolean;
}) {
  return markdownMediaKind(props.file.path) === "image" ? (
    <CachedImage
      path={props.file.path}
      alt={props.file.name}
      loading={props.loading}
      draggable={props.draggable}
      fallback={<FileMediaPlaceholder path={props.file.path} />}
    />
  ) : (
    <FileMediaPlaceholder path={props.file.path} />
  );
}

function directoryPreviewImages(directory: string, files: FileEntry[]): string[] {
  const folder = normalize(directory);
  return files
    .filter(
      (file) =>
        markdownMediaKind(file.path) === "image" &&
        (dirname(file.path) === folder || dirname(file.path).startsWith(`${folder}/`)),
    )
    .map((file) => file.path)
    .slice(0, 4);
}

export function FileMediaBrowser(props: {
  rootDirectory: string;
  currentDirectory: string;
  directories: string[];
  files: FileEntry[];
  toolbar?: ReactNode;
  onDirectoryChange: (directory: string) => void;
  onPick?: (file: FileEntry) => void;
  onEdit?: (file: FileEntry) => void;
  onDelete?: (file: FileEntry) => void;
  /** Enables dragging a file into a Markdown/MDX body. */
  dragMedia?: (file: FileEntry) => MarkdownMediaPick | null;
  dragPayload?: (file: FileEntry) => MediaDragPayload | null;
  directoryDragPayload?: (directory: string) => MediaDragPayload | null;
  dropScope?: string;
  onDropToDirectory?: (source: MediaSidebarDragSource, directory: string) => void;
  selectionMode?: boolean;
  /** Shows a per-card selection action without switching the whole grid into selection mode. */
  inlineSelection?: boolean;
  selectedFilePaths?: Set<string>;
  selectedDirectoryPaths?: Set<string>;
  onToggleFileSelection?: (file: FileEntry) => void;
  onToggleDirectorySelection?: (directory: string) => void;
}) {
  const root = normalize(props.rootDirectory);
  const current = props.currentDirectory ? `${root}/${props.currentDirectory}` : root;
  const folders = props.directories
    .flatMap((directory) => {
      const location = relative(current, directory);
      return location && !location.includes("/") ? [{ name: location, path: directory }] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = props.files
    .filter((file) => normalize(dirname(file.path)) === normalize(current))
    .sort((a, b) => a.name.localeCompare(b.name));
  const empty = props.currentDirectory === "" && folders.length === 0 && files.length === 0;

  return (
    <>
      {props.toolbar ? (
        <div className="media-browser-toolbar">{props.toolbar}</div>
      ) : (
        <div className="image-library-browser-path">/{props.currentDirectory}</div>
      )}
      {empty ? (
        <div className="picker-empty">No media files or directories here.</div>
      ) : (
        <div className="picker-grid">
          {props.currentDirectory && (
            <PickerDirectoryCard
              id={`${root}:parent:${props.currentDirectory}`}
              name=".."
              path={[root, parent(props.currentDirectory)].filter(Boolean).join("/")}
              parent
              onOpen={() => props.onDirectoryChange(parent(props.currentDirectory))}
              dropScope={props.dropScope}
              onDrop={
                props.onDropToDirectory
                  ? (source) =>
                      props.onDropToDirectory?.(
                        source,
                        [root, parent(props.currentDirectory)].filter(Boolean).join("/"),
                      )
                  : undefined
              }
            />
          )}
          {folders.map((folder) => {
            const previews = directoryPreviewImages(folder.path, props.files);
            const openDirectory = () =>
              props.onDirectoryChange(
                props.currentDirectory ? `${props.currentDirectory}/${folder.name}` : folder.name,
              );
            return (
              <PickerDirectoryCard
                key={folder.path}
                id={folder.path}
                name={folder.name}
                path={folder.path}
                previewPaths={previews}
                selected={props.selectedDirectoryPaths?.has(folder.path)}
                inlineSelection={props.inlineSelection}
                selectionMode={props.selectionMode}
                onOpen={openDirectory}
                onToggleSelection={() => props.onToggleDirectorySelection?.(folder.path)}
                dragPayload={
                  !props.selectionMode ? props.directoryDragPayload?.(folder.path) : null
                }
                dropScope={props.dropScope}
                onDrop={
                  props.onDropToDirectory
                    ? (source) => props.onDropToDirectory?.(source, folder.path)
                    : undefined
                }
              />
            );
          })}
          {files.map((file) => {
            const dragMedia = props.selectionMode ? null : (props.dragMedia?.(file) ?? null);
            const dragPayload = props.selectionMode ? null : props.dragPayload?.(file);
            const content = (
              <>
                <MediaDragPreview
                  id={`file-media:${file.path}`}
                  media={dragPayload?.media ?? dragMedia}
                  source={dragPayload?.source}
                  className="picker-card-preview"
                >
                  <FileMediaPreview file={file} loading="lazy" draggable={false} />
                  {(props.selectionMode || props.inlineSelection) && (
                    <PickerCardSelection
                      selected={props.selectedFilePaths?.has(file.path) ?? false}
                      interactive={props.inlineSelection}
                      label={file.name}
                      onToggle={() => props.onToggleFileSelection?.(file)}
                    />
                  )}
                  {(props.onEdit || props.onDelete) && !props.selectionMode && (
                    <span className="picker-card-actions">
                      {props.onEdit && (
                        <ActionIcon
                          className="picker-card-edit-action"
                          variant="filled"
                          color="dark"
                          size="md"
                          title={`Edit ${file.name}`}
                          aria-label={`Edit ${file.name}`}
                          onPointerDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            props.onEdit?.(file);
                          }}
                        >
                          <Pencil size={18} />
                        </ActionIcon>
                      )}
                      {props.onDelete && (
                        <ActionIcon
                          className="picker-card-delete-action"
                          variant="filled"
                          color="red"
                          size="md"
                          title={`Delete ${file.name}`}
                          aria-label={`Delete ${file.name}`}
                          onPointerDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            props.onDelete?.(file);
                          }}
                        >
                          <Trash2 size={16} />
                        </ActionIcon>
                      )}
                    </span>
                  )}
                </MediaDragPreview>
                <span className="picker-item-name">{file.name}</span>
              </>
            );
            const action = props.selectionMode
              ? "Select"
              : props.onPick
                ? "Choose"
                : props.onEdit
                  ? "Edit"
                  : null;
            return props.selectionMode || (action && !(props.onEdit || props.onDelete)) ? (
              <button
                type="button"
                key={file.path}
                className="picker-card"
                aria-pressed={
                  props.selectionMode
                    ? (props.selectedFilePaths?.has(file.path) ?? false)
                    : undefined
                }
                onClick={() => {
                  if (props.selectionMode) props.onToggleFileSelection?.(file);
                  else if (props.onPick) props.onPick(file);
                  else props.onEdit?.(file);
                }}
                aria-label={`${action} ${file.name}`}
              >
                {content}
              </button>
            ) : props.onEdit || props.onDelete ? (
              <div
                key={file.path}
                className="picker-card"
                role="button"
                tabIndex={0}
                onClick={() => props.onEdit?.(file)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") props.onEdit?.(file);
                }}
                aria-label={`${props.onEdit ? "Edit" : "Delete"} ${file.name}`}
              >
                {content}
              </div>
            ) : (
              <div key={file.path} className="picker-card picker-card-static">
                {content}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/** Conventional-public alias retained for callers that are specifically
 * browsing `<repo>/public`; the grid itself works for any file media root. */
export const PublicMediaBrowser = FileMediaBrowser;

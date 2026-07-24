import type { ReactNode } from "react";
import { File, FileAudio, FileText, FileVideo, Folder, FolderUp, Pencil } from "lucide-react";
import type { FileEntry } from "@posto/ipc";
import { markdownMediaKind } from "../markdownMedia";
import { CachedImage } from "./CachedImage";

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

export function FileMediaPreview(props: { file: FileEntry; loading?: "eager" | "lazy" }) {
  return markdownMediaKind(props.file.path) === "image" ? (
    <CachedImage
      path={props.file.path}
      alt={props.file.name}
      loading={props.loading}
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
  selectionMode?: boolean;
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
            <button
              type="button"
              className="picker-card picker-directory"
              onClick={() => props.onDirectoryChange(parent(props.currentDirectory))}
            >
              <span className="picker-card-preview">
                <FolderUp size={36} />
              </span>
              <span className="picker-item-name">..</span>
              <span className="picker-item-path">Go up a directory</span>
            </button>
          )}
          {folders.map((folder) => {
            const previews = directoryPreviewImages(folder.path, props.files);
            return (
              <button
                type="button"
                className="picker-card picker-directory"
                key={folder.path}
                aria-pressed={
                  props.selectionMode
                    ? (props.selectedDirectoryPaths?.has(folder.path) ?? false)
                    : undefined
                }
                onClick={() => {
                  if (props.selectionMode) props.onToggleDirectorySelection?.(folder.path);
                  else
                    props.onDirectoryChange(
                      props.currentDirectory
                        ? `${props.currentDirectory}/${folder.name}`
                        : folder.name,
                    );
                }}
              >
                {previews.length > 0 ? (
                  <span
                    className="picker-card-preview picker-directory-preview-grid"
                    data-image-count={previews.length}
                  >
                    {previews.map((path, index) => (
                      <CachedImage key={`${path}:${index}`} path={path} alt="" loading="lazy" />
                    ))}
                    <span className="picker-directory-preview-badge">
                      <Folder size={16} />
                    </span>
                    {props.selectionMode && (
                      <span
                        className={`picker-card-selection${props.selectedDirectoryPaths?.has(folder.path) ? " is-selected" : ""}`}
                        aria-hidden="true"
                      />
                    )}
                  </span>
                ) : (
                  <span className="picker-card-preview">
                    <Folder size={36} />
                    {props.selectionMode && (
                      <span
                        className={`picker-card-selection${props.selectedDirectoryPaths?.has(folder.path) ? " is-selected" : ""}`}
                        aria-hidden="true"
                      />
                    )}
                  </span>
                )}
                <span className="picker-item-name">{folder.name}</span>
                <span className="picker-item-path">Directory</span>
              </button>
            );
          })}
          {files.map((file) => {
            const content = (
              <>
                <span className="picker-card-preview">
                  <FileMediaPreview file={file} loading="lazy" />
                  {props.selectionMode && (
                    <span
                      className={`picker-card-selection${props.selectedFilePaths?.has(file.path) ? " is-selected" : ""}`}
                      aria-hidden="true"
                    />
                  )}
                  {props.onEdit && !props.selectionMode && (
                    <span className="picker-card-edit" aria-hidden="true">
                      <Pencil size={22} />
                    </span>
                  )}
                </span>
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
            return action ? (
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

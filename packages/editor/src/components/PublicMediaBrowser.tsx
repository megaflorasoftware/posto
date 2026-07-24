import type { ReactNode } from "react";
import { File, FileAudio, FileText, FileVideo, Folder, FolderUp } from "lucide-react";
import { openPath, type FileEntry } from "@posto/ipc";
import { CachedImage } from "./CachedImage";

const IMAGE_EXTENSIONS = new Set([
  "avif",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "tif",
  "tiff",
  "webp",
]);
const AUDIO_EXTENSIONS = new Set(["aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav"]);
const VIDEO_EXTENSIONS = new Set(["avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ogv", "webm"]);

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

function fileFallback(path: string) {
  const ext = extension(path);
  if (AUDIO_EXTENSIONS.has(ext)) return <FileAudio size={34} />;
  if (VIDEO_EXTENSIONS.has(ext)) return <FileVideo size={34} />;
  if (ext === "pdf") return <FileText size={34} />;
  return <File size={34} />;
}

function directoryPreviewImages(directory: string, files: FileEntry[]): string[] {
  const folder = normalize(directory);
  return files
    .filter(
      (file) =>
        IMAGE_EXTENSIONS.has(extension(file.path)) &&
        (dirname(file.path) === folder || dirname(file.path).startsWith(`${folder}/`)),
    )
    .map((file) => file.path)
    .slice(0, 4);
}

export function PublicMediaBrowser(props: {
  rootDirectory: string;
  currentDirectory: string;
  directories: string[];
  files: FileEntry[];
  toolbar: ReactNode;
  onDirectoryChange: (directory: string) => void;
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
      <div className="media-browser-toolbar">{props.toolbar}</div>
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
                onClick={() =>
                  props.onDirectoryChange(
                    props.currentDirectory
                      ? `${props.currentDirectory}/${folder.name}`
                      : folder.name,
                  )
                }
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
                  </span>
                ) : (
                  <span className="picker-card-preview">
                    <Folder size={36} />
                  </span>
                )}
                <span className="picker-item-name">{folder.name}</span>
                <span className="picker-item-path">Directory</span>
              </button>
            );
          })}
          {files.map((file) => (
            <button
              type="button"
              key={file.path}
              className="picker-card"
              onClick={() => void openPath(file.path)}
              aria-label={`Open ${file.name}`}
            >
              <span className="picker-card-preview">
                {IMAGE_EXTENSIONS.has(extension(file.path)) ? (
                  <CachedImage
                    path={file.path}
                    alt={file.name}
                    loading="lazy"
                    fallback={fileFallback(file.path)}
                  />
                ) : (
                  fileFallback(file.path)
                )}
              </span>
              <span className="picker-item-name">{file.name}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

import { Folder, FolderUp, Pencil } from "lucide-react";
import type { ImageLibraryAsset } from "@posto/core/project/mediaLibrary";
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

function directoryPreviewImages(directory: string, assets: ImageLibraryAsset[]): string[] {
  const folder = normalize(directory);
  return assets
    .flatMap((asset) => {
      if (!asset.imagePath) return [];
      const assetDirectory = normalize(dirname(asset.metadataPath));
      if (assetDirectory !== folder && !assetDirectory.startsWith(`${folder}/`)) return [];
      return asset.imagePath;
    })
    .slice(0, 4);
}

export function ImageLibraryBrowser(props: {
  rootDirectory: string;
  currentDirectory: string;
  directories: string[];
  assets: ImageLibraryAsset[];
  onDirectoryChange: (directory: string) => void;
  onPick?: (asset: ImageLibraryAsset) => void;
  onEdit?: (asset: ImageLibraryAsset) => void;
  selectionMode?: boolean;
  selectedAssetIds?: Set<string>;
  selectedDirectoryPaths?: Set<string>;
  onToggleSelection?: (asset: ImageLibraryAsset) => void;
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
  const assets = props.assets.filter(
    (asset) => normalize(dirname(asset.metadataPath)) === normalize(current),
  );
  const empty = props.currentDirectory === "" && folders.length === 0 && assets.length === 0;

  return (
    <>
      <div className="image-library-browser-path">/{props.currentDirectory}</div>
      {empty ? (
        <div className="picker-empty">No image entries or directories here.</div>
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
            const previews = directoryPreviewImages(folder.path, props.assets);
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
          {assets.map((asset) => {
            const valid = asset.health.includes("valid");
            const alt = typeof asset.metadata.alt === "string" ? asset.metadata.alt : asset.entryId;
            const content = (
              <>
                <span className="picker-card-preview">
                  <CachedImage
                    path={asset.imagePath}
                    alt={alt}
                    loading="lazy"
                    fallback={<span className="picker-card-noimg">No preview</span>}
                  />
                  {props.selectionMode && (
                    <span
                      className={`picker-card-selection${props.selectedAssetIds?.has(asset.metadataPath) ? " is-selected" : ""}`}
                      aria-hidden="true"
                    />
                  )}
                  {props.onEdit && valid && !props.selectionMode && (
                    <span className="picker-card-edit" aria-hidden="true">
                      <Pencil size={22} />
                    </span>
                  )}
                </span>
                <span className="picker-item-name">{asset.entryId.split("/").pop()}</span>
                {!valid && <span className="picker-item-path">{asset.health.join(", ")}</span>}
              </>
            );
            return props.selectionMode ? (
              <button
                type="button"
                key={`${asset.entryId}:${asset.metadataPath}`}
                className="picker-card"
                disabled={!valid}
                aria-pressed={props.selectedAssetIds?.has(asset.metadataPath) ?? false}
                onClick={() => valid && props.onToggleSelection?.(asset)}
              >
                {content}
              </button>
            ) : props.onPick ? (
              <button
                type="button"
                key={`${asset.entryId}:${asset.metadataPath}`}
                className="picker-card"
                disabled={!valid}
                onClick={() => valid && props.onPick?.(asset)}
              >
                {content}
              </button>
            ) : props.onEdit && valid ? (
              <button
                type="button"
                key={`${asset.entryId}:${asset.metadataPath}`}
                className="picker-card"
                onClick={() => props.onEdit?.(asset)}
                aria-label={`Edit ${asset.entryId.split("/").pop()}`}
              >
                {content}
              </button>
            ) : (
              <div
                key={`${asset.entryId}:${asset.metadataPath}`}
                className="picker-card picker-card-static"
              >
                {content}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

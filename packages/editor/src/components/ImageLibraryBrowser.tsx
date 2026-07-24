import type { ReactNode } from "react";
import { ActionIcon } from "@mantine/core";
import { Folder, FolderUp, Pencil, Trash2 } from "lucide-react";
import type { ImageLibraryAsset } from "@posto/core/project/mediaLibrary";
import { CachedImage } from "./CachedImage";
import type { MarkdownMediaPick } from "../markdownMedia";
import { MediaDragPreview } from "./MediaDragDrop";
import { PickerCardSelection } from "./PickerCardSelection";

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
  toolbar?: ReactNode;
  onDirectoryChange: (directory: string) => void;
  onPick?: (asset: ImageLibraryAsset) => void;
  onEdit?: (asset: ImageLibraryAsset) => void;
  onDelete?: (asset: ImageLibraryAsset) => void;
  /** Enables dragging an asset into a Markdown/MDX body. */
  dragMedia?: (asset: ImageLibraryAsset) => MarkdownMediaPick | null;
  selectionMode?: boolean;
  /** Shows a per-card selection action without switching the whole grid into selection mode. */
  inlineSelection?: boolean;
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
      {props.toolbar ? (
        <div className="media-browser-toolbar">{props.toolbar}</div>
      ) : (
        <div className="image-library-browser-path">/{props.currentDirectory}</div>
      )}
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
            const selected = props.selectedDirectoryPaths?.has(folder.path) ?? false;
            const selection = (props.selectionMode || props.inlineSelection) && (
              <PickerCardSelection
                selected={selected}
                interactive={props.inlineSelection}
                label={folder.name}
                onToggle={() => props.onToggleDirectorySelection?.(folder.path)}
              />
            );
            const content = (
              <>
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
                    {selection}
                  </span>
                ) : (
                  <span className="picker-card-preview">
                    <Folder size={36} />
                    {selection}
                  </span>
                )}
                <span className="picker-item-name">{folder.name}</span>
                <span className="picker-item-path">Directory</span>
              </>
            );
            const openDirectory = () =>
              props.onDirectoryChange(
                props.currentDirectory ? `${props.currentDirectory}/${folder.name}` : folder.name,
              );
            return props.inlineSelection ? (
              <div
                className="picker-card picker-directory"
                key={folder.path}
                role="button"
                tabIndex={0}
                aria-label={`Open ${folder.name}`}
                onClick={openDirectory}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") openDirectory();
                }}
              >
                {content}
              </div>
            ) : (
              <button
                type="button"
                className="picker-card picker-directory"
                key={folder.path}
                aria-pressed={props.selectionMode ? selected : undefined}
                onClick={() => {
                  if (props.selectionMode) props.onToggleDirectorySelection?.(folder.path);
                  else openDirectory();
                }}
              >
                {content}
              </button>
            );
          })}
          {assets.map((asset) => {
            const valid = asset.health.includes("valid");
            const alt = typeof asset.metadata.alt === "string" ? asset.metadata.alt : asset.entryId;
            const dragMedia = valid ? props.dragMedia?.(asset) : null;
            const content = (
              <>
                <MediaDragPreview
                  id={`image-library:${asset.metadataPath}`}
                  media={!props.selectionMode ? dragMedia : null}
                  className="picker-card-preview"
                >
                  <CachedImage
                    path={asset.imagePath}
                    alt={alt}
                    loading="lazy"
                    draggable={false}
                    fallback={<span className="picker-card-noimg">No preview</span>}
                  />
                  {valid && (props.selectionMode || props.inlineSelection) && (
                    <PickerCardSelection
                      selected={props.selectedAssetIds?.has(asset.metadataPath) ?? false}
                      interactive={props.inlineSelection}
                      label={asset.entryId.split("/").pop() ?? asset.entryId}
                      onToggle={() => props.onToggleSelection?.(asset)}
                    />
                  )}
                  {(props.onEdit || props.onDelete) && valid && !props.selectionMode && (
                    <span className="picker-card-actions">
                      {props.onEdit && (
                        <ActionIcon
                          className="picker-card-edit-action"
                          variant="filled"
                          color="dark"
                          size="md"
                          title={`Edit ${asset.entryId.split("/").pop()}`}
                          aria-label={`Edit ${asset.entryId.split("/").pop()}`}
                          onPointerDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            props.onEdit?.(asset);
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
                          title={`Delete ${asset.entryId.split("/").pop()}`}
                          aria-label={`Delete ${asset.entryId.split("/").pop()}`}
                          onPointerDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            props.onDelete?.(asset);
                          }}
                        >
                          <Trash2 size={16} />
                        </ActionIcon>
                      )}
                    </span>
                  )}
                </MediaDragPreview>
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
            ) : (props.onEdit || props.onDelete) && valid ? (
              <div
                key={`${asset.entryId}:${asset.metadataPath}`}
                className="picker-card"
                role="button"
                tabIndex={0}
                onClick={() => props.onEdit?.(asset)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") props.onEdit?.(asset);
                }}
                aria-label={`Edit ${asset.entryId.split("/").pop()}`}
              >
                {content}
              </div>
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

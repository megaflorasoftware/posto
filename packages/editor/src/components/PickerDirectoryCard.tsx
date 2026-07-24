import { Folder, FolderUp } from "lucide-react";
import { CachedImage } from "./CachedImage";
import { useMediaSidebarDropZone, type MediaSidebarDragSource } from "./MediaDragDrop";
import { PickerCardSelection } from "./PickerCardSelection";

export function PickerDirectoryCard(props: {
  id: string;
  name: string;
  path: string;
  previewPaths?: string[];
  parent?: boolean;
  selected?: boolean;
  inlineSelection?: boolean;
  selectionMode?: boolean;
  onOpen: () => void;
  onToggleSelection?: () => void;
  dropScope?: string;
  onDrop?: (source: MediaSidebarDragSource) => void;
}) {
  const drop = useMediaSidebarDropZone({
    id: `media-directory:${props.id}`,
    accepts: (source) => !!props.onDrop && source.scope === props.dropScope,
    onDrop: (source) => props.onDrop?.(source),
  });
  const selected = props.selected ?? false;
  const selection = !props.parent && (props.selectionMode || props.inlineSelection) && (
    <PickerCardSelection
      selected={selected}
      interactive={props.inlineSelection}
      label={props.name}
      onToggle={props.onToggleSelection}
    />
  );
  const previews = props.previewPaths ?? [];
  const content = (
    <>
      {props.parent ? (
        <span className="picker-card-preview">
          <FolderUp size={36} />
        </span>
      ) : previews.length > 0 ? (
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
      <span className="picker-item-name">{props.parent ? ".." : props.name}</span>
      <span className="picker-item-path">{props.parent ? "Go up a directory" : "Directory"}</span>
    </>
  );
  const className = `picker-card picker-directory${
    drop.activeSource ? " is-media-drop-target" : ""
  }${drop.isAccepting ? " is-drag-over" : ""}`;

  if (props.inlineSelection && !props.parent) {
    return (
      <div
        ref={drop.setNodeRef}
        className={className}
        role="button"
        tabIndex={0}
        aria-label={`Open ${props.name}`}
        data-media-directory-path={props.path}
        onClick={props.onOpen}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") props.onOpen();
        }}
      >
        {content}
      </div>
    );
  }

  return (
    <button
      ref={drop.setNodeRef}
      type="button"
      className={className}
      aria-pressed={props.selectionMode && !props.parent ? selected : undefined}
      data-media-directory-path={props.path}
      onClick={() => {
        if (props.selectionMode && !props.parent) props.onToggleSelection?.();
        else props.onOpen();
      }}
    >
      {content}
    </button>
  );
}

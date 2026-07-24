import { Folder, FolderUp } from "lucide-react";
import { CachedImage } from "./CachedImage";
import {
  MediaDragPreview,
  useMediaSidebarDropZone,
  type MediaDragPayload,
  type MediaSidebarDragSource,
} from "./MediaDragDrop";
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
  dragPayload?: MediaDragPayload | null;
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
  const preview = props.parent ? (
    <span className="picker-card-preview">
      <FolderUp size={36} />
    </span>
  ) : (
    <MediaDragPreview
      id={`media-directory-source:${props.id}`}
      media={props.dragPayload?.media}
      source={props.dragPayload?.source}
      className={`picker-card-preview${previews.length > 0 ? " picker-directory-preview-grid" : ""}`}
      dataImageCount={previews.length || undefined}
    >
      {previews.length > 0 ? (
        <>
          {previews.map((path, index) => (
            <CachedImage key={`${path}:${index}`} path={path} alt="" loading="lazy" />
          ))}
          <span className="picker-directory-preview-badge">
            <Folder size={16} />
          </span>
        </>
      ) : (
        <Folder size={36} />
      )}
      {selection}
    </MediaDragPreview>
  );
  const content = (
    <>
      {preview}
      <span className="picker-item-name">{props.parent ? ".." : props.name}</span>
      <span className="picker-item-path">{props.parent ? "Go up a directory" : "Directory"}</span>
    </>
  );
  const className = `picker-card picker-directory${
    drop.isEnabled ? " is-media-drop-target" : ""
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
        onClick={(event) => {
          if (event.shiftKey && props.onToggleSelection) props.onToggleSelection();
          else props.onOpen();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          if (event.shiftKey && props.onToggleSelection) props.onToggleSelection();
          else props.onOpen();
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
      onClick={(event) => {
        if (
          !props.parent &&
          props.onToggleSelection &&
          (props.selectionMode || (props.inlineSelection && event.shiftKey))
        ) {
          props.onToggleSelection();
        } else props.onOpen();
      }}
    >
      {content}
    </button>
  );
}

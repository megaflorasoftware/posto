import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type CollisionDetection,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { Blocks, Folder, Image } from "lucide-react";
import type { MarkdownMediaKind, MarkdownMediaPick } from "../markdownMedia";

export interface BodyImageDragSource {
  kind: "body-image";
  editorId: string;
  getPosition: () => number | undefined;
}

export interface MediaSidebarDragSource {
  kind: "media-sidebar";
  scope: string;
  items: MediaDragItem[];
}

export type MediaDragSource = BodyImageDragSource | MediaSidebarDragSource;

export interface MediaDragItem {
  id: string;
  kind: MarkdownMediaKind | "directory";
}

export interface MediaDragSelection {
  media: MarkdownMediaPick[];
  items: MediaDragItem[];
  source: MediaDragSource | null;
}

export type MediaDropCategory = "sidebar-items" | "single-image" | "image-list";

export interface MediaDragPayload {
  media: MarkdownMediaPick[];
  source?: MediaDragSource;
}

export interface BodyNodeDragSource {
  kind: "body-node";
  editorId: string;
  nodeType: string;
  getPosition: () => number | undefined;
}

export interface BodyNodeDragDetails {
  pointer: { x: number; y: number } | null;
  sourcePosition: number | undefined;
}

interface BodyNodeDragData {
  kind: "posto-body-node";
  label: string;
  source: BodyNodeDragSource;
}

interface MediaDragData {
  kind: "posto-media";
  media: MarkdownMediaPick[];
  source?: MediaDragSource;
}

export interface MediaDropDetails {
  pointer: { x: number; y: number } | null;
  source: MediaDragSource | null;
  sourcePosition: number | undefined;
}

interface MediaDropData {
  kind: "posto-media-drop";
  category: MediaDropCategory;
  accepts: (selection: MediaDragSelection) => boolean;
  onDrop: (media: MarkdownMediaPick[], event: DragEndEvent, details: MediaDropDetails) => void;
}

interface MediaSidebarDropData {
  kind: "posto-media-sidebar-drop";
  category: "sidebar-items";
  accepts: (source: MediaSidebarDragSource) => boolean;
  onDrop: (source: MediaSidebarDragSource, event: DragEndEvent) => void;
}

interface RichTextDropData {
  kind: "posto-rich-text-drop";
  mediaCategory: MediaDropCategory;
  acceptsMedia: (selection: MediaDragSelection) => boolean;
  onMediaDrop: (media: MarkdownMediaPick[], event: DragEndEvent, details: MediaDropDetails) => void;
  onBodyNodeDrop: (
    source: BodyNodeDragSource,
    event: DragEndEvent,
    details: BodyNodeDragDetails,
  ) => void;
}

export interface PostoListDragData {
  kind: "posto-list-item";
  groupId: string;
  index: number;
  onMove: (from: number, to: number) => void;
}

export const mediaDragCollisionDetection: CollisionDetection = (args) => {
  const activeData = args.active.data.current;
  if (activeData?.kind === "posto-list-item") {
    const groupId = (activeData as unknown as PostoListDragData).groupId;
    const listItems = args.droppableContainers.filter((container) => {
      const data = container.data.current as unknown as PostoListDragData | undefined;
      return data?.kind === "posto-list-item" && data.groupId === groupId;
    });
    return closestCenter({ ...args, droppableContainers: listItems });
  }
  if (activeData?.kind === "posto-media") {
    const selection = draggedSelection(activeData);
    const mediaTargets = args.droppableContainers.filter((container) => {
      const data = container.data.current as unknown as
        | MediaDropData
        | MediaSidebarDropData
        | RichTextDropData
        | undefined;
      if (data?.kind === "posto-media-drop") return data.accepts(selection);
      if (data?.kind === "posto-rich-text-drop") return data.acceptsMedia(selection);
      return (
        data?.kind === "posto-media-sidebar-drop" &&
        acceptsMediaDrop(selection, data.category) &&
        selection.source?.kind === "media-sidebar" &&
        data.accepts(selection.source)
      );
    });
    if (mediaTargets.length === 0) return [];
    const scopedArgs = { ...args, droppableContainers: mediaTargets };
    // Media targets are intentionally pointer-only. Falling back to the dragged
    // card's closest target makes large previews and directories activate while
    // the cursor is still outside their bounds.
    return pointerWithin(scopedArgs);
  }
  if (activeData?.kind === "posto-body-node") {
    const bodyTargets = args.droppableContainers.filter(
      (container) => container.data.current?.kind === "posto-rich-text-drop",
    );
    const scopedArgs = { ...args, droppableContainers: bodyTargets };
    const pointerCollisions = pointerWithin(scopedArgs);
    return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(scopedArgs);
  }
  return closestCenter(args);
};

function draggedMedia(data: Record<string, unknown> | undefined): MarkdownMediaPick[] {
  return data?.kind === "posto-media" ? ((data as unknown as MediaDragData).media ?? []) : [];
}

function draggedSource(data: Record<string, unknown> | undefined): MediaDragSource | null {
  return data?.kind === "posto-media" ? ((data as unknown as MediaDragData).source ?? null) : null;
}

function draggedSelection(data: Record<string, unknown> | undefined): MediaDragSelection {
  const media = draggedMedia(data);
  const source = draggedSource(data);
  return {
    media,
    source,
    items:
      source?.kind === "media-sidebar"
        ? source.items
        : media.map((item) => ({ id: item.outputPath, kind: item.kind })),
  };
}

/** Applies the item-count and item-kind rules shared by editor media drop targets. */
export function acceptsMediaDrop(
  selection: MediaDragSelection,
  category: MediaDropCategory,
): boolean {
  if (category === "sidebar-items") {
    return selection.source?.kind === "media-sidebar" && selection.items.length > 0;
  }
  const allImages =
    selection.items.length > 0 &&
    selection.items.every((item) => item.kind === "image") &&
    selection.media.length === selection.items.length &&
    selection.media.every((item) => item.kind === "image");
  if (!allImages) return false;
  return category === "image-list" || selection.items.length === 1;
}

function draggedBodyNode(data: Record<string, unknown> | undefined): BodyNodeDragData | null {
  return data?.kind === "posto-body-node" ? (data as unknown as BodyNodeDragData) : null;
}

interface MediaDragState {
  activeMedia: MarkdownMediaPick | null;
  activeItems: MediaDragItem[];
  activeSource: MediaDragSource | null;
  activeBodyNode: BodyNodeDragData | null;
  pointer: { x: number; y: number } | null;
}

const MediaDragContext = createContext<MediaDragState>({
  activeMedia: null,
  activeItems: [],
  activeSource: null,
  activeBodyNode: null,
  pointer: null,
});

function pointerFromEvent(event: Event): { x: number; y: number } | null {
  if ("clientX" in event && "clientY" in event) {
    return {
      x: Number((event as MouseEvent).clientX),
      y: Number((event as MouseEvent).clientY),
    };
  }
  return null;
}

/** App-level dnd-kit context for sidebar media and editor/field drop zones. */
export function MediaDragDropProvider(props: { children: ReactNode }) {
  const [activeMedia, setActiveMedia] = useState<MarkdownMediaPick | null>(null);
  const [activeItems, setActiveItems] = useState<MediaDragItem[]>([]);
  const [activeSource, setActiveSource] = useState<MediaDragSource | null>(null);
  const [activeBodyNode, setActiveBodyNode] = useState<BodyNodeDragData | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const startPointer = useRef<{ x: number; y: number } | null>(null);
  const livePointer = useRef<{ x: number; y: number } | null>(null);
  const dragSource = useRef<MediaDragSource | null>(null);
  const dragSourcePosition = useRef<number | undefined>(undefined);
  const bodyNodeSourcePosition = useRef<number | undefined>(undefined);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const pointerForEvent = (event: Pick<DragMoveEvent, "delta">) => {
    if (livePointer.current) return livePointer.current;
    const start = startPointer.current;
    return start ? { x: start.x + event.delta.x, y: start.y + event.delta.y } : null;
  };
  const clearDrag = () => {
    startPointer.current = null;
    livePointer.current = null;
    dragSource.current = null;
    dragSourcePosition.current = undefined;
    bodyNodeSourcePosition.current = undefined;
    setPointer(null);
    setActiveMedia(null);
    setActiveItems([]);
    setActiveSource(null);
    setActiveBodyNode(null);
  };

  // dnd-kit owns the drag lifecycle; keep the actual pointer separately so
  // insertion never depends on the translated dimensions of the drag overlay.
  useEffect(() => {
    if (activeItems.length === 0 && !activeBodyNode) return;
    const updatePointer = (event: PointerEvent) => {
      const next = { x: event.clientX, y: event.clientY };
      livePointer.current = next;
      setPointer(next);
    };
    window.addEventListener("pointermove", updatePointer);
    return () => window.removeEventListener("pointermove", updatePointer);
  }, [activeBodyNode, activeItems.length]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={mediaDragCollisionDetection}
      onDragStart={(event: DragStartEvent) => {
        const start = pointerFromEvent(event.activatorEvent);
        const source = draggedSource(event.active.data.current);
        const bodyNode = draggedBodyNode(event.active.data.current);
        startPointer.current = start;
        livePointer.current = start;
        dragSource.current = source;
        dragSourcePosition.current =
          source?.kind === "body-image" ? source.getPosition() : undefined;
        bodyNodeSourcePosition.current = bodyNode?.source.getPosition();
        setPointer(start);
        const selection = draggedSelection(event.active.data.current);
        setActiveMedia(selection.media[0] ?? null);
        setActiveItems(selection.items);
        setActiveSource(source);
        setActiveBodyNode(bodyNode);
      }}
      onDragMove={(event) => setPointer(pointerForEvent(event))}
      onDragCancel={clearDrag}
      onDragEnd={(event) => {
        const selection = draggedSelection(event.active.data.current);
        const { media, source } = selection;
        const drop = event.over?.data.current as unknown as
          | MediaDropData
          | MediaSidebarDropData
          | RichTextDropData
          | undefined;
        if (
          source?.kind === "media-sidebar" &&
          drop?.kind === "posto-media-sidebar-drop" &&
          drop.accepts(source)
        ) {
          drop.onDrop(source, event);
        } else if (drop?.kind === "posto-media-drop" && drop.accepts(selection)) {
          drop.onDrop(media, event, {
            pointer: pointerForEvent(event),
            source: dragSource.current,
            sourcePosition: dragSourcePosition.current,
          });
        } else if (drop?.kind === "posto-rich-text-drop" && drop.acceptsMedia(selection)) {
          drop.onMediaDrop(media, event, {
            pointer: pointerForEvent(event),
            source: dragSource.current,
            sourcePosition: dragSourcePosition.current,
          });
        }
        const bodyNode = draggedBodyNode(event.active.data.current);
        if (bodyNode && drop?.kind === "posto-rich-text-drop") {
          drop.onBodyNodeDrop(bodyNode.source, event, {
            pointer: pointerForEvent(event),
            sourcePosition: bodyNodeSourcePosition.current,
          });
        }
        const listItem = event.active.data.current as unknown as PostoListDragData | undefined;
        const overItem = event.over?.data.current as unknown as PostoListDragData | undefined;
        if (
          listItem?.kind === "posto-list-item" &&
          overItem?.kind === "posto-list-item" &&
          listItem.groupId === overItem.groupId &&
          listItem.index !== overItem.index
        ) {
          listItem.onMove(listItem.index, overItem.index);
        }
        clearDrag();
      }}
    >
      <MediaDragContext.Provider
        value={{ activeMedia, activeItems, activeSource, activeBodyNode, pointer }}
      >
        {props.children}
        <DragOverlay dropAnimation={null}>
          {activeItems.length > 0 ? (
            <div className="media-drag-overlay">
              {activeItems.every((item) => item.kind === "directory") ? (
                <Folder size={18} />
              ) : activeItems.every((item) => item.kind === "image") ? (
                <Image size={18} />
              ) : (
                <Blocks size={18} />
              )}
              <span>
                {activeItems.length > 1
                  ? `${activeItems.length} items`
                  : activeItems[0]?.kind === "directory"
                    ? "1 folder"
                    : (activeMedia?.label ?? "1 item")}
              </span>
            </div>
          ) : activeBodyNode ? (
            <div className="media-drag-overlay">
              <Blocks size={18} />
              <span>{activeBodyNode.label}</span>
            </div>
          ) : null}
        </DragOverlay>
      </MediaDragContext.Provider>
    </DndContext>
  );
}

export function useBodyNodeDraggable(input: {
  id: string;
  label: string;
  source: BodyNodeDragSource | null;
}) {
  return useDraggable({
    id: input.id,
    disabled: !input.source,
    data: input.source
      ? ({
          kind: "posto-body-node",
          label: input.label,
          source: input.source,
        } satisfies BodyNodeDragData)
      : {},
  });
}

export function useMediaDraggable(input: {
  id: string;
  media: MarkdownMediaPick | MarkdownMediaPick[] | null | undefined;
  source?: MediaDragSource;
}) {
  const media = Array.isArray(input.media) ? input.media : input.media ? [input.media] : [];
  const enabled =
    media.length > 0 || (input.source?.kind === "media-sidebar" && input.source.items.length > 0);
  return useDraggable({
    id: input.id,
    disabled: !enabled,
    data: enabled
      ? ({ kind: "posto-media", media, source: input.source } satisfies MediaDragData)
      : {},
  });
}

/** Dedicated dnd-kit drag handle around a media-card preview. */
export function MediaDragPreview(props: {
  id: string;
  media: MarkdownMediaPick | MarkdownMediaPick[] | null | undefined;
  source?: MediaDragSource;
  className: string;
  dataImageCount?: number;
  children: ReactNode;
}) {
  const draggable = useMediaDraggable({ id: props.id, media: props.media, source: props.source });
  const enabled =
    (Array.isArray(props.media) ? props.media.length > 0 : !!props.media) ||
    (props.source?.kind === "media-sidebar" && props.source.items.length > 0);
  return (
    <span
      ref={draggable.setNodeRef}
      className={`${props.className}${enabled ? " is-media-draggable" : ""}${draggable.isDragging ? " is-dragging" : ""}`}
      data-image-count={props.dataImageCount}
      {...draggable.attributes}
      {...draggable.listeners}
    >
      {props.children}
    </span>
  );
}

export function useMediaDropZone(input: {
  id: string;
  category: MediaDropCategory;
  accepts?: (media: MarkdownMediaPick[]) => boolean;
  onDrop: (media: MarkdownMediaPick[], event: DragEndEvent, details: MediaDropDetails) => void;
}) {
  const drag = useContext(MediaDragContext);
  const accepts = (selection: MediaDragSelection) =>
    acceptsMediaDrop(selection, input.category) && (input.accepts?.(selection.media) ?? true);
  const droppable = useDroppable({
    id: input.id,
    data: {
      kind: "posto-media-drop",
      category: input.category,
      accepts,
      onDrop: input.onDrop,
    } satisfies MediaDropData,
  });
  const selection = draggedSelection(droppable.active?.data.current);
  return {
    setNodeRef: droppable.setNodeRef,
    isOver: droppable.isOver,
    isEnabled: accepts(selection),
    isAccepting: droppable.isOver && accepts(selection),
    pointer: drag.pointer,
    activeMedia: drag.activeMedia,
    activeSource: drag.activeSource,
  };
}

export function useMediaSidebarDropZone(input: {
  id: string;
  accepts: (source: MediaSidebarDragSource) => boolean;
  onDrop: (source: MediaSidebarDragSource, event: DragEndEvent) => void;
}) {
  const drag = useContext(MediaDragContext);
  const droppable = useDroppable({
    id: input.id,
    data: {
      kind: "posto-media-sidebar-drop",
      category: "sidebar-items",
      accepts: input.accepts,
      onDrop: input.onDrop,
    } satisfies MediaSidebarDropData,
  });
  const source = draggedSource(droppable.active?.data.current);
  const selection = draggedSelection(droppable.active?.data.current);
  const isEnabled =
    acceptsMediaDrop(selection, "sidebar-items") &&
    source?.kind === "media-sidebar" &&
    input.accepts(source);
  return {
    setNodeRef: droppable.setNodeRef,
    isOver: droppable.isOver,
    isEnabled,
    isAccepting: droppable.isOver && isEnabled,
    activeSource: drag.activeSource?.kind === "media-sidebar" ? drag.activeSource : null,
  };
}

export function useRichTextDropZone(input: {
  id: string;
  mediaCategory: MediaDropCategory;
  acceptsMedia?: (media: MarkdownMediaPick[]) => boolean;
  onMediaDrop: (media: MarkdownMediaPick[], event: DragEndEvent, details: MediaDropDetails) => void;
  onBodyNodeDrop: (
    source: BodyNodeDragSource,
    event: DragEndEvent,
    details: BodyNodeDragDetails,
  ) => void;
}) {
  const drag = useContext(MediaDragContext);
  const acceptsMedia = (selection: MediaDragSelection) =>
    acceptsMediaDrop(selection, input.mediaCategory) &&
    (input.acceptsMedia?.(selection.media) ?? true);
  const droppable = useDroppable({
    id: input.id,
    data: {
      kind: "posto-rich-text-drop",
      mediaCategory: input.mediaCategory,
      acceptsMedia,
      onMediaDrop: input.onMediaDrop,
      onBodyNodeDrop: input.onBodyNodeDrop,
    } satisfies RichTextDropData,
  });
  const selection = draggedSelection(droppable.active?.data.current);
  const bodyNode = draggedBodyNode(droppable.active?.data.current);
  return {
    setNodeRef: droppable.setNodeRef,
    isOver: droppable.isOver,
    isAccepting: droppable.isOver && (acceptsMedia(selection) || !!bodyNode),
    pointer: drag.pointer,
    activeMedia: drag.activeMedia,
    activeMediaSource: drag.activeSource,
    activeBodySource: drag.activeBodyNode?.source ?? null,
  };
}

const bodyNodePositionGetters = new WeakMap<HTMLElement, () => number | undefined>();

export function registerBodyNodePosition(
  element: HTMLElement,
  getPosition: () => number | undefined,
) {
  bodyNodePositionGetters.set(element, getPosition);
}

export function bodyNodePosition(element: HTMLElement): number | undefined {
  return bodyNodePositionGetters.get(element)?.();
}

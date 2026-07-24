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
import { Image } from "lucide-react";
import type { MarkdownMediaPick } from "../markdownMedia";

export interface MediaDragSource {
  kind: "body-image";
  editorId: string;
  getPosition: () => number | undefined;
}

interface MediaDragData {
  kind: "posto-media";
  media: MarkdownMediaPick;
  source?: MediaDragSource;
}

export interface MediaDropDetails {
  pointer: { x: number; y: number } | null;
  source: MediaDragSource | null;
  sourcePosition: number | undefined;
}

interface MediaDropData {
  kind: "posto-media-drop";
  accepts: (media: MarkdownMediaPick) => boolean;
  onDrop: (media: MarkdownMediaPick, event: DragEndEvent, details: MediaDropDetails) => void;
}

export interface PostoListDragData {
  kind: "posto-list-item";
  groupId: string;
  index: number;
  onMove: (from: number, to: number) => void;
}

const collisionDetection: CollisionDetection = (args) => {
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
    const mediaTargets = args.droppableContainers.filter(
      (container) => container.data.current?.kind === "posto-media-drop",
    );
    const scopedArgs = { ...args, droppableContainers: mediaTargets };
    const pointerCollisions = pointerWithin(scopedArgs);
    return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(scopedArgs);
  }
  return closestCenter(args);
};

function draggedMedia(data: Record<string, unknown> | undefined): MarkdownMediaPick | null {
  return data?.kind === "posto-media" ? ((data as unknown as MediaDragData).media ?? null) : null;
}

function draggedSource(data: Record<string, unknown> | undefined): MediaDragSource | null {
  return data?.kind === "posto-media" ? ((data as unknown as MediaDragData).source ?? null) : null;
}

interface MediaDragState {
  activeMedia: MarkdownMediaPick | null;
  activeSource: MediaDragSource | null;
  pointer: { x: number; y: number } | null;
}

const MediaDragContext = createContext<MediaDragState>({
  activeMedia: null,
  activeSource: null,
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
  const [activeSource, setActiveSource] = useState<MediaDragSource | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const startPointer = useRef<{ x: number; y: number } | null>(null);
  const livePointer = useRef<{ x: number; y: number } | null>(null);
  const dragSource = useRef<MediaDragSource | null>(null);
  const dragSourcePosition = useRef<number | undefined>(undefined);
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
    setPointer(null);
    setActiveMedia(null);
    setActiveSource(null);
  };

  // dnd-kit owns the drag lifecycle; keep the actual pointer separately so
  // insertion never depends on the translated dimensions of the drag overlay.
  useEffect(() => {
    if (!activeMedia) return;
    const updatePointer = (event: PointerEvent) => {
      const next = { x: event.clientX, y: event.clientY };
      livePointer.current = next;
      setPointer(next);
    };
    window.addEventListener("pointermove", updatePointer);
    return () => window.removeEventListener("pointermove", updatePointer);
  }, [activeMedia]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={(event: DragStartEvent) => {
        const start = pointerFromEvent(event.activatorEvent);
        const source = draggedSource(event.active.data.current);
        startPointer.current = start;
        livePointer.current = start;
        dragSource.current = source;
        dragSourcePosition.current = source?.getPosition();
        setPointer(start);
        setActiveMedia(draggedMedia(event.active.data.current));
        setActiveSource(source);
      }}
      onDragMove={(event) => setPointer(pointerForEvent(event))}
      onDragCancel={clearDrag}
      onDragEnd={(event) => {
        const media = draggedMedia(event.active.data.current);
        const drop = event.over?.data.current as unknown as MediaDropData | undefined;
        if (media && drop?.kind === "posto-media-drop" && drop.accepts(media)) {
          drop.onDrop(media, event, {
            pointer: pointerForEvent(event),
            source: dragSource.current,
            sourcePosition: dragSourcePosition.current,
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
      <MediaDragContext.Provider value={{ activeMedia, activeSource, pointer }}>
        {props.children}
        <DragOverlay dropAnimation={null}>
          {activeMedia ? (
            <div className="media-drag-overlay">
              <Image size={18} />
              <span>{activeMedia.label}</span>
            </div>
          ) : null}
        </DragOverlay>
      </MediaDragContext.Provider>
    </DndContext>
  );
}

export function useMediaDraggable(input: {
  id: string;
  media: MarkdownMediaPick | null | undefined;
  source?: MediaDragSource;
}) {
  return useDraggable({
    id: input.id,
    disabled: !input.media,
    data: input.media
      ? ({ kind: "posto-media", media: input.media, source: input.source } satisfies MediaDragData)
      : {},
  });
}

/** Dedicated dnd-kit drag handle around a media-card preview. */
export function MediaDragPreview(props: {
  id: string;
  media: MarkdownMediaPick | null | undefined;
  className: string;
  children: ReactNode;
}) {
  const draggable = useMediaDraggable({ id: props.id, media: props.media });
  return (
    <span
      ref={draggable.setNodeRef}
      className={`${props.className}${props.media ? " is-media-draggable" : ""}${draggable.isDragging ? " is-dragging" : ""}`}
      {...draggable.attributes}
      {...draggable.listeners}
    >
      {props.children}
    </span>
  );
}

export function useMediaDropZone(input: {
  id: string;
  accepts: (media: MarkdownMediaPick) => boolean;
  onDrop: (media: MarkdownMediaPick, event: DragEndEvent, details: MediaDropDetails) => void;
}) {
  const drag = useContext(MediaDragContext);
  const droppable = useDroppable({
    id: input.id,
    data: {
      kind: "posto-media-drop",
      accepts: input.accepts,
      onDrop: input.onDrop,
    } satisfies MediaDropData,
  });
  const media = draggedMedia(droppable.active?.data.current);
  return {
    setNodeRef: droppable.setNodeRef,
    isOver: droppable.isOver,
    isAccepting: droppable.isOver && !!media && input.accepts(media),
    pointer: drag.pointer,
    activeMedia: drag.activeMedia,
    activeSource: drag.activeSource,
  };
}

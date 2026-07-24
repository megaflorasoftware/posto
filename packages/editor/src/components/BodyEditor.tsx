import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, RichTextEditor } from "@mantine/tiptap";
import { Alert, Button, Group, Loader, TextInput } from "@mantine/core";
import { useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { Blocks, CodeXml, Image as ImageIcon } from "lucide-react";

import { assetUrl, onFileDrop } from "@posto/ipc";
import type { FileDropDetails, FileGroup } from "@posto/ipc";
import {
  expandMediaEntry,
  mediaInputPath,
  mediaOutputPath,
  type MediaLibrary,
  type ContentEntry,
  type MediaEntry,
  type PagesConfig,
} from "@posto/core/pagescms/config";
import { importInfo, resolveImportPath, splitLeadingImports } from "@posto/core/mdx/mdx";
import type { ComponentRef, ComponentSchemaSource } from "@posto/core/project/adapter";
import type { EntryIdSource } from "@posto/core/project/entryIds";
import { ComponentPicker } from "./ComponentPicker";
import { Dialog } from "./Dialog";
import {
  EditableBlockImage,
  EditableImage,
  EditableImageContext,
  type EditableImageRequest,
} from "./EditableImage";
import { ImageLibraryEditDialog } from "./ImageLibraryManageDialogs";
import { htmlNodes } from "./HtmlNodes";
import { RichTextImagePickerDialog } from "./RichTextImagePickerDialog";
import {
  MdxFieldEnvContext,
  MdxSchemaContext,
  componentSchemas,
  mdxNodes,
  type ComponentBlockSchema,
} from "./MdxNodes";
import { useProjectIO } from "../projectIO";
import { markdownMediaEditorContent, type MarkdownMediaPick } from "../markdownMedia";
import { droppedImagePaths } from "../droppedImages";
import { resolveImageLibraryLocation } from "@posto/core/project/mediaLibrary";
import { useImageLibraryAssets } from "../hooks/useImageLibraryAssets";
import {
  bodyNodePosition,
  useRichTextDropZone,
  type BodyNodeDragDetails,
  type BodyNodeDragSource,
  type MediaDragSource,
  type MediaDropDetails,
} from "./MediaDragDrop";

function normalizedMediaPath(path: string): string {
  return path.replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
}

function defaultLibraryMedia(library: MediaLibrary): MediaEntry {
  const input = normalizedMediaPath(library.base);
  return { name: `library:${library.collection}`, input, output: `/${input}` };
}

function outputContains(output: string, src: string): boolean {
  const prefix = `/${normalizedMediaPath(output)}`;
  return src === prefix || src.startsWith(`${prefix}/`);
}

export interface RichTextDropLocation {
  pos: number;
  left: number;
  top: number;
  width: number;
  height: number;
  orientation: "horizontal" | "vertical";
  blockBoundary: boolean;
}

interface ImageDropBox {
  pos: number;
  size: number;
  rect: DOMRect;
  hitRect?: DOMRect;
  blockFrom?: number;
  blockTo?: number;
  parentStart?: number;
  parentDepth?: number;
}

type RichTextDragSource = MediaDragSource | BodyNodeDragSource;

interface ExternalImageDrop {
  sources: string[];
  location: RichTextDropLocation;
}

const draggableBodyNodeTypes = new Set([
  "image",
  "blockImage",
  "mdxComponent",
  "mdxRawInline",
  "htmlBlock",
  "htmlInline",
]);

/** Inserts imported media at a previously captured drop position and returns
 * the next insertion position so multi-image drops retain their source order. */
export function insertMediaAtLocation(
  editor: Editor,
  media: MarkdownMediaPick,
  location: Pick<RichTextDropLocation, "pos" | "blockBoundary">,
): number {
  const imageContent = markdownMediaEditorContent(media);
  editor
    .chain()
    .focus()
    .insertContentAt(
      location.pos,
      location.blockBoundary ? { ...imageContent, type: "blockImage" } : imageContent,
      { updateSelection: true },
    )
    .run();
  // Both inline and block image nodes are atoms with nodeSize 1. Advancing
  // explicitly is more reliable than the command's resulting selection,
  // which ProseMirror may place before a newly inserted block atom.
  return location.pos + 1;
}

export function insertMediaBatchAtLocation(
  editor: Editor,
  media: MarkdownMediaPick[],
  location: Pick<RichTextDropLocation, "pos" | "blockBoundary">,
): number {
  let position = location.pos;
  for (const item of media) {
    position = insertMediaAtLocation(editor, item, { ...location, pos: position });
  }
  return position;
}

function inRange(value: number, first: number, second: number, padding = 0): boolean {
  return value >= Math.min(first, second) - padding && value <= Math.max(first, second) + padding;
}

export function imageGapLocation(
  boxes: ImageDropBox[],
  pointer: { x: number; y: number },
  contentRect: DOMRect,
  hasOnlyWhitespaceBetween: (left: ImageDropBox, right: ImageDropBox) => boolean,
): RichTextDropLocation | null {
  const groups = new Map<string, ImageDropBox[]>();
  for (const box of boxes) {
    const key = `${box.parentDepth ?? 0}:${box.parentStart ?? 0}`;
    const group = groups.get(key) ?? [];
    group.push(box);
    groups.set(key, group);
  }
  const gaps: { location: RichTextDropLocation; depth: number; distance: number }[] = [];
  for (const group of groups.values()) {
    group.sort((left, right) => left.pos - right.pos);
    for (let index = 0; index < group.length - 1; index += 1) {
      const left = group[index];
      const right = group[index + 1];
      if (!hasOnlyWhitespaceBetween(left, right)) continue;
      const leftCenter = {
        x: left.rect.left + left.rect.width / 2,
        y: left.rect.top + left.rect.height / 2,
      };
      const rightCenter = {
        x: right.rect.left + right.rect.width / 2,
        y: right.rect.top + right.rect.height / 2,
      };
      const verticalOverlap =
        Math.min(left.rect.bottom, right.rect.bottom) - Math.max(left.rect.top, right.rect.top);
      const sameRow = verticalOverlap >= Math.min(left.rect.height, right.rect.height) * 0.4;
      if (
        sameRow &&
        inRange(pointer.x, leftCenter.x, rightCenter.x) &&
        inRange(
          pointer.y,
          Math.min(left.rect.top, right.rect.top),
          Math.max(left.rect.bottom, right.rect.bottom),
          12,
        )
      ) {
        const caretLeft = (left.rect.right + right.rect.left) / 2;
        gaps.push({
          location: {
            pos: right.pos,
            left: caretLeft,
            top: Math.min(left.rect.top, right.rect.top),
            width: 3,
            height:
              Math.max(left.rect.bottom, right.rect.bottom) -
              Math.min(left.rect.top, right.rect.top),
            orientation: "vertical",
            blockBoundary: false,
          },
          depth: right.parentDepth ?? 0,
          distance: Math.abs(pointer.x - caretLeft),
        });
      }
      if (
        !sameRow &&
        inRange(pointer.y, leftCenter.y, rightCenter.y) &&
        inRange(
          pointer.x,
          Math.min(left.rect.left, right.rect.left),
          Math.max(left.rect.right, right.rect.right),
          24,
        )
      ) {
        const caretLeft = Math.max(contentRect.left, Math.min(left.rect.left, right.rect.left));
        const caretRight = Math.min(contentRect.right, Math.max(left.rect.right, right.rect.right));
        const caretTop = (left.rect.bottom + right.rect.top) / 2;
        gaps.push({
          location: {
            pos: right.blockFrom ?? right.pos,
            left: caretLeft,
            top: caretTop,
            width: Math.max(caretRight - caretLeft, 24),
            height: 3,
            orientation: "horizontal",
            blockBoundary: right.blockFrom !== undefined,
          },
          depth: right.parentDepth ?? 0,
          distance: Math.abs(pointer.y - caretTop),
        });
      }
    }
  }
  gaps.sort((left, right) => right.depth - left.depth || left.distance - right.distance);
  if (gaps[0]) return gaps[0].location;

  const hits = boxes.filter((box) => {
    const rect = box.hitRect ?? box.rect;
    return (
      pointer.x >= rect.left &&
      pointer.x <= rect.right &&
      pointer.y >= rect.top &&
      pointer.y <= rect.bottom
    );
  });
  hits.sort(
    (left, right) =>
      (right.parentDepth ?? 0) - (left.parentDepth ?? 0) ||
      left.rect.width * left.rect.height - right.rect.width * right.rect.height,
  );
  const hit = hits[0];
  if (!hit) return null;
  const hitRect = hit.hitRect ?? hit.rect;
  const blockLike = hit.blockFrom !== undefined || hit.rect.width >= contentRect.width * 0.45;
  if (blockLike) {
    const before = pointer.y < hitRect.top + hitRect.height / 2;
    return {
      pos: before ? (hit.blockFrom ?? hit.pos) : (hit.blockTo ?? hit.pos + hit.size),
      left: Math.max(contentRect.left, hit.rect.left),
      top: before ? hit.rect.top : hit.rect.bottom,
      width:
        Math.min(contentRect.right, hit.rect.right) - Math.max(contentRect.left, hit.rect.left),
      height: 3,
      orientation: "horizontal",
      blockBoundary: hit.blockFrom !== undefined,
    };
  }
  const before = pointer.x < hit.rect.left + hit.rect.width / 2;
  return {
    pos: before ? hit.pos : hit.pos + hit.size,
    left: before ? hit.rect.left : hit.rect.right,
    top: hit.rect.top,
    width: 3,
    height: Math.max(hit.rect.height, 18),
    orientation: "vertical",
    blockBoundary: false,
  };
}

export function bodyNodeMoveTransaction(
  state: EditorState,
  sourcePosition: number,
  location: Pick<RichTextDropLocation, "pos" | "blockBoundary">,
): Transaction | null {
  const sourceNode = state.doc.nodeAt(sourcePosition);
  if (!sourceNode || !draggableBodyNodeTypes.has(sourceNode.type.name)) return null;
  let from = sourcePosition;
  let to = sourcePosition + sourceNode.nodeSize;
  let movedNode = sourceNode;
  const $source = state.doc.resolve(sourcePosition);
  if (
    location.blockBoundary &&
    $source.parent.type.name === "paragraph" &&
    $source.parent.childCount === 1 &&
    $source.parent.firstChild === sourceNode
  ) {
    from = $source.before();
    to = $source.after();
    movedNode = $source.parent;
  } else if (location.blockBoundary && sourceNode.isInline) {
    const paragraph = state.schema.nodes.paragraph?.createAndFill(null, sourceNode);
    if (!paragraph) return null;
    movedNode = paragraph;
  }
  if (!location.blockBoundary && sourceNode.isBlock) return null;
  if (location.pos >= from && location.pos <= to) return null;
  try {
    const transaction = state.tr.delete(from, to);
    const target = transaction.mapping.map(location.pos);
    if (location.blockBoundary) {
      transaction.insert(target, movedNode);
    } else {
      transaction.replaceRangeWith(target, target, movedNode);
    }
    return transaction.docChanged ? transaction.scrollIntoView() : null;
  } catch {
    return null;
  }
}

export function imageMoveTransaction(
  state: EditorState,
  sourcePosition: number,
  location: Pick<RichTextDropLocation, "pos" | "blockBoundary">,
): Transaction | null {
  const node = state.doc.nodeAt(sourcePosition);
  if (node?.type.name !== "image" && node?.type.name !== "blockImage") return null;
  return bodyNodeMoveTransaction(state, sourcePosition, location);
}

function StandaloneImageEditDialog(props: { request: EditableImageRequest; onClose: () => void }) {
  const [src, setSrc] = useState(props.request.src);
  const [alt, setAlt] = useState(props.request.alt);
  return (
    <Dialog opened onClose={props.onClose} title="Edit image" size="sm">
      <TextInput
        label="Image path"
        value={src}
        onChange={(event) => setSrc(event.currentTarget.value)}
      />
      <TextInput
        mt="sm"
        label="Alternative text"
        value={alt}
        onChange={(event) => setAlt(event.currentTarget.value)}
      />
      <Group justify="flex-end" mt="md">
        <Button variant="default" onClick={props.onClose}>
          Cancel
        </Button>
        <Button
          disabled={src.trim() === ""}
          onClick={() => {
            props.request.update({ src: src.trim(), alt: alt.trim() });
            props.onClose();
          }}
        >
          Save changes
        </Button>
      </Group>
    </Dialog>
  );
}

function LibraryImageEditDialog(props: {
  root: string;
  library: MediaLibrary;
  media: MediaEntry;
  request: EditableImageRequest;
  config: PagesConfig;
  groups: FileGroup[];
  onBeforeChange: () => Promise<void>;
  onChanged: (options?: { silent?: boolean }) => void;
  onClose: () => void;
}) {
  const state = useImageLibraryAssets(props.root, props.library);
  const asset = state.assets.find(
    (candidate) =>
      !!candidate.imagePath &&
      mediaOutputPath(props.root, props.media, candidate.imagePath) === props.request.src,
  );

  if (state.loading) {
    return (
      <Dialog opened onClose={props.onClose} title="Edit image" size="sm">
        <div className="body-image-edit-loading">
          <Loader size="sm" />
        </div>
      </Dialog>
    );
  }
  if (state.error) {
    return (
      <Dialog opened onClose={props.onClose} title="Edit image" size="sm">
        <Alert color="red">Could not read image library: {state.error}</Alert>
      </Dialog>
    );
  }
  if (!asset) return <StandaloneImageEditDialog request={props.request} onClose={props.onClose} />;
  return (
    <ImageLibraryEditDialog
      root={props.root}
      library={props.library}
      config={props.config}
      groups={props.groups}
      asset={asset}
      onBeforeChange={props.onBeforeChange}
      onClose={props.onClose}
      onChanged={(options) => {
        void state.refresh();
        props.onChanged(options);
      }}
    />
  );
}

/** An import statement managed outside the document, with its bindings. */
interface ManagedImport {
  statement: string;
  names: string[];
  /** Imports already unused when the content loaded are kept until first
   * used; from then on they live and die with their component's usage. */
  pinned: boolean;
}

/** Capitalized JSX tag names appearing anywhere in the markdown body — the
 * signal for which component imports the body still needs. */
function bodyComponentNames(markdown: string): Set<string> {
  return new Set([...markdown.matchAll(/<([A-Z][\w.]*)[\s/>]/g)].map((m) => m[1].split(".")[0]));
}

function toManagedImports(statements: string[], body: string): ManagedImport[] {
  const used = bodyComponentNames(body);
  return statements.map((statement) => {
    const { names } = importInfo(statement);
    return { statement, names, pinned: !names.some((name) => used.has(name)) };
  });
}

export function bodyEditorMode(mdx: boolean, componentBlocks: ComponentSchemaSource | null) {
  return { mdx, componentBlocksEnabled: componentBlocks !== null };
}

/**
 * Rich-text editor for the markdown body. Tiptap owns the document; markdown
 * goes in on mount (and on external changes) and comes back out through
 * `getMarkdown()` on every edit. Image nodes store the site-relative output
 * path (what the markdown references) while the webview displays them through
 * the media source's input directory.
 *
 * In MDX mode the leading import block never enters the document: imports are
 * split off into a managed list, hidden from the editor, and recomposed into
 * the emitted markdown — added when a picked component needs one, dropped
 * when the body no longer references their component.
 */
export function BodyEditor(props: {
  value: string;
  /** Absolute path of the file being edited; resolves relative MDX imports. */
  path: string;
  /** MDX mode adds component cards, raw-JSX preservation, and hidden
   * auto-managed imports. */
  mdx: boolean;
  root: string;
  /** Expanded collection-scoped `.posto`/Pages media directory. It must map
   * to a discovered Astro image library or one of its included subfolders. */
  configuredMedia: MediaEntry | null;
  /** Collection entry of the edited file; scopes media resolution for image
   * props inside component cards. */
  entry?: ContentEntry | null;
  /** Top-level frontmatter for per-entry media-folder templates. */
  templateValues: Record<string, unknown>;
  /** Full config + sidebar groups, for field controls inside component cards. */
  config: PagesConfig;
  groups: FileGroup[];
  componentBlocks: ComponentSchemaSource | null;
  entryIds: EntryIdSource | null;
  componentSchemaVersion?: number;
  toolbarLeading?: ReactNode;
  toolbarTrailing?: ReactNode;
  /** Flushes the open document before a library edit rewrites references. */
  onBeforeMediaChange?: () => Promise<void>;
  /** Refreshes shell state after a library-backed image changes. */
  onMediaChanged?: (options?: { silent?: boolean }) => void;
  onChange: (markdown: string) => void;
}) {
  const { mdx, componentBlocksEnabled } = bodyEditorMode(props.mdx, props.componentBlocks);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [externalImageDrop, setExternalImageDrop] = useState<ExternalImageDrop | null>(null);
  const [componentPickerOpen, setComponentPickerOpen] = useState(false);
  const [editingImage, setEditingImage] = useState<EditableImageRequest | null>(null);
  const [schemas, setSchemas] = useState<Record<string, ComponentBlockSchema>>({});
  const projectIO = useProjectIO();
  const configuredMedia = props.configuredMedia
    ? expandMediaEntry(props.configuredMedia, props.templateValues)
    : null;
  // Markdown emitted by this editor; used to ignore the echo when it comes
  // back through props so only genuinely external changes reset the document.
  const lastEmitted = useRef<string | null>(null);

  // MDX only: leading imports live here, not in the document. The initial
  // split runs once — the component remounts per file (keyed upstream).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initial = useMemo(
    () => (mdx ? splitLeadingImports(props.value) : { imports: [], body: props.value }),
    [],
  );
  const importsRef = useRef<ManagedImport[]>(toManagedImports(initial.imports, initial.body));

  /** Emitted markdown: managed imports (filtered to what the body still
   * uses) above the document's markdown. */
  function composeMarkdown(body: string): string {
    if (!mdx) return body;
    const used = bodyComponentNames(body);
    const kept = importsRef.current.filter((imp) => {
      // Bindingless (side-effect) imports are never auto-removed.
      if (imp.names.length === 0) return true;
      if (imp.names.some((name) => used.has(name))) {
        imp.pinned = false;
        return true;
      }
      return imp.pinned;
    });
    importsRef.current = kept;
    if (kept.length === 0) return body;
    return kept.map((imp) => imp.statement).join("\n") + "\n\n" + body;
  }

  // The display resolver is read through a ref so the Image extension (created
  // once) always sees the current root/media libraries.
  const resolveSrc = (src: string): string => {
    if (!src.startsWith("/")) return src;
    let filesystemSrc = src;
    try {
      filesystemSrc = decodeURIComponent(src);
    } catch {
      // Keep malformed percent escapes displayable through the existing path.
    }
    const libraryMedia = (props.config.mediaLibraries ?? []).map((library) => {
      const input = library.base.replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
      return { name: `library:${library.collection}`, input, output: `/${input}` };
    });
    const candidates = [configuredMedia, ...libraryMedia].filter(
      (media): media is MediaEntry => media !== null,
    );
    const absolute = candidates
      .map((media) => mediaInputPath(props.root, media, filesystemSrc))
      .find((path): path is string => path !== null);
    // Site-root paths outside the media source usually live in the site's
    // `public` folder, which is served from `/` — try there before giving up.
    return (
      (absolute && assetUrl(absolute)) || assetUrl(props.root + "/public" + filesystemSrc) || src
    );
  };
  const resolveRef = useRef(resolveSrc);
  resolveRef.current = resolveSrc;

  const extensions = useMemo(
    () => [
      // Link comes from @mantine/tiptap (adds the Ctrl+K popover); underline
      // has no markdown equivalent.
      StarterKit.configure({ link: false, underline: false }),
      Link,
      Markdown,
      // Standalone Markdown images are block tokens. Giving them a block node
      // keeps the ProseMirror document valid and therefore transformable.
      EditableBlockImage,
      // Inline like markdown images; src attr keeps the stored output path,
      // only the rendered <img> is rewritten to a loadable URL.
      EditableImage,
      // HTML preservation applies to .md and .mdx alike: authored tags like
      // <kbd> round-trip as chips instead of being stripped.
      ...htmlNodes,
      ...(mdx ? mdxNodes : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const editor = useEditor({
    extensions,
    content: initial.body,
    contentType: "markdown",
    editorProps: {
      attributes: {
        "aria-label": "Body",
        "data-empty": initial.body.trim() === "" ? "true" : "false",
        "data-placeholder": "Start writing...",
      },
    },
    onCreate: ({ editor }) => {
      editor.view.dom.dataset.empty = editor.isEmpty ? "true" : "false";
    },
    onUpdate: ({ editor }) => {
      editor.view.dom.dataset.empty = editor.isEmpty ? "true" : "false";
      const markdown = composeMarkdown(editor.getMarkdown());
      lastEmitted.current = markdown;
      props.onChange(markdown);
    },
  });

  const bodyDropContainer = useRef<HTMLDivElement | null>(null);
  const dropLocationRef = useRef<RichTextDropLocation | null>(null);
  const externalDropLocationRef = useRef<RichTextDropLocation | null>(null);
  const [dropCaret, setDropCaret] = useState<RichTextDropLocation | null>(null);

  const dropLocationAtPointer = (
    pointer: MediaDropDetails["pointer"],
    source: RichTextDragSource | null,
    capturedSourcePosition?: number,
  ): RichTextDropLocation | null => {
    if (!editor || !pointer) return null;
    const fallback = editor.view.posAtCoords({ left: pointer.x, top: pointer.y });
    if (!fallback) return null;
    const contentRect = editor.view.dom.getBoundingClientRect();
    const sourcePosition =
      source?.kind !== "media-sidebar" && source?.editorId === props.path
        ? (capturedSourcePosition ?? source.getPosition())
        : undefined;
    const boxes = Array.from(editor.view.dom.querySelectorAll<HTMLElement>(".body-draggable-node"))
      .map((element): ImageDropBox | null => {
        try {
          const pos = bodyNodePosition(element);
          if (pos === undefined) return null;
          const node = editor.state.doc.nodeAt(pos);
          if (!node || !draggableBodyNodeTypes.has(node.type.name) || pos === sourcePosition) {
            return null;
          }
          const $pos = editor.state.doc.resolve(pos);
          const onlyParagraphChild =
            $pos.parent.type.name === "paragraph" &&
            $pos.parent.childCount === 1 &&
            $pos.parent.firstChild === node;
          const parentDepth = onlyParagraphChild ? Math.max(0, $pos.depth - 1) : $pos.depth;
          const rect = element.getBoundingClientRect();
          const componentHeader =
            node.type.name === "mdxComponent"
              ? element.querySelector<HTMLElement>(":scope > .mdx-card-header")
              : null;
          return {
            pos,
            size: node.nodeSize,
            rect,
            hitRect: componentHeader?.getBoundingClientRect() ?? rect,
            blockFrom: node.isBlock ? pos : onlyParagraphChild ? $pos.before() : undefined,
            blockTo: node.isBlock
              ? pos + node.nodeSize
              : onlyParagraphChild
                ? $pos.after()
                : undefined,
            parentStart: $pos.start(parentDepth),
            parentDepth,
          };
        } catch {
          return null;
        }
      })
      .filter((box): box is ImageDropBox => box !== null)
      .sort((left, right) => left.pos - right.pos);
    const imageLocation = imageGapLocation(
      boxes,
      pointer,
      contentRect,
      (left, right) =>
        editor.state.doc
          .textBetween(left.pos + left.size, right.pos, "\n", "\ufffc")
          .replace(/\ufffc/g, "")
          .trim().length === 0,
    );
    if (imageLocation) return imageLocation;
    const sourceNode =
      typeof sourcePosition === "number" ? editor.state.doc.nodeAt(sourcePosition) : null;
    if (sourceNode?.isBlock) {
      const $fallback = editor.state.doc.resolve(fallback.pos);
      for (let depth = $fallback.depth; depth >= 0; depth -= 1) {
        const parent = $fallback.node(depth);
        if (parent.childCount === 0) continue;
        const childIndex = Math.min($fallback.index(depth), parent.childCount - 1);
        const childPosition = $fallback.posAtIndex(childIndex, depth);
        const dom = editor.view.nodeDOM(childPosition);
        const element = dom instanceof HTMLElement ? dom : dom?.parentElement;
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        const before = pointer.y < rect.top + rect.height / 2;
        const insertionIndex = before ? childIndex : childIndex + 1;
        if (!parent.canReplaceWith(insertionIndex, insertionIndex, sourceNode.type)) continue;
        const left = Math.max(contentRect.left, rect.left);
        const right = Math.min(contentRect.right, rect.right);
        return {
          pos: $fallback.posAtIndex(insertionIndex, depth),
          left,
          top: before ? rect.top : rect.bottom,
          width: Math.max(right - left, 24),
          height: 3,
          orientation: "horizontal",
          blockBoundary: true,
        };
      }
    }
    const coordinates = editor.view.coordsAtPos(fallback.pos);
    return {
      pos: fallback.pos,
      left: coordinates.left,
      top: coordinates.top,
      width: 3,
      height: Math.max(coordinates.bottom - coordinates.top, 18),
      orientation: "vertical",
      blockBoundary: false,
    };
  };

  useEffect(() => {
    const libraries = props.config.mediaLibraries ?? [];
    if (!editor || libraries.length === 0 || pickerOpen || externalImageDrop) return;
    const acceptsEditorImageDrop = (paths: string[], details: FileDropDetails) => {
      const pointer = details.pointer;
      const container = bodyDropContainer.current;
      if (!pointer || !container || droppedImagePaths(paths).length === 0) return false;
      const bounds = container.getBoundingClientRect();
      const hit = document.elementFromPoint(pointer.x, pointer.y);
      return (
        !!hit &&
        container.contains(hit) &&
        pointer.x >= bounds.left &&
        pointer.x <= bounds.right &&
        pointer.y >= bounds.top &&
        pointer.y <= bounds.bottom
      );
    };
    return onFileDrop(
      (paths, details) => {
        const location = dropLocationAtPointer(details.pointer, null);
        const sources = droppedImagePaths(paths);
        if (!location || sources.length === 0) return;
        externalDropLocationRef.current = location;
        setExternalImageDrop({ sources, location });
      },
      { priority: 50, accepts: acceptsEditorImageDrop },
    );
    // dropLocationAtPointer deliberately reads the current editor view and DOM.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, externalImageDrop, pickerOpen, props.config.mediaLibraries, props.path]);

  const insertOrMoveImages = (
    media: Parameters<typeof markdownMediaEditorContent>[0][],
    details: MediaDropDetails,
  ) => {
    if (!editor) return;
    const location = dropLocationRef.current ??
      dropLocationAtPointer(details.pointer, details.source, details.sourcePosition) ?? {
        pos: editor.state.selection.from,
        left: 0,
        top: 0,
        width: 3,
        height: 18,
        orientation: "vertical" as const,
        blockBoundary: false,
      };
    const source = details.source;
    if (media.length === 1 && source?.kind === "body-image" && source.editorId === props.path) {
      const sourcePosition = details.sourcePosition ?? source.getPosition();
      if (typeof sourcePosition === "number") {
        const transaction = imageMoveTransaction(editor.state, sourcePosition, location);
        if (!transaction) return;
        editor.view.dispatch(transaction);
        editor.view.focus();
        return;
      }
    }
    insertMediaBatchAtLocation(editor, media, location);
  };

  const moveBodyNode = (source: BodyNodeDragSource, details: BodyNodeDragDetails) => {
    if (!editor || source.editorId !== props.path) return;
    const location =
      dropLocationRef.current ??
      dropLocationAtPointer(details.pointer, source, details.sourcePosition);
    const sourcePosition = details.sourcePosition ?? source.getPosition();
    if (!location || typeof sourcePosition !== "number") return;
    const transaction = bodyNodeMoveTransaction(editor.state, sourcePosition, location);
    if (!transaction) return;
    editor.view.dispatch(transaction);
    editor.view.focus();
  };

  const bodyDrop = useRichTextDropZone({
    id: `body:${props.path}`,
    mediaCategory: "image-list",
    onMediaDrop: (media, _event, details) => insertOrMoveImages(media, details),
    onBodyNodeDrop: (source, _event, details) => moveBodyNode(source, details),
  });

  useLayoutEffect(() => {
    const container = bodyDropContainer.current;
    const activeSource = bodyDrop.activeBodySource ?? bodyDrop.activeMediaSource;
    const location = dropLocationAtPointer(bodyDrop.pointer, activeSource);
    if (!editor || !container || !bodyDrop.isAccepting || location === null) {
      dropLocationRef.current = null;
      setDropCaret(null);
      return;
    }
    const bounds = container.getBoundingClientRect();
    const relativeLocation = {
      ...location,
      left: location.left - bounds.left,
      top: location.top - bounds.top,
    };
    dropLocationRef.current = location;
    setDropCaret(relativeLocation);
  }, [
    editor,
    bodyDrop.activeBodySource,
    bodyDrop.activeMediaSource,
    bodyDrop.isAccepting,
    bodyDrop.pointer?.x,
    bodyDrop.pointer?.y,
  ]);

  // External content changes (raw-tab edits while this file stays open):
  // replace the document without emitting an update.
  useEffect(() => {
    if (!editor || props.value === lastEmitted.current) return;
    const next = mdx ? splitLeadingImports(props.value) : { imports: [], body: props.value };
    importsRef.current = toManagedImports(next.imports, next.body);
    if (next.body === editor.getMarkdown()) return;
    editor.commands.setContent(next.body, { contentType: "markdown", emitUpdate: false });
    editor.view.dom.dataset.empty = editor.isEmpty ? "true" : "false";
  }, [editor, props.value]);

  // The active adapter owns component discovery and prop parsing. The editor
  // only consumes neutral fields and slot metadata for components imported by
  // this document.
  const importsKey = mdx ? splitLeadingImports(props.value).imports.join("\u0000") : "";
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded: Record<string, ComponentBlockSchema> = {};
      const source = props.componentBlocks;
      if (!source) {
        if (!cancelled) {
          setSchemas({});
          componentSchemas.current = {};
          editor?.view.dispatch(editor.state.tr.setMeta("mdxSchemas", true));
        }
        return;
      }
      for (const statement of importsKey === "" ? [] : importsKey.split("\u0000")) {
        const { names, spec } = importInfo(statement);
        if (!spec || names.length === 0) continue;
        const file = resolveImportPath(props.path, spec);
        if (!file) continue;
        try {
          const result = await source.componentFields(
            { name: names[0], path: file },
            projectIO,
            props.config,
          );
          if (!result) continue;
          for (const name of names) {
            loaded[name] = {
              fields: result.fields,
              slots: result.slots ?? [],
              hasDefaultSlot: result.hasDefaultSlot ?? false,
            };
          }
        } catch {}
      }
      if (cancelled) return;
      setSchemas(loaded);
      // The markdown pipeline and the slot-sync plugin read schemas outside
      // React; the poke transaction makes slot sync run with the new data.
      componentSchemas.current = loaded;
      editor?.view.dispatch(editor.state.tr.setMeta("mdxSchemas", true));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    importsKey,
    projectIO,
    props.path,
    props.componentBlocks,
    props.componentSchemaVersion,
    props.config,
  ]);

  // Inserts the picked component at the cursor and, when it isn't imported
  // yet, adds the import at the top of the document. A cursor inside written
  // text gets an inline component; an empty paragraph (or block position)
  // gets a block one, so the paragraph is never split by the insert.
  function insertComponent(file: ComponentRef) {
    if (!editor) return;
    const name = file.name;
    const alreadyImported = importsRef.current.some((imp) => imp.names.includes(name));
    const { $from } = editor.state.selection;
    const inline = $from.parent.isTextblock && $from.parent.content.size > 0;
    // Block cards carry one section per declared slot. With no loaded schema
    // yet, start with a default section; the slot-sync plugin reconciles
    // sections once the component's schema arrives.
    const emptySlot = (slot: string | null) => ({
      type: "mdxSlot",
      attrs: { slot },
      content: [{ type: "paragraph" }],
    });
    const schema = schemas[name];
    const slotContent = schema
      ? [...(schema.hasDefaultSlot ? [emptySlot(null)] : []), ...schema.slots.map(emptySlot)]
      : [emptySlot(null)];
    if (!alreadyImported) {
      importsRef.current.push({
        statement: props.componentBlocks?.importFor(file, props.path) ?? "",
        names: [name],
        pinned: false,
      });
    }
    editor
      .chain()
      .focus()
      .insertContent(
        inline
          ? { type: "mdxRawInline", attrs: { source: `<${name} />` } }
          : {
              type: "mdxComponent",
              attrs: { name, props: [], propsSource: "", raw: null },
              content: slotContent,
            },
      )
      .run();
  }

  // Inserts an empty custom-HTML chip at the cursor: inline when the cursor
  // sits inside written text, block otherwise (mirrors insertComponent).
  function insertHtml() {
    if (!editor) return;
    const { $from } = editor.state.selection;
    const inline = $from.parent.isTextblock && $from.parent.content.size > 0;
    editor
      .chain()
      .focus()
      .insertContent(
        inline
          ? { type: "htmlInline", attrs: { source: "<span></span>" } }
          : { type: "htmlBlock", attrs: { source: "<div>\n</div>" } },
      )
      .run();
  }

  const expandedConfiguredMedia = props.configuredMedia
    ? expandMediaEntry(props.configuredMedia, props.templateValues)
    : null;
  const configuredLibrary = expandedConfiguredMedia
    ? resolveImageLibraryLocation(props.config.mediaLibraries ?? [], expandedConfiguredMedia.input)
    : null;
  const libraryImage = editingImage
    ? ([
        ...(configuredLibrary && expandedConfiguredMedia
          ? [{ library: configuredLibrary.library, media: expandedConfiguredMedia }]
          : []),
        ...(props.config.mediaLibraries ?? []).map((library) => ({
          library,
          media: defaultLibraryMedia(library),
        })),
      ]
        .sort((left, right) => right.media.output.length - left.media.output.length)
        .find((candidate) => outputContains(candidate.media.output, editingImage.src)) ?? null)
    : null;

  return (
    // Component-card node views render through portals inside the content
    // element, so these providers reach them.
    <MdxSchemaContext.Provider value={schemas}>
      <MdxFieldEnvContext.Provider
        value={{
          editorId: props.path,
          config: props.config,
          root: props.root,
          groups: props.groups,
          entryIds: props.entryIds,
          entry: props.entry ?? null,
          templateValues: props.templateValues,
        }}
      >
        <EditableImageContext.Provider
          value={{
            editorId: props.path,
            resolveSrc: (src) => resolveRef.current(src),
            edit: setEditingImage,
          }}
        >
          <RichTextEditor
            editor={editor}
            className="body-rich-editor"
            // The scroll chain needs a class on every wrapper between the root and
            // the ProseMirror element; Mantine's generated names aren't stable.
            classNames={{ Typography: "body-rich-typography", content: "body-rich-content" }}
          >
            <RichTextEditor.Toolbar>
              {props.toolbarLeading && (
                <div className="body-rich-toolbar-edge">{props.toolbarLeading}</div>
              )}
              <div className="body-rich-toolbar-controls">
                <RichTextEditor.ControlsGroup>
                  <RichTextEditor.H1 />
                  <RichTextEditor.H2 />
                  <RichTextEditor.H3 />
                  <RichTextEditor.H4 />
                </RichTextEditor.ControlsGroup>
                <RichTextEditor.ControlsGroup>
                  <RichTextEditor.Bold />
                  <RichTextEditor.Italic />
                  <RichTextEditor.Strikethrough />
                </RichTextEditor.ControlsGroup>
                <RichTextEditor.ControlsGroup>
                  <RichTextEditor.BulletList />
                  <RichTextEditor.OrderedList />
                  <RichTextEditor.Blockquote />
                  <RichTextEditor.CodeBlock />
                  <RichTextEditor.Hr />
                </RichTextEditor.ControlsGroup>
                <RichTextEditor.ControlsGroup>
                  <RichTextEditor.Link />
                  <RichTextEditor.Unlink />
                  <RichTextEditor.Control
                    title="Insert media"
                    aria-label="Insert media"
                    onClick={() => setPickerOpen(true)}
                  >
                    <ImageIcon size={16} />
                  </RichTextEditor.Control>
                  <RichTextEditor.Control
                    title="Insert HTML"
                    aria-label="Insert HTML"
                    onClick={insertHtml}
                  >
                    <CodeXml size={16} />
                  </RichTextEditor.Control>
                  {mdx && componentBlocksEnabled && (
                    <RichTextEditor.Control
                      title="Insert component"
                      aria-label="Insert component"
                      onClick={() => setComponentPickerOpen(true)}
                    >
                      <Blocks size={16} />
                    </RichTextEditor.Control>
                  )}
                </RichTextEditor.ControlsGroup>
                <RichTextEditor.ControlsGroup>
                  <RichTextEditor.Undo />
                  <RichTextEditor.Redo />
                </RichTextEditor.ControlsGroup>
              </div>
              {props.toolbarTrailing && (
                <div className="body-rich-toolbar-edge" aria-hidden={!props.toolbarTrailing}>
                  {props.toolbarTrailing}
                </div>
              )}
            </RichTextEditor.Toolbar>
            <div
              ref={(node) => {
                bodyDropContainer.current = node;
                bodyDrop.setNodeRef(node);
              }}
              className="body-rich-scroll"
            >
              <RichTextEditor.Content />
              {dropCaret && (
                <span
                  className="body-rich-drop-caret"
                  data-position={dropCaret.pos}
                  data-orientation={dropCaret.orientation}
                  style={{
                    left: dropCaret.left,
                    top: dropCaret.top,
                    width: dropCaret.width,
                    height: dropCaret.height,
                  }}
                  aria-hidden="true"
                />
              )}
            </div>
            {(pickerOpen || externalImageDrop) && (
              <RichTextImagePickerDialog
                root={props.root}
                config={props.config}
                configuredMedia={props.configuredMedia}
                templateValues={props.templateValues}
                groups={props.groups}
                importSourcePaths={externalImageDrop?.sources}
                onClose={() => {
                  setPickerOpen(false);
                  setExternalImageDrop(null);
                  externalDropLocationRef.current = null;
                }}
                onPick={(media) => {
                  const externalLocation = externalDropLocationRef.current;
                  if (editor && externalLocation) {
                    const nextPosition = insertMediaAtLocation(editor, media, externalLocation);
                    externalDropLocationRef.current = {
                      ...externalLocation,
                      pos: nextPosition,
                    };
                    return;
                  }
                  setPickerOpen(false);
                  editor?.chain().focus().insertContent(markdownMediaEditorContent(media)).run();
                }}
              />
            )}
            {componentPickerOpen && componentBlocksEnabled && props.componentBlocks && (
              <ComponentPicker
                root={props.root}
                source={props.componentBlocks}
                onClose={() => setComponentPickerOpen(false)}
                onPick={(file) => {
                  setComponentPickerOpen(false);
                  insertComponent(file);
                }}
                onPickHtml={() => {
                  setComponentPickerOpen(false);
                  insertHtml();
                }}
              />
            )}
          </RichTextEditor>
          {editingImage &&
            (libraryImage ? (
              <LibraryImageEditDialog
                root={props.root}
                library={libraryImage.library}
                media={libraryImage.media}
                request={editingImage}
                config={props.config}
                groups={props.groups}
                onBeforeChange={props.onBeforeMediaChange ?? (async () => undefined)}
                onChanged={(options) => {
                  props.onMediaChanged?.(options);
                  setEditingImage(null);
                }}
                onClose={() => setEditingImage(null)}
              />
            ) : (
              <StandaloneImageEditDialog
                request={editingImage}
                onClose={() => setEditingImage(null)}
              />
            ))}
        </EditableImageContext.Provider>
      </MdxFieldEnvContext.Provider>
    </MdxSchemaContext.Provider>
  );
}

import { createContext, useContext, useId } from "react";
import { ActionIcon } from "@mantine/core";
import TiptapImage from "@tiptap/extension-image";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Pencil, Trash2 } from "lucide-react";
import { bodyNodePosition, registerBodyNodePosition, useMediaDraggable } from "./MediaDragDrop";

export interface EditableImageRequest {
  src: string;
  alt: string;
  update: (attributes: { src: string; alt: string }) => void;
}

interface EditableImageEnvironment {
  editorId: string;
  resolveSrc: (src: string) => string;
  edit: (request: EditableImageRequest) => void;
}

export const EditableImageContext = createContext<EditableImageEnvironment>({
  editorId: "",
  resolveSrc: (src) => src,
  edit: () => undefined,
});

export function editableImagePosition(element: HTMLElement): number | undefined {
  return bodyNodePosition(element);
}

function EditableImageView(props: NodeViewProps) {
  const environment = useContext(EditableImageContext);
  const dragId = useId();
  const src = String(props.node.attrs.src ?? "");
  const alt = String(props.node.attrs.alt ?? "");
  const getPosition = () => {
    const position = props.getPos();
    return typeof position === "number" ? position : undefined;
  };
  const draggable = useMediaDraggable({
    id: `body-image:${environment.editorId}:${dragId}`,
    media: {
      outputPath: src,
      label: alt || src.split("/").pop() || "Image",
      kind: "image",
      alt,
    },
    source: {
      kind: "body-image",
      editorId: environment.editorId,
      getPosition,
    },
  });
  const stopPointer = (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const deleteImage = () => {
    const position = props.getPos();
    if (typeof position !== "number") return;
    props.editor.view.dispatch(
      props.editor.state.tr.delete(position, position + props.node.nodeSize).scrollIntoView(),
    );
  };

  return (
    <NodeViewWrapper
      as={props.node.type.name === "blockImage" ? "div" : "span"}
      ref={(element: HTMLElement | null) => {
        draggable.setNodeRef(element);
        if (element) registerBodyNodePosition(element, getPosition);
      }}
      className={`body-image body-draggable-node${draggable.isDragging ? " is-dragging" : ""}`}
      contentEditable={false}
      {...draggable.attributes}
      {...draggable.listeners}
    >
      <img src={environment.resolveSrc(src)} alt={alt} draggable={false} />
      <span className="body-image-actions">
        <ActionIcon
          className="body-image-edit"
          variant="filled"
          color="dark"
          size="lg"
          title="Edit image"
          aria-label="Edit image"
          onPointerDown={stopPointer}
          onClick={(event) => {
            event.stopPropagation();
            environment.edit({
              src,
              alt,
              update: (attributes) => props.updateAttributes(attributes),
            });
          }}
        >
          <Pencil size={20} />
        </ActionIcon>
        <ActionIcon
          className="body-image-delete"
          variant="filled"
          color="red"
          size="md"
          title="Remove image from document"
          aria-label="Remove image from document"
          onPointerDown={stopPointer}
          onClick={(event) => {
            event.stopPropagation();
            deleteImage();
          }}
        >
          <Trash2 size={16} />
        </ActionIcon>
      </span>
    </NodeViewWrapper>
  );
}

/** Tiptap's Markdown-compatible image node with editor-only hover controls. */
export const EditableImage = TiptapImage.configure({ inline: true }).extend({
  addNodeView() {
    return ReactNodeViewRenderer(EditableImageView);
  },
});

const standaloneImagePattern =
  /^!\[([^\]]*)\]\((\S+?)(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\)[ \t]*(?:\n|$)/;

/**
 * Marked emits a line containing only an image as a top-level token. Keeping
 * that token on the inline `image` type creates a schema-invalid ProseMirror
 * document, so standalone Markdown images have their own block node type.
 */
export const EditableBlockImage = TiptapImage.extend({
  name: "blockImage",
  addNodeView() {
    return ReactNodeViewRenderer(EditableImageView);
  },
  markdownTokenizer: {
    name: "blockImage",
    level: "block",
    start: (src: string) => {
      const match = /(^|\n)!\[/.exec(src);
      return match ? match.index + match[1].length : -1;
    },
    tokenize: (src: string) => {
      const match = standaloneImagePattern.exec(src);
      if (!match) return undefined;
      return {
        type: "blockImage",
        raw: match[0],
        text: match[1],
        href: match[2],
        title: match[3] ?? match[4] ?? match[5] ?? null,
      };
    },
  },
  parseMarkdown: (token, helpers) =>
    helpers.createNode("blockImage", {
      src: token.href,
      title: token.title,
      alt: token.text,
    }),
  renderMarkdown: (node) => {
    const src = String(node.attrs?.src ?? "");
    const alt = String(node.attrs?.alt ?? "");
    const title = String(node.attrs?.title ?? "");
    return title ? `![${alt}](${src} "${title}")` : `![${alt}](${src})`;
  },
});

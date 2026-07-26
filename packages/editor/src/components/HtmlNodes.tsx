import { useContext, useId } from "react";
import { Node, nodeInputRule, type InputRuleMatch } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Textarea } from "@mantine/core";
import { CodeXml } from "lucide-react";

import { BLOCK_HTML_TAGS, scanHtmlElement } from "@posto/core/mdx/mdx";
import { ComponentPopover, MdxFieldEnvContext } from "./MdxNodes";
import { registerBodyNodePosition, useBodyNodeDraggable } from "./MediaDragDrop";

/*
 * Raw HTML preservation for the body editor: elements authored as HTML
 * (`<kbd>`, `<div>`, …) survive the markdown round-trip verbatim instead of
 * being stripped. Each element renders as an "HTML" chip — same formatting as
 * component chips — whose popover edits the element's source directly.
 */

/** Chip label: the tag name when the source is exactly one element,
 * "HTML" for anything more complex (siblings, leading text, …). */
function chipLabel(source: string): string {
  const trimmed = source.trim();
  const el = scanHtmlElement(trimmed);
  return el && el.raw === trimmed ? el.name : "HTML";
}

/** Matches a complete element only after its final `>` has been entered.
 * This lets tags typed into an existing rich-text paragraph become the same
 * atomic HTML nodes as tags loaded through the Markdown parser. */
function htmlInputMatch(text: string, block: boolean, mdx: boolean): InputRuleMatch | null {
  let index = text.indexOf("<");
  while (index !== -1) {
    const source = text.slice(index);
    const element = scanHtmlElement(source);
    if (element?.raw.length === source.length) {
      // In MDX, capitalized elements retain their JSX component semantics.
      if (mdx && /^[A-Z]/.test(element.name)) return null;
      if (block !== (index === 0)) return null;
      return { index, text: source, data: { source } };
    }
    // A valid-looking opening tag before the candidate is still incomplete.
    // Do not collapse a completed child while one of its ancestors is open.
    if (/^<[A-Za-z_:][A-Za-z0-9_.:-]*(?=[\s/>])/.test(source)) return null;
    index = text.indexOf("<", index + 1);
  }
  return null;
}

function createHtmlChipView(inline: boolean) {
  return function View(props: NodeViewProps) {
    const source = String(props.node.attrs.source ?? "");
    const dragEnvironment = useContext(MdxFieldEnvContext);
    const dragId = useId();
    const label = chipLabel(source);
    const getPosition = () => {
      const position = props.getPos();
      return typeof position === "number" ? position : undefined;
    };
    const draggable = useBodyNodeDraggable({
      id: `body-node:${dragEnvironment.editorId}:${dragId}`,
      label,
      source: dragEnvironment.editorId
        ? {
            kind: "body-node",
            editorId: dragEnvironment.editorId,
            nodeType: props.node.type.name,
            getPosition,
          }
        : null,
    });
    return (
      <NodeViewWrapper
        as={inline ? "span" : "div"}
        ref={(element: HTMLElement | null) => {
          draggable.setNodeRef(element);
          if (element) registerBodyNodePosition(element, getPosition);
        }}
        className={`${inline ? "mdx-raw-inline" : "html-block"} body-draggable-node${draggable.isDragging ? " is-dragging" : ""}`}
      >
        <ComponentPopover
          name="HTML"
          target={(toggle) => (
            <button
              type="button"
              className="mdx-pill mdx-component-chip"
              title={source}
              onClick={toggle}
              {...draggable.attributes}
              {...draggable.listeners}
            >
              <CodeXml size={14} />
              <span>{label}</span>
            </button>
          )}
        >
          <Textarea
            size="xs"
            autosize
            minRows={2}
            maxRows={16}
            classNames={{ input: "mdx-children-input" }}
            value={source}
            onChange={(e) => props.updateAttributes({ source: e.currentTarget.value })}
          />
        </ComponentPopover>
      </NodeViewWrapper>
    );
  };
}

export const HtmlInline = Node.create({
  name: "htmlInline",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return { source: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "span[data-html-inline]" }];
  },
  renderHTML() {
    return ["span", { "data-html-inline": "" }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(createHtmlChipView(true));
  },
  addInputRules() {
    const mdx = this.editor.extensionManager.extensions.some(
      (extension) => extension.name === "mdxComponent",
    );
    return [
      nodeInputRule({
        find: (text) => htmlInputMatch(text, false, mdx),
        type: this.type,
        getAttributes: (match) => ({ source: match.data?.source ?? match[0] }),
      }),
    ];
  },
  markdownTokenizer: {
    name: "htmlInline",
    level: "inline",
    start: (src: string) => src.search(/<[A-Za-z_:]/),
    tokenize: (src: string) => {
      const el = scanHtmlElement(src);
      return el ? { type: "htmlInline", raw: el.raw } : undefined;
    },
  },
  parseMarkdown: (token, helpers) => helpers.createNode("htmlInline", { source: token.raw }),
  renderMarkdown: (node) => String(node.attrs?.source ?? ""),
});

export const HtmlBlock = Node.create({
  name: "htmlBlock",
  group: "block",
  atom: true,
  addAttributes() {
    return { source: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "div[data-html-block]" }];
  },
  renderHTML() {
    return ["div", { "data-html-block": "" }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(createHtmlChipView(false));
  },
  addInputRules() {
    const mdx = this.editor.extensionManager.extensions.some(
      (extension) => extension.name === "mdxComponent",
    );
    return [
      nodeInputRule({
        find: (text) => htmlInputMatch(text, true, mdx),
        type: this.type,
        getAttributes: (match) => ({ source: match.data?.source ?? match[0] }),
      }),
    ];
  },
  markdownTokenizer: {
    name: "htmlBlock",
    level: "block",
    start: (src: string) => {
      const match = /(^|\n)<[A-Za-z_:]/.exec(src);
      return match ? match.index + match[1].length : -1;
    },
    tokenize: (src: string) => {
      const el = scanHtmlElement(src);
      if (!el) return undefined;
      // Known block elements are always claimed. Any other element (`<kbd>`,
      // `<abbr>`, a deprecated `<marquee>`, …) is only a block when it stands
      // alone on its line — nothing but whitespace follows it before the line
      // ends. An inline element opening a line with trailing text
      // (`<kbd>Ctrl</kbd> + C`) stays in the paragraph for the inline
      // tokenizer; a bare `<marquee>…</marquee>` block is preserved as raw
      // HTML instead of being escaped to `&lt;marquee&gt;` on save.
      if (
        BLOCK_HTML_TAGS.has(el.name.toLowerCase()) ||
        /^[ \t\r]*(\n|$)/.test(src.slice(el.raw.length))
      ) {
        return { type: "htmlBlock", raw: el.raw };
      }
      return undefined;
    },
  },
  parseMarkdown: (token, helpers) =>
    helpers.createNode("htmlBlock", { source: (token.raw ?? "").trimEnd() }),
  renderMarkdown: (node) => String(node.attrs?.source ?? ""),
});

export const htmlNodes = [HtmlBlock, HtmlInline];

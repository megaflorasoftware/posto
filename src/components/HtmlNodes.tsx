import { Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Textarea } from "@mantine/core";
import { CodeXml } from "lucide-react";

import { BLOCK_HTML_TAGS, scanHtmlElement } from "../mdx/mdx";
import { ComponentPopover } from "./MdxNodes";

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

function HtmlChipView(inline: boolean) {
  return function View(props: NodeViewProps) {
    const source = String(props.node.attrs.source ?? "");
    return (
      <NodeViewWrapper
        as={inline ? "span" : "div"}
        className={inline ? "mdx-raw-inline" : "html-block"}
      >
        <ComponentPopover
          name="HTML"
          target={(toggle) => (
            <button
              type="button"
              className="mdx-pill mdx-component-chip"
              title={source}
              onClick={toggle}
            >
              <CodeXml size={14} />
              <span>{chipLabel(source)}</span>
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
    return ReactNodeViewRenderer(HtmlChipView(true));
  },
  markdownTokenizer: {
    name: "htmlInline",
    level: "inline",
    start: (src: string) => src.search(/<[a-z]/),
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
    return ReactNodeViewRenderer(HtmlChipView(false));
  },
  markdownTokenizer: {
    name: "htmlBlock",
    level: "block",
    start: (src: string) => {
      const match = /(^|\n)<[a-z]/.exec(src);
      return match ? match.index + match[1].length : -1;
    },
    tokenize: (src: string) => {
      const el = scanHtmlElement(src);
      // Inline-level elements opening a line (`<kbd>Ctrl</kbd> + C`) belong
      // to the paragraph; only true block elements are claimed here.
      if (!el || !BLOCK_HTML_TAGS.has(el.name)) return undefined;
      return { type: "htmlBlock", raw: el.raw };
    },
  },
  parseMarkdown: (token, helpers) =>
    helpers.createNode("htmlBlock", { source: (token.raw ?? "").trimEnd() }),
  renderMarkdown: (node) => String(node.attrs?.source ?? ""),
});

export const htmlNodes = [HtmlBlock, HtmlInline];

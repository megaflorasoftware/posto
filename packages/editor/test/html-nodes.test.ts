// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, test } from "vitest";

import { htmlNodes } from "../src/components/HtmlNodes";
import { mdxNodes } from "../src/components/MdxNodes";

function markdownEditor(content: string, mdx = false): Editor {
  return new Editor({
    extensions: [StarterKit, Markdown, ...htmlNodes, ...(mdx ? mdxNodes : [])],
    content,
    contentType: "markdown",
  });
}

function nodeSources(editor: Editor, type: "htmlBlock" | "htmlInline"): string[] {
  const sources: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === type) sources.push(String(node.attrs.source));
  });
  return sources;
}

function typeFinalAngleBracket(editor: Editor): boolean {
  const position = editor.state.selection.from;
  const handled =
    editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, position, position, ">"),
    ) === true;
  if (!handled) editor.view.dispatch(editor.state.tr.insertText(">"));
  return handled;
}

describe("arbitrary HTML and XML elements", () => {
  test.each([
    "<custom-element>content</custom-element>",
    "<namespace:element>content</namespace:element>",
    "<_private.element>content</_private.element>",
    '<custom-element data-value="1" />',
    "<CUSTOM-ELEMENT>content</CUSTOM-ELEMENT>",
  ])("preserves a standalone %s element as an editor HTML block", (source) => {
    const editor = markdownEditor(source);

    expect(nodeSources(editor, "htmlBlock")).toEqual([source]);
    expect(editor.getMarkdown()).toBe(source);

    editor.destroy();
  });

  test("preserves a custom element inline with surrounding Markdown", () => {
    const source = "Before <namespace:element>inside</namespace:element> after";
    const editor = markdownEditor(source);

    expect(nodeSources(editor, "htmlInline")).toEqual([
      "<namespace:element>inside</namespace:element>",
    ]);
    expect(editor.getMarkdown()).toBe(source);

    editor.destroy();
  });

  test("waits for the final matching close tag of nested custom elements", () => {
    const source =
      "<namespace:element><namespace:element>inside</namespace:element></namespace:element>";
    const editor = markdownEditor(source);

    expect(nodeSources(editor, "htmlBlock")).toEqual([source]);
    expect(editor.getMarkdown()).toBe(source);

    editor.destroy();
  });

  test("does not accept a parent whose nested tag is still open", () => {
    const source = "<div><h1>hey</div>";
    const editor = markdownEditor(source);

    expect(nodeSources(editor, "htmlBlock")).toEqual([]);
    expect(nodeSources(editor, "htmlInline")).toEqual([]);

    editor.destroy();
  });

  test("turns a standalone custom tag into an HTML block when its final tag closes", () => {
    const editor = markdownEditor("");
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "<namespace:element>inside</namespace:element" }],
        },
      ],
    });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);

    expect(nodeSources(editor, "htmlBlock")).toEqual([]);
    expect(typeFinalAngleBracket(editor)).toBe(true);
    expect(nodeSources(editor, "htmlBlock")).toEqual([
      "<namespace:element>inside</namespace:element>",
    ]);

    editor.destroy();
  });

  test("waits for every nested tag to close before collapsing typed HTML", () => {
    const editor = markdownEditor("");
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "<div><h1>hey</h1" }],
        },
      ],
    });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);

    expect(typeFinalAngleBracket(editor)).toBe(false);
    expect(nodeSources(editor, "htmlBlock")).toEqual([]);
    expect(nodeSources(editor, "htmlInline")).toEqual([]);
    expect(editor.state.doc.textContent).toBe("<div><h1>hey</h1>");

    editor.view.dispatch(editor.state.tr.insertText("</div"));
    expect(typeFinalAngleBracket(editor)).toBe(true);
    expect(nodeSources(editor, "htmlBlock")).toEqual(["<div><h1>hey</h1></div>"]);
    expect(nodeSources(editor, "htmlInline")).toEqual([]);

    editor.destroy();
  });

  test("turns a completed custom tag within prose into an inline HTML element", () => {
    const editor = markdownEditor("");
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Before <custom-element>inside</custom-element" }],
        },
      ],
    });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);

    expect(nodeSources(editor, "htmlInline")).toEqual([]);
    expect(typeFinalAngleBracket(editor)).toBe(true);
    expect(nodeSources(editor, "htmlInline")).toEqual(["<custom-element>inside</custom-element>"]);
    expect(editor.getMarkdown()).toBe("Before <custom-element>inside</custom-element>");

    editor.destroy();
  });

  test("keeps uppercase JSX as an MDX component when MDX support is enabled", () => {
    const source = "<CustomElement>content</CustomElement>";
    const editor = markdownEditor(source, true);
    const types: string[] = [];
    editor.state.doc.descendants((node) => types.push(node.type.name));

    expect(types).toContain("mdxComponent");
    expect(types).not.toContain("htmlBlock");
    expect(editor.getMarkdown()).toBe(source);

    editor.destroy();
  });
});

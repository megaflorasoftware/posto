// @vitest-environment jsdom

import { expect, test } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import {
  bodyNodeMoveTransaction,
  bodyEditorMode,
  imageGapLocation,
  imageMoveTransaction,
} from "../src/components/BodyEditor";
import { EditableBlockImage, EditableImage } from "../src/components/EditableImage";
import { htmlNodes } from "../src/components/HtmlNodes";
import { mdxNodes } from "../src/components/MdxNodes";
import { genericAdapter } from "@posto/core/project/generic";
import { astroAdapter } from "@posto/core/project/astro";

test("MDX preservation does not depend on component discovery", () => {
  expect(bodyEditorMode(true, genericAdapter.capabilities.componentBlocks)).toEqual({
    mdx: true,
    componentBlocksEnabled: false,
  });
  expect(bodyEditorMode(true, astroAdapter.capabilities.componentBlocks)).toEqual({
    mdx: true,
    componentBlocksEnabled: true,
  });
  expect(bodyEditorMode(false, astroAdapter.capabilities.componentBlocks)).toEqual({
    mdx: false,
    componentBlocksEnabled: true,
  });
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

test("finds the insertion boundary between adjacent images", () => {
  const inline = imageGapLocation(
    [
      { pos: 2, size: 1, rect: rect(10, 20, 80, 60) },
      { pos: 3, size: 1, rect: rect(110, 20, 80, 60) },
    ],
    { x: 100, y: 50 },
    rect(0, 0, 220, 200),
    () => true,
  );
  expect(inline).toMatchObject({ pos: 3, left: 100, orientation: "vertical" });

  const stacked = imageGapLocation(
    [
      { pos: 2, size: 1, rect: rect(10, 20, 180, 80) },
      { pos: 3, size: 1, rect: rect(10, 120, 180, 80) },
    ],
    { x: 100, y: 110 },
    rect(0, 0, 220, 240),
    () => true,
  );
  expect(stacked).toMatchObject({ pos: 3, top: 110, orientation: "horizontal" });
});

test("moves blank-line-separated Markdown images as top-level nodes", () => {
  const editor = new Editor({
    extensions: [StarterKit, Markdown, EditableBlockImage, EditableImage],
    content: [
      "![one](/one.jpg)",
      "![two](/two.jpg)",
      "![three](/three.jpg)",
      "![four](/four.jpg)",
    ].join("\n\n"),
    contentType: "markdown",
  });
  const positions = new Map<string, number>();
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "blockImage") positions.set(String(node.attrs.alt), pos);
  });
  const second = positions.get("two");
  const fourth = positions.get("four");
  expect(second).toBeTypeOf("number");
  expect(fourth).toBeTypeOf("number");
  expect(() => editor.state.doc.check()).not.toThrow();
  const transaction = imageMoveTransaction(editor.state, fourth!, {
    pos: second!,
    blockBoundary: true,
  });
  expect(transaction).not.toBeNull();
  editor.view.dispatch(transaction!);

  const markdown = editor.getMarkdown();
  expect(markdown.indexOf("![one]")).toBeLessThan(markdown.indexOf("![four]"));
  expect(markdown.indexOf("![four]")).toBeLessThan(markdown.indexOf("![two]"));
  expect(markdown.indexOf("![two]")).toBeLessThan(markdown.indexOf("![three]"));
  expect(() => editor.state.doc.check()).not.toThrow();
  const reordered: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "blockImage") reordered.push(String(node.attrs.alt));
  });
  expect(reordered).toEqual(["one", "four", "two", "three"]);
  editor.destroy();
});

test("moves block and inline MDX components without changing their source", () => {
  const extensions = [StarterKit, Markdown, ...htmlNodes, ...mdxNodes];
  const blockEditor = new Editor({
    extensions,
    content: ['<Gallery tone="warm" />', "Between", '<Callout kind="note" />'].join("\n\n"),
    contentType: "markdown",
  });
  const blockPositions = new Map<string, number>();
  blockEditor.state.doc.descendants((node, pos) => {
    if (node.type.name === "mdxComponent") blockPositions.set(String(node.attrs.name), pos);
  });
  const gallery = blockPositions.get("Gallery");
  const callout = blockPositions.get("Callout");
  expect(gallery).toBeTypeOf("number");
  expect(callout).toBeTypeOf("number");
  const blockMove = bodyNodeMoveTransaction(blockEditor.state, callout!, {
    pos: gallery!,
    blockBoundary: true,
  });
  expect(blockMove).not.toBeNull();
  blockEditor.view.dispatch(blockMove!);
  const blockMarkdown = blockEditor.getMarkdown();
  expect(blockMarkdown.indexOf('<Callout kind="note" />')).toBeLessThan(
    blockMarkdown.indexOf('<Gallery tone="warm" />'),
  );
  expect(() => blockEditor.state.doc.check()).not.toThrow();
  blockEditor.destroy();

  const inlineEditor = new Editor({
    extensions,
    content: 'Before <Badge tone="soft" /> middle <Chip size="sm" /> after',
    contentType: "markdown",
  });
  const inlinePositions = new Map<string, number>();
  inlineEditor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "mdxRawInline") return;
    const source = String(node.attrs.source);
    inlinePositions.set(source.includes("Badge") ? "Badge" : "Chip", pos);
  });
  const badge = inlinePositions.get("Badge");
  const chip = inlinePositions.get("Chip");
  expect(badge).toBeTypeOf("number");
  expect(chip).toBeTypeOf("number");
  const inlineMove = bodyNodeMoveTransaction(inlineEditor.state, chip!, {
    pos: badge!,
    blockBoundary: false,
  });
  expect(inlineMove).not.toBeNull();
  inlineEditor.view.dispatch(inlineMove!);
  const inlineMarkdown = inlineEditor.getMarkdown();
  expect(inlineMarkdown.indexOf('<Chip size="sm" />')).toBeLessThan(
    inlineMarkdown.indexOf('<Badge tone="soft" />'),
  );
  expect(() => inlineEditor.state.doc.check()).not.toThrow();
  inlineEditor.destroy();
});

test("moves custom HTML nodes with the same rich-text transaction", () => {
  const editor = new Editor({
    extensions: [StarterKit, Markdown, ...htmlNodes],
    content: ["<aside>First</aside>", "Middle", "<section>Last</section>"].join("\n\n"),
    contentType: "markdown",
  });
  const positions: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "htmlBlock") positions.push(pos);
  });
  expect(positions).toHaveLength(2);
  const transaction = bodyNodeMoveTransaction(editor.state, positions[1], {
    pos: positions[0],
    blockBoundary: true,
  });
  expect(transaction).not.toBeNull();
  editor.view.dispatch(transaction!);
  const markdown = editor.getMarkdown();
  expect(markdown.indexOf("<section>Last</section>")).toBeLessThan(
    markdown.indexOf("<aside>First</aside>"),
  );
  expect(() => editor.state.doc.check()).not.toThrow();
  editor.destroy();
});

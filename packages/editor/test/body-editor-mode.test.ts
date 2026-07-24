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
  insertMediaBatchAtLocation,
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

  const nested = imageGapLocation(
    [
      {
        pos: 1,
        size: 30,
        rect: rect(0, 0, 220, 300),
        hitRect: rect(0, 0, 220, 32),
        blockFrom: 1,
        blockTo: 31,
        parentStart: 0,
        parentDepth: 0,
      },
      {
        pos: 3,
        size: 5,
        rect: rect(20, 60, 180, 70),
        blockFrom: 3,
        blockTo: 8,
        parentStart: 2,
        parentDepth: 2,
      },
      {
        pos: 8,
        size: 5,
        rect: rect(20, 150, 180, 70),
        blockFrom: 8,
        blockTo: 13,
        parentStart: 2,
        parentDepth: 2,
      },
    ],
    { x: 110, y: 140 },
    rect(0, 0, 220, 320),
    () => true,
  );
  expect(nested).toMatchObject({ pos: 8, top: 140, orientation: "horizontal" });
});

test("inserts imported images at a captured drop position after the import completes", () => {
  const editor = new Editor({
    extensions: [StarterKit, Markdown, EditableBlockImage, EditableImage],
    content: "Before\n\nAfter",
    contentType: "markdown",
  });
  const capturedPosition = editor.state.doc.child(0).nodeSize;
  expect(editor.getMarkdown()).toBe("Before\n\nAfter");

  insertMediaBatchAtLocation(
    editor,
    [
      { outputPath: "/images/first.jpg", label: "first.jpg", alt: "First", kind: "image" },
      { outputPath: "/images/second.jpg", label: "second.jpg", alt: "Second", kind: "image" },
    ],
    { pos: capturedPosition, blockBoundary: true },
  );

  const markdown = editor.getMarkdown();
  expect(markdown.indexOf("Before")).toBeLessThan(markdown.indexOf("![First]"));
  expect(markdown.indexOf("![First]")).toBeLessThan(markdown.indexOf("![Second]"));
  expect(markdown.indexOf("![Second]")).toBeLessThan(markdown.indexOf("After"));
  expect(() => editor.state.doc.check()).not.toThrow();
  editor.destroy();
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

test("reorders components inside a component slot and persists the nested source", () => {
  const editor = new Editor({
    extensions: [StarterKit, Markdown, ...htmlNodes, ...mdxNodes],
    content: [
      "<ExperienceSection>",
      '<TimelineItem name="First">',
      "First role.",
      "</TimelineItem>",
      "",
      '<TimelineItem name="Second">',
      "Second role.",
      "</TimelineItem>",
      "</ExperienceSection>",
      "",
      "<UmamiStatCard />",
    ].join("\n"),
    contentType: "markdown",
  });
  const timelinePositions: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "mdxComponent" && node.attrs.name === "TimelineItem") {
      timelinePositions.push(pos);
      expect(editor.state.doc.resolve(pos).parent.type.name).toBe("mdxSlot");
    }
  });
  expect(timelinePositions).toHaveLength(2);
  const reorder = bodyNodeMoveTransaction(editor.state, timelinePositions[1], {
    pos: timelinePositions[0],
    blockBoundary: true,
  });
  expect(reorder).not.toBeNull();
  editor.view.dispatch(reorder!);
  const reordered = editor.getMarkdown();
  expect(reordered.indexOf('name="Second"')).toBeLessThan(reordered.indexOf('name="First"'));

  let statPosition: number | undefined;
  let firstTimelinePosition: number | undefined;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "mdxComponent") return;
    if (node.attrs.name === "UmamiStatCard") statPosition = pos;
    if (node.attrs.name === "TimelineItem" && firstTimelinePosition === undefined) {
      firstTimelinePosition = pos;
    }
  });
  const moveIntoSlot = bodyNodeMoveTransaction(editor.state, statPosition!, {
    pos: firstTimelinePosition!,
    blockBoundary: true,
  });
  expect(moveIntoSlot).not.toBeNull();
  editor.view.dispatch(moveIntoSlot!);
  const movedIntoSlot = editor.getMarkdown();
  expect(movedIntoSlot.indexOf("<UmamiStatCard />")).toBeGreaterThan(
    movedIntoSlot.indexOf("<ExperienceSection>"),
  );
  expect(movedIntoSlot.indexOf("<UmamiStatCard />")).toBeLessThan(
    movedIntoSlot.indexOf("</ExperienceSection>"),
  );
  expect(() => editor.state.doc.check()).not.toThrow();
  editor.destroy();
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

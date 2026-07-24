// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, test } from "vitest";
import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { Link } from "@mantine/tiptap";
import { htmlNodes } from "../src/components/HtmlNodes";
import { EditableImage } from "../src/components/EditableImage";
import { markdownMediaEditorContent, type MarkdownMediaPick } from "../src/markdownMedia";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const editors: Editor[] = [];

function renderPick(pick: MarkdownMediaPick): string {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ link: false, underline: false }),
      Link,
      Markdown,
      EditableImage,
      ...htmlNodes,
    ],
    content: "",
    contentType: "markdown",
  });
  editors.push(editor);
  editor.commands.insertContent(markdownMediaEditorContent(pick));
  return editor.getMarkdown();
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
});

describe("Markdown media editor output", () => {
  test("serializes images and downloads with native Markdown syntax", () => {
    expect(
      renderPick({
        outputPath: "/images/photo.jpg",
        label: "photo.jpg",
        alt: "Summer photo",
        kind: "image",
      }),
    ).toBe("![Summer photo](/images/photo.jpg)");
    expect(
      renderPick({ outputPath: "/downloads/guide.pdf", label: "guide.pdf", kind: "link" }),
    ).toBe("[guide.pdf](/downloads/guide.pdf)");
  });

  test("serializes audio and video as CommonMark raw HTML", () => {
    expect(renderPick({ outputPath: "/media/theme.mp3", label: "theme.mp3", kind: "audio" })).toBe(
      '<audio controls src="/media/theme.mp3"></audio>\n\n',
    );
    expect(
      renderPick({ outputPath: "/media/trailer.mp4", label: "trailer.mp4", kind: "video" }),
    ).toBe('<video controls src="/media/trailer.mp4"></video>\n\n');
  });
});

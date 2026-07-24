import { describe, expect, test } from "vitest";
import {
  markdownMediaEditorContent,
  markdownMediaHtml,
  markdownMediaKind,
  publicMediaOutputPath,
} from "../src/markdownMedia";

describe("Markdown media insertion", () => {
  test("uses native Markdown images and links where the spec provides them", () => {
    expect(markdownMediaKind("photo.webp")).toBe("image");
    expect(markdownMediaKind("scan.bmp")).toBe("image");
    expect(markdownMediaKind("guide.pdf")).toBe("link");
    expect(markdownMediaKind("font.woff2")).toBe("link");
    expect(
      markdownMediaEditorContent({
        outputPath: "/guide.pdf",
        label: "guide.pdf",
        kind: "link",
      }),
    ).toEqual({
      type: "text",
      text: "guide.pdf",
      marks: [{ type: "link", attrs: { href: "/guide.pdf" } }],
    });
    expect(
      markdownMediaEditorContent({
        outputPath: "/photo.webp",
        label: "photo.webp",
        kind: "image",
        alt: "A photo",
      }),
    ).toEqual({
      type: "image",
      attrs: { src: "/photo.webp", alt: "A photo" },
    });
  });

  test("uses CommonMark raw HTML for audio and video embeds", () => {
    expect(markdownMediaKind("theme.mp3")).toBe("audio");
    expect(markdownMediaKind("trailer.mp4")).toBe("video");
    expect(
      markdownMediaHtml({
        outputPath: "/media/theme.mp3",
        label: "theme.mp3",
        kind: "audio",
      }),
    ).toBe('<audio controls src="/media/theme.mp3"></audio>');
    expect(
      markdownMediaHtml({
        outputPath: "/media/trailer.mp4",
        label: "trailer.mp4",
        kind: "video",
      }),
    ).toBe('<video controls src="/media/trailer.mp4"></video>');
    expect(
      markdownMediaEditorContent({
        outputPath: "/media/trailer.mp4",
        label: "trailer.mp4",
        kind: "video",
      }),
    ).toEqual({
      type: "htmlBlock",
      attrs: { source: '<video controls src="/media/trailer.mp4"></video>' },
    });
  });

  test("creates safe site-root URLs for public files", () => {
    expect(publicMediaOutputPath("/site", "/site/public/files/Guide (final) #1.pdf")).toBe(
      "/files/Guide%20%28final%29%20%231.pdf",
    );
    expect(publicMediaOutputPath("/site", "/outside/guide.pdf")).toBeNull();
  });

  test("creates public URLs from native Windows paths", () => {
    expect(
      publicMediaOutputPath(
        "C:\\Projects\\Site",
        "C:\\Projects\\Site\\public\\files\\Guide (final) #1.pdf",
      ),
    ).toBe("/files/Guide%20%28final%29%20%231.pdf");
    expect(publicMediaOutputPath("C:\\Projects\\Site", "D:\\outside\\guide.pdf")).toBeNull();
  });

  test("matches Windows drive paths case-insensitively", () => {
    expect(
      publicMediaOutputPath("C:\\Projects\\Site", "c:\\projects\\site\\public\\hero.png"),
    ).toBe("/hero.png");
  });
});

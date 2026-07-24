import { normalizeFilePath } from "./filePaths";

export type MarkdownMediaKind = "image" | "audio" | "video" | "link";

export interface MarkdownMediaPick {
  outputPath: string;
  label: string;
  kind: MarkdownMediaKind;
  alt?: string;
}

const IMAGE_EXTENSIONS = new Set([
  "apng",
  "avif",
  "bmp",
  "gif",
  "ico",
  "jfif",
  "jpeg",
  "jpg",
  "pjp",
  "pjpeg",
  "png",
  "svg",
  "tif",
  "tiff",
  "webp",
]);
const AUDIO_EXTENSIONS = new Set(["aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav"]);
const VIDEO_EXTENSIONS = new Set(["avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ogv", "webm"]);

function extension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
}

export function markdownMediaKind(path: string): MarkdownMediaKind {
  const ext = extension(path);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return "link";
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function publicMediaOutputPath(root: string, absolutePath: string): string | null {
  const normalizedRoot = normalizeFilePath(root).replace(/\/+$/, "");
  const normalizedPath = normalizeFilePath(absolutePath);
  const prefix = `${normalizedRoot}/public/`;
  const windowsPath = /^[A-Za-z]:\//.test(normalizedRoot) || normalizedRoot.startsWith("//");
  const matches = windowsPath
    ? normalizedPath.toLowerCase().startsWith(prefix.toLowerCase())
    : normalizedPath.startsWith(prefix);
  if (!matches) return null;
  return `/${normalizedPath.slice(prefix.length).split("/").map(encodePathSegment).join("/")}`;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function markdownMediaHtml(pick: MarkdownMediaPick): string | null {
  const src = escapeHtmlAttribute(pick.outputPath);
  if (pick.kind === "audio") return `<audio controls src="${src}"></audio>`;
  if (pick.kind === "video") return `<video controls src="${src}"></video>`;
  return null;
}

export function markdownMediaEditorContent(pick: MarkdownMediaPick): Record<string, unknown> {
  if (pick.kind === "image") {
    return {
      type: "image",
      attrs: { src: pick.outputPath, alt: pick.alt ?? pick.label },
    };
  }
  const html = markdownMediaHtml(pick);
  if (html) return { type: "htmlBlock", attrs: { source: html } };
  return {
    type: "text",
    text: pick.label,
    marks: [{ type: "link", attrs: { href: pick.outputPath } }],
  };
}

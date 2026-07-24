const DROPPED_IMAGE = /\.(?:avif|gif|jpe?g|png|svg|tiff?|webp)$/i;

export function droppedImagePaths(paths: string[]): string[] {
  return paths.filter((path) => DROPPED_IMAGE.test(path));
}

interface DirectoryDropElement {
  closest: (selector: string) => { getAttribute: (name: string) => string | null } | null;
}

export interface DirectoryDropFallback {
  directory: string;
  contains: (x: number, y: number) => boolean;
}

export function droppedImageDirectory(
  paths: string[],
  pointer: { x: number; y: number } | null,
  mediaRoot: string,
  elementAtPoint: (x: number, y: number) => DirectoryDropElement | null,
  fallback?: DirectoryDropFallback,
): string | null {
  if (!pointer || droppedImagePaths(paths).length === 0) return null;
  const target = elementAtPoint(pointer.x, pointer.y)?.closest("[data-media-directory-path]");
  const directory = target?.getAttribute("data-media-directory-path");
  const root = mediaRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (directory && (directory === root || directory.startsWith(`${root}/`))) return directory;
  const fallbackDirectory = fallback?.directory.replace(/\\/g, "/").replace(/\/+$/, "");
  if (
    fallback &&
    fallbackDirectory &&
    (fallbackDirectory === root || fallbackDirectory.startsWith(`${root}/`)) &&
    fallback.contains(pointer.x, pointer.y)
  ) {
    return fallbackDirectory;
  }
  return null;
}

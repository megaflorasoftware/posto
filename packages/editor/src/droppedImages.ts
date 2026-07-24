const DROPPED_IMAGE = /\.(?:avif|gif|jpe?g|png|svg|tiff?|webp)$/i;

export function droppedImagePaths(paths: string[]): string[] {
  return paths.filter((path) => DROPPED_IMAGE.test(path));
}

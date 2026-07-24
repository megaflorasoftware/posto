export function normalizeFilePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function filePathBasename(path: string): string {
  const normalized = normalizeFilePath(path).replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function filePathDirname(path: string): string {
  const normalized = normalizeFilePath(path).replace(/\/+$/, "");
  const separator = normalized.lastIndexOf("/");
  if (separator < 0) return "";
  return normalized.slice(0, separator) || "/";
}

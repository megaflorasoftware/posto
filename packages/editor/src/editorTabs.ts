import type { FileEntry } from "@posto/ipc";
import type { ContentEntry } from "@posto/core/pagescms/config";
import { parseFile } from "@posto/core/pagescms/frontmatter";

export type EditorTab = "content" | "raw";

export function defaultEditorTabForFile(
  filePath: string,
  dataEntry?: FileEntry["dataEntry"],
): EditorTab {
  return dataEntry || /\.(md|mdx|markdown)$/i.test(filePath) ? "content" : "raw";
}

export function editorTabsForFile(input: {
  filePath: string | null;
  fileContent: string;
  entry: ContentEntry | null;
  dataEntry?: FileEntry["dataEntry"];
  developerMode?: boolean;
}): EditorTab[] {
  if (!input.filePath) return [];
  const showForm = input.entry !== null || /\.(md|mdx|markdown)$/i.test(input.filePath);
  if (!showForm) return ["raw"];
  // Raw source is normally a developer-only escape hatch, but malformed
  // frontmatter cannot be repaired through the form editor. Open only the raw
  // view in that case so every user has a recovery path.
  if (/\.(md|mdx|markdown)$/i.test(input.filePath) && parseFile(input.fileContent).error) {
    return ["raw"];
  }
  return ["content", ...(input.developerMode === true ? (["raw"] as const) : [])];
}

export function resolveEditorTab(tabs: EditorTab[], requested: EditorTab): EditorTab {
  if (tabs.includes(requested)) return requested;
  if (tabs.includes("content")) return "content";
  return tabs[0] ?? "raw";
}

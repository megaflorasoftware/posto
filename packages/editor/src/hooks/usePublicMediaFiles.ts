import { useCallback, useEffect, useState } from "react";
import { importPublicMediaFile, invoke, openFile, openFiles, type FileEntry } from "@posto/ipc";
import { markdownMediaKind } from "../markdownMedia";

const TEXT_EXTENSIONS = new Set([
  "astro",
  "bash",
  "c",
  "cjs",
  "conf",
  "config",
  "cpp",
  "cs",
  "css",
  "csv",
  "env",
  "fish",
  "go",
  "gql",
  "graphql",
  "h",
  "hpp",
  "htm",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "json5",
  "jsx",
  "kt",
  "kts",
  "less",
  "liquid",
  "lock",
  "log",
  "markdown",
  "md",
  "mdx",
  "mjs",
  "mustache",
  "njk",
  "php",
  "pug",
  "py",
  "rb",
  "rs",
  "sass",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "toml",
  "ts",
  "tsv",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

function extension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
}

export function isPublicMediaFile(path: string): boolean {
  const ext = extension(path);
  return ext !== "" && !TEXT_EXTENSIONS.has(ext);
}

export function directoriesContainingFiles(root: string, files: FileEntry[]): string[] {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const directories = new Set<string>();
  for (const file of files) {
    let directory = file.path
      .replace(/\\/g, "/")
      .slice(0, file.path.replace(/\\/g, "/").lastIndexOf("/"));
    while (directory.startsWith(`${normalizedRoot}/`)) {
      directories.add(directory);
      directory = directory.slice(0, directory.lastIndexOf("/"));
    }
  }
  return [...directories].sort();
}

function useMediaDirectoryFiles(
  directoryRoot: string,
  accepts: (path: string) => boolean,
  imageDirectoriesOnly = false,
) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [directories, setDirectories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const listed = await invoke<FileEntry[] | null>("list_dir_files_optional", {
        dir: directoryRoot,
        extensions: [],
      });
      if (listed === null) {
        setFiles([]);
        setDirectories([]);
        return;
      }
      const acceptedFiles = listed.filter((file) => accepts(file.path));
      setFiles(acceptedFiles);
      setDirectories(
        imageDirectoriesOnly
          ? directoriesContainingFiles(directoryRoot, acceptedFiles)
          : await invoke<string[]>("list_directories", { dir: directoryRoot }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [accepts, directoryRoot, imageDirectoriesOnly]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { directoryRoot, files, directories, loading, error, refresh };
}

const acceptsPublicMedia = (path: string) => isPublicMediaFile(path);
const acceptsSourceImage = (path: string) => markdownMediaKind(path) === "image";

export function usePublicMediaFiles(root: string) {
  const state = useMediaDirectoryFiles(`${root}/public`, acceptsPublicMedia);
  return { ...state, publicRoot: state.directoryRoot };
}

/** Astro source images are browsable as a generic, read-only image library.
 * Directories without an image anywhere below them are omitted. */
export function useSourceImageFiles(root: string) {
  const state = useMediaDirectoryFiles(`${root}/src`, acceptsSourceImage, true);
  return { ...state, sourceRoot: state.directoryRoot };
}

export async function chooseAndImportPublicMedia(
  repositoryRoot: string,
  directory: string,
  options: { multiple?: boolean } = {},
): Promise<string[]> {
  const selected =
    options.multiple === false
      ? [await openFile()].filter((path): path is string => path !== null)
      : await openFiles();
  const sources = selected.filter(isPublicMediaFile);
  if (selected.length > 0 && sources.length === 0) {
    throw new Error("Choose non-text media files to import into public.");
  }
  const imported: string[] = [];
  for (const sourceFilePath of sources) {
    imported.push(await importPublicMediaFile({ repositoryRoot, sourceFilePath, directory }));
  }
  return imported;
}

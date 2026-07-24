import { useCallback, useEffect, useState } from "react";
import { importPublicMediaFile, invoke, openFiles, type FileEntry } from "@posto/ipc";

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

export function usePublicMediaFiles(root: string) {
  const publicRoot = `${root}/public`;
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [directories, setDirectories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const listed = await invoke<FileEntry[] | null>("list_dir_files_optional", {
        dir: publicRoot,
        extensions: [],
      });
      if (listed === null) {
        setFiles([]);
        setDirectories([]);
        return;
      }
      const listedDirectories = await invoke<string[]>("list_directories", { dir: publicRoot });
      setFiles(listed.filter((file) => isPublicMediaFile(file.path)));
      setDirectories(listedDirectories);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [publicRoot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { publicRoot, files, directories, loading, error, refresh };
}

export async function chooseAndImportPublicMedia(
  repositoryRoot: string,
  directory: string,
): Promise<string[]> {
  const selected = await openFiles();
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

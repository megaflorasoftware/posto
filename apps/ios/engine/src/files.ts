/**
 * The repository's editable files as sidebar groups: physical directories
 * from `list_files` plus synthetic groups for Astro file-loader data
 * documents. A headless port of `useFileGroups`.
 */
import type { FileGroup } from "@posto/ipc";
import type { PagesConfig } from "@posto/core/pagescms/config";
import { scalarFrontmatter } from "@posto/core/pagescms/frontmatterScalars";
import {
  dataDocumentEntries,
  dataEntryValues,
  parseDataDocument,
} from "@posto/core/project/dataDocument";
import { invoke } from "./host";

export class FileGroups {
  private physical: FileGroup[] = [];
  private data: FileGroup[] = [];

  get groups(): FileGroup[] {
    return [...this.physical, ...this.data];
  }

  get fileCount(): number {
    return this.groups.reduce((total, group) => total + group.files.length, 0);
  }

  async refresh(dir: string): Promise<void> {
    try {
      this.physical = await invoke<FileGroup[]>("list_files", { root: dir });
    } catch (error) {
      this.physical = [];
      throw error;
    }
  }

  async refreshData(dir: string, config: PagesConfig | null, enabled: boolean): Promise<void> {
    if (!enabled) {
      this.data = [];
      return;
    }
    const loaded = await Promise.all(
      (config?.content ?? []).map(async (collection): Promise<FileGroup | null> => {
        if (!collection.dataFile) return null;
        const dataFile = collection.dataFile;
        const path = `${dir}/${dataFile.path}`;
        try {
          const parsed = parseDataDocument(
            await invoke<string>("read_text_file", { path }),
            dataFile.format,
          );
          if (parsed.error) return null;
          const files = dataDocumentEntries(parsed).flatMap((locator) => {
            const values = dataEntryValues(parsed, locator);
            if (!values) return [];
            const frontmatter: Record<string, string> = {};
            for (const [key, value] of Object.entries(values)) {
              if (
                typeof value === "string" ||
                typeof value === "number" ||
                typeof value === "boolean"
              ) {
                frontmatter[key] = String(value);
              }
            }
            return [
              {
                name: locator.id,
                path,
                key: `${path}#${collection.name}:${locator.path.join(".")}`,
                title:
                  typeof values.title === "string"
                    ? values.title
                    : typeof values.name === "string"
                      ? values.name
                      : locator.id,
                frontmatter,
                dataEntry: {
                  collection: collection.name,
                  id: locator.id,
                  path: locator.path,
                  format: dataFile.format,
                },
              },
            ];
          });
          return {
            label: collection.label ?? collection.name,
            path,
            kind: "data",
            dataCollection: collection.name,
            files,
          };
        } catch {
          // Missing/unreadable backing files do not hide ordinary file groups.
          return null;
        }
      }),
    );
    this.data = loaded.filter((group): group is FileGroup => group !== null);
  }

  /** Keeps a saved file's sidebar title and frontmatter current. */
  updateTitle(path: string, content: string): void {
    const frontmatter = /\.(md|mdx|markdown)$/i.test(path) ? scalarFrontmatter(content) : null;
    const title = frontmatter?.title ?? frontmatter?.name ?? null;
    this.physical = this.physical.map((group) =>
      group.files.some((file) => file.path === path)
        ? {
            ...group,
            files: group.files.map((file) =>
              file.path === path ? { ...file, title, frontmatter } : file,
            ),
          }
        : group,
    );
  }

  find(key: string) {
    for (const group of this.groups) {
      const file = group.files.find((candidate) => (candidate.key ?? candidate.path) === key);
      if (file) return { group, file };
    }
    return null;
  }

  hasPath(path: string): boolean {
    return this.groups.some((group) => group.files.some((file) => file.path === path));
  }
}

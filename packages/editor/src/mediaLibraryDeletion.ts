import {
  indexMdxMediaReferences,
  indexSchemaMediaReferences,
  mergeMediaReferenceIndexes,
  type MediaReferenceIndex,
} from "@posto/core/astro/mediaReferences";
import type { MediaUsage, PlannedContentEdit } from "@posto/core/astro/imageLibrary";
import { astroPropField } from "@posto/core/mdx/propFields";
import {
  extractImports,
  importInfo,
  parseAstroProps,
  parseProps,
  resolveImportPath,
  scanJsxBlock,
  serializeJsx,
} from "@posto/core/mdx/mdx";
import { deleteValue, parseFile, removeListItem, serializeFile } from "@posto/core/pagescms/frontmatter";
import { matchEntry, type PagesConfig } from "@posto/core/pagescms/config";
import { invoke, type FileGroup } from "@posto/ipc";

export interface ScannedMediaReferences extends MediaReferenceIndex {
  sources: Map<string, string>;
}

export async function scanMediaReferences(
  root: string,
  config: PagesConfig,
  groups: FileGroup[],
): Promise<ScannedMediaReferences> {
  const indexes: MediaReferenceIndex[] = [];
  const sources = new Map<string, string>();
  const files = [...new Map(groups.flatMap((group) => group.files).map((file) => [file.path, file])).values()]
    .filter((file) => /\.(?:md|mdx|markdown)$/i.test(file.path));
  for (const file of files) {
    let source: string;
    try {
      source = await invoke<string>("read_text_file", { path: file.path });
      sources.set(file.path, source);
    } catch (error) {
      indexes.push({ usages: [], complete: false, errors: [{ sourcePath: file.path, message: String(error) }] });
      continue;
    }
    const parsed = parseFile(source);
    const entry = matchEntry(config, root, file.path);
    if (entry) {
      indexes.push(indexSchemaMediaReferences({
        sourcePath: file.path,
        fields: entry.fields,
        values: (parsed.doc.toJS() as Record<string, unknown>) ?? {},
        parseError: parsed.error,
      }));
    }
    if (!file.path.toLowerCase().endsWith(".mdx")) continue;
    const components: { name: string; fields: NonNullable<ReturnType<typeof astroPropField>>[] }[] = [];
    let importsComplete = true;
    for (const statement of extractImports(parsed.body)) {
      const imported = importInfo(statement);
      if (!imported.spec?.endsWith(".astro")) continue;
      const componentPath = resolveImportPath(file.path, imported.spec);
      if (!componentPath) { importsComplete = false; continue; }
      try {
        const componentSource = await invoke<string>("read_text_file", { path: componentPath });
        const fields = parseAstroProps(componentSource).flatMap((definition) => {
          const field = astroPropField(definition, {
            collections: config.astroCollections ?? config.content,
            editableCollections: config.content,
            imageLibraries: config.imageLibraries,
          });
          return field ? [field] : [];
        });
        for (const name of imported.names) components.push({ name, fields });
      } catch (error) {
        importsComplete = false;
        indexes.push({ usages: [], complete: false, errors: [{ sourcePath: file.path, message: `Could not inspect ${componentPath}: ${String(error)}` }] });
      }
    }
    const mdx = indexMdxMediaReferences({ sourcePath: file.path, source, components });
    if (!importsComplete) mdx.complete = false;
    indexes.push(mdx);
  }
  return { ...mergeMediaReferenceIndexes(indexes), sources };
}

/** Builds exact source edits for explicitly approved optional usages. */
export function buildOptionalReferenceEdits(
  usages: MediaUsage[],
  sources: Map<string, string>,
): PlannedContentEdit[] {
  const byFile = new Map<string, MediaUsage[]>();
  for (const usage of usages) (byFile.get(usage.sourcePath) ?? (byFile.set(usage.sourcePath, []), byFile.get(usage.sourcePath)!)).push(usage);
  const edits: PlannedContentEdit[] = [];
  for (const [path, fileUsages] of byFile) {
    const originalContent = sources.get(path);
    if (originalContent === undefined) throw new Error(`Missing scanned source for ${path}`);
    let content = originalContent;
    const components = new Map<number, Set<string>>();
    for (const usage of fileUsages) if (usage.component?.offset !== undefined) {
      const props = components.get(usage.component.offset) ?? new Set<string>();
      props.add(usage.component.prop);
      components.set(usage.component.offset, props);
    }
    for (const [offset, removed] of [...components].sort(([a], [b]) => b - a)) {
      const block = scanJsxBlock(content.slice(offset));
      const props = block && parseProps(block.propsSource);
      if (!block || !props) throw new Error(`Component changed after reference scanning: ${path}`);
      const replacement = serializeJsx(block.name, props.filter((prop) => !removed.has(prop.name)), block.children);
      content = content.slice(0, offset) + replacement + content.slice(offset + block.raw.length);
    }
    const structured = fileUsages.filter((usage) => usage.valuePath);
    if (structured.length) {
      const parsed = parseFile(content);
      const paths = structured.map((usage) => usage.valuePath!).sort((a, b) => {
        const aLast = a[a.length - 1], bLast = b[b.length - 1];
        return typeof aLast === "number" && typeof bLast === "number" ? bLast - aLast : 0;
      });
      for (const valuePath of paths) {
        const last = valuePath[valuePath.length - 1];
        if (typeof last === "number") removeListItem(parsed.doc, valuePath.slice(0, -1), last);
        else deleteValue(parsed.doc, valuePath);
      }
      content = serializeFile(parsed);
    }
    if (content !== originalContent) edits.push({ path, originalContent, content });
  }
  return edits;
}

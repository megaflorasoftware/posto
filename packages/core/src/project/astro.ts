import {
  DEFAULT_ASTRO_MEDIA,
  buildAstroConfig,
  parseCollectionSchema,
  parseLoaderConfig,
  type LoaderInfo,
} from "../astro/collections";
import {
  DEFAULT_MEDIA,
  type Field,
  type PagesConfig,
  type SchemaDiagnostic,
} from "../pagescms/config";
import { scalarFrontmatter } from "../pagescms/frontmatterScalars";
import {
  componentNameFromFile,
  parseAstroExportedType,
  parseAstroProps,
  parseAstroPropsType,
  parseAstroSlots,
  relativeImportPath,
  resolveImportPath,
} from "../mdx/mdx";
import { astroPropField } from "../mdx/propFields";
import { PROJECT_MARKERS } from "./detect";
import type { ComponentRef, ProjectAdapter, ProjectIO } from "./adapter";
import { pathEntryIds } from "./entryIds";

export { DEFAULT_ASTRO_MEDIA };

const astroComponentBlocks = {
  componentDirs(root: string) {
    return [`${root}/src/components`, `${root}/components`];
  },
  async listComponents(root: string, io: ProjectIO) {
    const components: ComponentRef[] = [];
    for (const dir of this.componentDirs(root)) {
      const listed = await io.listDirFilesOptional(dir, ["astro", "tsx", "jsx", "vue", "svelte"]);
      for (const file of listed ?? []) {
        components.push({ name: componentNameFromFile(file.name), path: file.path });
      }
    }
    return components;
  },
  async componentFields(
    ref: { name: string; path: string },
    io: ProjectIO,
    config: PagesConfig = { media: [], content: [] },
  ) {
    // Astro owns schemas only for .astro components. Framework islands remain
    // available in the insertion palette without being parsed as Astro files.
    if (!ref.path.endsWith(".astro")) return null;
    const source = await io.readTextFileOptional(ref.path);
    if (source === null) {
      return {
        fields: [],
        diagnostics: [
          {
            feature: "component-blocks",
            code: "component-not-found",
            message: `Component source not found: ${ref.path}`,
          },
        ],
      };
    }
    const importedTypes: Record<string, string> = {};
    const imports = /import\s+(type\s+)?\{([\s\S]*?)\}\s+from\s+["']([^"']+)["']/g;
    for (const statement of source.matchAll(imports)) {
      const typeOnly = statement[1] !== undefined;
      const spec = statement[3];
      if (!spec.startsWith(".") || !/\.(?:astro|tsx?|jsx?)$/.test(spec)) continue;
      const importedPath = resolveImportPath(ref.path, spec);
      if (!importedPath) continue;
      const importedSource = await io.readTextFileOptional(importedPath);
      if (importedSource === null) continue;
      for (const raw of statement[2].split(",")) {
        const member = raw.trim();
        const explicitlyType = member.startsWith("type ");
        if (!typeOnly && !explicitlyType) continue;
        const match = /^(?:type\s+)?(\w+)(?:\s+as\s+(\w+))?$/.exec(member);
        if (!match) continue;
        const type = parseAstroExportedType(importedSource, match[1]);
        if (type) importedTypes[match[2] ?? match[1]] = type;
      }
    }
    const typeContext = {
      collections: config.collectionSchemas ?? config.content,
      editableCollections: config.content,
      mediaLibraries: config.mediaLibraries,
    };
    const definitions = parseAstroProps(source, importedTypes);
    const fields: Field[] = definitions.map((definition) => {
      const field = astroPropField(definition, typeContext);
      return field
        ? {
            ...field,
            options: { ...field.options, mdxDeclaredType: definition.type },
          }
        : {
            name: definition.name,
            type: "text",
            required: !definition.optional,
            options: { mdxRawType: definition.type, mdxDeclaredType: definition.type },
          };
    });
    const propsType = parseAstroPropsType(source, importedTypes);
    if (propsType) {
      const field = astroPropField(
        { name: "Props", type: propsType, optional: false },
        typeContext,
      );
      for (const nested of field?.type === "object" ? (field.fields ?? []) : []) {
        if (!fields.some((candidate) => candidate.name === nested.name)) fields.push(nested);
      }
    }
    const slots = parseAstroSlots(source);
    return {
      fields,
      diagnostics: [],
      slots: slots.named,
      hasDefaultSlot: slots.hasDefault,
    };
  },
  importFor(ref: { name: string; path: string }, documentPath: string) {
    return `import ${ref.name} from '${relativeImportPath(documentPath, ref.path)}';`;
  },
};

export async function loadAstroDerivedConfig(root: string, io: ProjectIO) {
  const listed = await io.listDirFilesOptional(`${root}/.astro/collections`, ["json"]);
  if (listed === null) return null;
  const collections: { name: string; fields: Field[] }[] = [];
  for (const file of listed) {
    if (!file.name.endsWith(".schema.json")) continue;
    const source = await io.readTextFileOptional(file.path);
    if (source === null) continue;
    const fields = parseCollectionSchema(file.name.slice(0, -".schema.json".length), source);
    if (fields?.length)
      collections.push({ name: file.name.slice(0, -".schema.json".length), fields });
  }
  if (collections.length === 0) return null;
  let loaders = new Map<string, LoaderInfo>();
  let scannerDiagnostics: SchemaDiagnostic[] = [];
  for (const path of ["src/content.config.ts", "src/content/config.ts"]) {
    const source = await io.readTextFileOptional(`${root}/${path}`);
    if (source === null) continue;
    ({ loaders, diagnostics: scannerDiagnostics } = parseLoaderConfig(source));
    break;
  }
  const config = buildAstroConfig(collections, loaders, scannerDiagnostics);
  return {
    config,
    diagnostics: config.diagnostics ?? [],
  };
}

const SITE_FIELD = /(?:^|[\s,{(])site\s*:\s*(['"`])([^'"`]+)\1/m;

export const astroAdapter: ProjectAdapter = {
  type: "astro",
  defaultMedia: DEFAULT_MEDIA,
  loadDerivedConfig: loadAstroDerivedConfig,
  invalidations(root, config) {
    return [
      {
        paths: [
          { prefix: `${root}/.astro/collections/` },
          { exact: `${root}/src/content.config.ts` },
          { exact: `${root}/src/content/config.ts` },
        ],
        refresh: "derivedConfig",
      },
      { paths: [{ prefix: `${root}/src/components/` }], refresh: "componentSchemas" },
      ...PROJECT_MARKERS.map((path) => ({
        paths: [{ exact: `${root}/${path}` }],
        refresh: "projectType" as const,
      })),
      ...(config?.mediaLibraries ?? []).map((library) => ({
        paths: [{ prefix: `${root}/${library.base}/` }],
        refresh: "mediaLibraries" as const,
      })),
      ...(config?.content
        .filter((entry) => entry.dataFile)
        .map((entry) => ({
          paths: [{ exact: `${root}/${entry.dataFile!.path}` }],
          refresh: "dataDocuments" as const,
        })) ?? []),
    ];
  },
  routeForFile(_root, path, content) {
    const marker = "/src/pages/";
    const idx = path.indexOf(marker);
    if (idx !== -1) {
      let rel = path.slice(idx + marker.length).replace(/\.[^/.]+$/, "");
      if (rel.includes("[")) return null;
      if (rel === "index" || rel.endsWith("/index")) rel = rel.slice(0, -"index".length);
      const route = `/${rel}`;
      return {
        route: route.length > 1 && route.endsWith("/") ? route.slice(0, -1) : route,
        certain: true,
      };
    }
    const collection = path.match(/\/src\/(?:content\/)?([^/]+)\/([^/]+)\.(?:md|mdx|markdown)$/);
    if (!collection) return null;
    const [, name, file] = collection;
    if (["pages", "components", "layouts", "assets", "styles", "content"].includes(name)) {
      return null;
    }
    return { route: `/${name}/${scalarFrontmatter(content)?.slug ?? file}`, certain: false };
  },
  siteUrlSources(root) {
    return ["mjs", "ts", "js", "mts", "cjs"].map((extension) => ({
      path: `${root}/astro.config.${extension}`,
      extract(source: string) {
        return source.match(SITE_FIELD)?.[2] ?? null;
      },
    }));
  },
  watchIgnores() {
    return [{ prefix: ".astro/", exceptPrefixes: [".astro/collections/"] }];
  },
  capabilities: {
    mediaLibraries: true,
    dataDocuments: true,
    componentBlocks: astroComponentBlocks,
    entryIds: pathEntryIds,
  },
};

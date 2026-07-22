import {
  DEFAULT_ASTRO_MEDIA,
  buildAstroConfig,
  parseCollectionSchema,
  parseLoaderConfig,
  type LoaderInfo,
} from "../astro/collections";
import type { Field, SchemaDiagnostic } from "../pagescms/config";
import { scalarFrontmatter } from "../pagescms/frontmatterScalars";
import { PROJECT_MARKERS } from "./detect";
import type { ProjectAdapter, ProjectDiagnostic, ProjectIO } from "./adapter";

export { DEFAULT_ASTRO_MEDIA };

const astroComponentBlocks = {
  componentDirs(root: string) {
    return [`${root}/src/components`];
  },
  async listComponents() {
    return [];
  },
  async componentFields() {
    return { fields: [], diagnostics: [] };
  },
  importFor(ref: { name: string; path: string }, documentPath: string) {
    const from = documentPath.slice(0, documentPath.lastIndexOf("/"));
    const relative = ref.path.startsWith(`${from}/`)
      ? `./${ref.path.slice(from.length + 1)}`
      : ref.path;
    return `import ${ref.name} from '${relative}';`;
  },
};

function scannerDiagnostic(value: SchemaDiagnostic): ProjectDiagnostic {
  return { feature: "derived-config", ...value };
}

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
    diagnostics: [...scannerDiagnostics.map(scannerDiagnostic), ...(config.diagnostics ?? [])],
  };
}

const SITE_FIELD = /(?:^|[\s,{(])site\s*:\s*(['"`])([^'"`]+)\1/m;

export const astroAdapter: ProjectAdapter = {
  type: "astro",
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
    entryIds: "framework",
  },
};

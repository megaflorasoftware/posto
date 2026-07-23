import { parsePostoIndex } from "../posto/config";

export const PROJECT_TYPES = ["astro", "eleventy", "hugo", "generic"] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export interface ProjectInfo {
  type: ProjectType;
  signals: string[];
  hasPagesYml: boolean;
  hasPostoDir: boolean;
  diagnostic?: string;
}

/** The deliberately small, read-only surface needed for project detection. */
export interface DetectionIO {
  pathExists(path: string, kind?: "file" | "directory"): Promise<boolean>;
  readTextFileOptional(path: string): Promise<string | null>;
}

const ASTRO_CONFIGS = [
  "astro.config.mjs",
  "astro.config.ts",
  "astro.config.js",
  "astro.config.mts",
  "astro.config.cjs",
];
const ELEVENTY_CONFIGS = [
  ".eleventy.js",
  "eleventy.config.js",
  "eleventy.config.cjs",
  "eleventy.config.mjs",
];
const HUGO_CONFIGS = ["hugo.toml", "hugo.yaml", "hugo.json"];
const GENERIC_HUGO_CONFIGS = ["config.toml", "config.yaml", "config.json"];

export const PROJECT_MARKERS = [
  ...ASTRO_CONFIGS,
  ...ELEVENTY_CONFIGS,
  ...HUGO_CONFIGS,
  ...GENERIC_HUGO_CONFIGS,
  "package.json",
  ".posto/index.json",
] as const;

function join(root: string, path: string): string {
  return `${root.replace(/\/$/, "")}/${path}`;
}

async function firstExisting(root: string, names: readonly string[], io: DetectionIO) {
  for (const name of names) {
    if (await io.pathExists(join(root, name), "file")) return name;
  }
  return null;
}

function dependencies(source: string | null): Set<string> {
  if (!source) return new Set();
  try {
    const parsed = JSON.parse(source) as Record<string, unknown>;
    const names = new Set<string>();
    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
      const group = parsed[key];
      if (!group || typeof group !== "object" || Array.isArray(group)) continue;
      for (const name of Object.keys(group)) names.add(name);
    }
    return names;
  } catch {
    return new Set();
  }
}

/** Classifies one selected working directory. Rules are ordered by precedence. */
export async function detectProject(root: string, io: DetectionIO): Promise<ProjectInfo> {
  const [
    hasPagesYml,
    postoSource,
    packageSource,
    astroConfig,
    eleventyConfig,
    hugoConfig,
    genericHugoConfig,
    hasAstroDir,
    hasContentDir,
    hasArchetypesDir,
  ] = await Promise.all([
    io.pathExists(join(root, ".pages.yml"), "file"),
    io.readTextFileOptional(join(root, ".posto/index.json")),
    io.readTextFileOptional(join(root, "package.json")),
    firstExisting(root, ASTRO_CONFIGS, io),
    firstExisting(root, ELEVENTY_CONFIGS, io),
    firstExisting(root, HUGO_CONFIGS, io),
    firstExisting(root, GENERIC_HUGO_CONFIGS, io),
    io.pathExists(join(root, ".astro"), "directory"),
    io.pathExists(join(root, "content"), "directory"),
    io.pathExists(join(root, "archetypes"), "directory"),
  ]);
  const deps = dependencies(packageSource);
  const override = postoSource ? parsePostoIndex(postoSource).project : undefined;
  return projectInfoFromMarkers([
    ...(hasPagesYml ? [".pages.yml"] : []),
    ...(postoSource !== null ? [".posto/index.json"] : []),
    ...(override ? [`project:${override}`] : []),
    ...(astroConfig ? [astroConfig] : []),
    ...(deps.has("astro") ? ["dependency:astro"] : []),
    ...(hasAstroDir ? [".astro"] : []),
    ...(eleventyConfig ? [eleventyConfig] : []),
    ...(deps.has("@11ty/eleventy") ? ["dependency:@11ty/eleventy"] : []),
    ...(hugoConfig ? [hugoConfig] : []),
    ...(genericHugoConfig ? [genericHugoConfig] : []),
    ...(hasContentDir ? ["content"] : []),
    ...(hasArchetypesDir ? ["archetypes"] : []),
  ]);
}

/** Classifies evidence returned by the bounded Rust workspace inventory. */
export function projectInfoFromMarkers(markers: string[]): ProjectInfo {
  const markerSet = new Set(markers);
  const override = markers
    .find((marker) => marker.startsWith("project:"))
    ?.slice("project:".length);
  const hasPagesYml = markerSet.has(".pages.yml");
  const hasPostoDir = markerSet.has(".posto/index.json");
  if (override) {
    const supported = PROJECT_TYPES.includes(override as ProjectType);
    return {
      type: supported ? (override as ProjectType) : "generic",
      signals: ["overridden via .posto"],
      hasPagesYml,
      hasPostoDir,
      ...(!supported
        ? {
            diagnostic: `project type '${override}' is not supported by this version; treating as generic`,
          }
        : {}),
    };
  }
  const astro = [...ASTRO_CONFIGS].find((marker) => markerSet.has(marker));
  if (astro || markerSet.has("dependency:astro") || markerSet.has(".astro")) {
    return {
      type: "astro",
      signals: [
        ...(astro ? [astro] : []),
        ...(markerSet.has("dependency:astro") ? ["astro dependency"] : []),
        ...(markerSet.has(".astro") ? [".astro directory"] : []),
      ],
      hasPagesYml,
      hasPostoDir,
    };
  }
  const eleventy = [...ELEVENTY_CONFIGS].find((marker) => markerSet.has(marker));
  if (eleventy || markerSet.has("dependency:@11ty/eleventy")) {
    return {
      type: "eleventy",
      signals: [
        ...(eleventy ? [eleventy] : []),
        ...(markerSet.has("dependency:@11ty/eleventy") ? ["@11ty/eleventy dependency"] : []),
      ],
      hasPagesYml,
      hasPostoDir,
    };
  }
  const hugo = [...HUGO_CONFIGS].find((marker) => markerSet.has(marker));
  const genericHugo = [...GENERIC_HUGO_CONFIGS].find((marker) => markerSet.has(marker));
  const hugoLayout = !!genericHugo && (markerSet.has("content") || markerSet.has("archetypes"));
  if (hugo || hugoLayout) {
    return {
      type: "hugo",
      signals: [hugo ?? genericHugo!, hugoLayout ? "Hugo content layout" : "Hugo config"],
      hasPagesYml,
      hasPostoDir,
    };
  }
  return { type: "generic", signals: [], hasPagesYml, hasPostoDir };
}

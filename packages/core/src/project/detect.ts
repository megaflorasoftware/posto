import { parsePostoIndex } from "../posto/config";
import { projectTypeImplemented } from "./support";

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

export type ProjectMarkerKind = "file" | "directory";
type ProjectEvidence =
  | "astro-config"
  | "astro-state"
  | "eleventy-config"
  | "hugo-config"
  | "hugo-generic-config"
  | "hugo-layout"
  | "manifest"
  | "pages"
  | "posto"
  | "posto-index";

/** Canonical detection inputs, shared with adapter invalidation rules. */
export const PROJECT_MARKERS: readonly {
  path: string;
  kind: ProjectMarkerKind;
  evidence: ProjectEvidence;
}[] = [
  ...[
    "astro.config.mjs",
    "astro.config.ts",
    "astro.config.js",
    "astro.config.mts",
    "astro.config.cjs",
  ].map((path) => ({ path, kind: "file" as const, evidence: "astro-config" as const })),
  ...[".eleventy.js", "eleventy.config.js", "eleventy.config.cjs", "eleventy.config.mjs"].map(
    (path) => ({ path, kind: "file" as const, evidence: "eleventy-config" as const }),
  ),
  ...["hugo.toml", "hugo.yaml", "hugo.json"].map((path) => ({
    path,
    kind: "file" as const,
    evidence: "hugo-config" as const,
  })),
  ...["config.toml", "config.yaml", "config.json"].map((path) => ({
    path,
    kind: "file" as const,
    evidence: "hugo-generic-config" as const,
  })),
  { path: "package.json", kind: "file", evidence: "manifest" },
  { path: ".pages.yml", kind: "file", evidence: "pages" },
  { path: ".posto", kind: "directory", evidence: "posto" },
  { path: ".posto/index.json", kind: "file", evidence: "posto-index" },
  { path: ".astro", kind: "directory", evidence: "astro-state" },
  { path: "content", kind: "directory", evidence: "hugo-layout" },
  { path: "archetypes", kind: "directory", evidence: "hugo-layout" },
] as const;

function evidencePaths(evidence: ProjectEvidence): string[] {
  return PROJECT_MARKERS.filter((marker) => marker.evidence === evidence).map(
    (marker) => marker.path,
  );
}

const ASTRO_CONFIGS = evidencePaths("astro-config");
const ELEVENTY_CONFIGS = evidencePaths("eleventy-config");
const HUGO_CONFIGS = evidencePaths("hugo-config");
const GENERIC_HUGO_CONFIGS = evidencePaths("hugo-generic-config");
const markerPath = (evidence: ProjectEvidence) => evidencePaths(evidence)[0];

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
    io.pathExists(join(root, markerPath("pages")), "file"),
    io.readTextFileOptional(join(root, markerPath("posto-index"))),
    io.readTextFileOptional(join(root, markerPath("manifest"))),
    firstExisting(root, ASTRO_CONFIGS, io),
    firstExisting(root, ELEVENTY_CONFIGS, io),
    firstExisting(root, HUGO_CONFIGS, io),
    firstExisting(root, GENERIC_HUGO_CONFIGS, io),
    io.pathExists(join(root, markerPath("astro-state")), "directory"),
    io.pathExists(join(root, evidencePaths("hugo-layout")[0]), "directory"),
    io.pathExists(join(root, evidencePaths("hugo-layout")[1]), "directory"),
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
    const recognized = PROJECT_TYPES.includes(override as ProjectType);
    const type = recognized ? (override as ProjectType) : "generic";
    return {
      type,
      signals: ["overridden via .posto"],
      hasPagesYml,
      hasPostoDir,
      ...(!recognized
        ? {
            diagnostic: `project type '${override}' is not supported by this version; treating as generic`,
          }
        : !projectTypeImplemented(type)
          ? {
              diagnostic: `project type '${type}' is recognized but not implemented by this version; using generic behavior`,
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
      diagnostic:
        "project type 'hugo' is recognized but not implemented by this version; using generic behavior",
    };
  }
  return { type: "generic", signals: [], hasPagesYml, hasPostoDir };
}

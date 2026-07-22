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

function overrideFrom(source: string | null): string | null {
  if (!source) return null;
  try {
    const project = (JSON.parse(source) as { project?: unknown }).project;
    return typeof project === "string" && project.trim() ? project.trim() : null;
  } catch {
    return null;
  }
}

/** Classifies one selected working directory. Rules are ordered by precedence. */
export async function detectProject(root: string, io: DetectionIO): Promise<ProjectInfo> {
  const [hasPagesYml, hasPostoDir, overrideSource] = await Promise.all([
    io.pathExists(join(root, ".pages.yml"), "file"),
    io.pathExists(join(root, ".posto"), "directory"),
    io.readTextFileOptional(join(root, ".posto/index.json")),
  ]);
  const override = overrideFrom(overrideSource);
  if (override) {
    const supported = PROJECT_TYPES.includes(override as ProjectType) && override !== "hugo";
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

  const packageSource = await io.readTextFileOptional(join(root, "package.json"));
  const deps = dependencies(packageSource);
  const astroConfig = await firstExisting(root, ASTRO_CONFIGS, io);
  if (
    astroConfig ||
    deps.has("astro") ||
    (await io.pathExists(join(root, ".astro"), "directory"))
  ) {
    return {
      type: "astro",
      signals: [
        ...(astroConfig ? [astroConfig] : []),
        ...(deps.has("astro") ? ["astro dependency"] : []),
        ...((await io.pathExists(join(root, ".astro"), "directory")) ? [".astro directory"] : []),
      ],
      hasPagesYml,
      hasPostoDir,
    };
  }

  const eleventyConfig = await firstExisting(root, ELEVENTY_CONFIGS, io);
  if (eleventyConfig || deps.has("@11ty/eleventy")) {
    return {
      type: "eleventy",
      signals: [
        ...(eleventyConfig ? [eleventyConfig] : []),
        ...(deps.has("@11ty/eleventy") ? ["@11ty/eleventy dependency"] : []),
      ],
      hasPagesYml,
      hasPostoDir,
    };
  }

  const hugoConfig = await firstExisting(root, HUGO_CONFIGS, io);
  const genericHugoConfig = await firstExisting(root, GENERIC_HUGO_CONFIGS, io);
  const hugoLayout =
    !!genericHugoConfig &&
    ((await io.pathExists(join(root, "content"), "directory")) ||
      (await io.pathExists(join(root, "archetypes"), "directory")));
  if (hugoConfig || hugoLayout) {
    return {
      type: "hugo",
      signals: [
        hugoConfig ?? genericHugoConfig!,
        hugoLayout ? "Hugo content layout" : "Hugo config",
      ],
      hasPagesYml,
      hasPostoDir,
    };
  }

  return { type: "generic", signals: [], hasPagesYml, hasPostoDir };
}

import { useMemo, useRef, useState } from "react";
import { invoke } from "@posto/ipc";
import { parsePagesConfig, type Field, type PagesConfig } from "@posto/core/pagescms/config";
import {
  DEFAULT_ASTRO_MEDIA,
  buildAstroConfig,
  parseCollectionSchema,
  parseLoaderConfig,
  type LoaderInfo,
} from "@posto/core/astro/collections";
import {
  POSTO_COLLECTIONS_DIR,
  POSTO_INDEX_PATH,
  mergePostoConfig,
  parsePostoCollection,
  parsePostoIndex,
  type PostoConfig,
} from "@posto/core/posto/config";

function effectiveConfig(
  pagesConfig: PagesConfig | null,
  astroConfig: PagesConfig | null,
  postoConfig: PostoConfig | null,
): PagesConfig {
  return mergePostoConfig(
    {
      media: pagesConfig?.media.length
        ? pagesConfig.media
        : (astroConfig?.media.length ? astroConfig.media : DEFAULT_ASTRO_MEDIA),
      content: [...(pagesConfig?.content ?? []), ...(astroConfig?.content ?? [])],
      astroCollections: astroConfig?.astroCollections,
      imageLibraries: astroConfig?.imageLibraries,
      imageLibraryDiagnostics: astroConfig?.imageLibraryDiagnostics,
    },
    postoConfig,
  );
}

/** Schema sources for form editing: `.pages.yml` plus Astro collection
 * schemas as a fallback, merged into one effective config. */
export function useSchemas() {
  const [pagesConfig, setPagesConfig] = useState<PagesConfig | null>(null);
  // Fallback schemas derived from Astro content collections; `.pages.yml`
  // entries take precedence when both describe a folder.
  const [astroConfig, setAstroConfig] = useState<PagesConfig | null>(null);
  // `.posto/` user preferences, overlaid on the effective config below.
  const [postoConfig, setPostoConfig] = useState<PostoConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  async function loadPagesConfig(dir: string): Promise<PagesConfig | null> {
    setPagesConfig(null);
    setConfigError(null);
    let source: string;
    try {
      source = await invoke<string>("read_text_file", { path: dir + "/.pages.yml" });
    } catch {
      return null; // no config file — form editing simply isn't offered
    }
    try {
      const parsed = parsePagesConfig(source);
      setPagesConfig(parsed);
      return parsed;
    } catch (e) {
      setConfigError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  // `.posto/` holds user preferences layered over the derived config:
  // `index.json` for workspace settings and `collections/<name>.json` per
  // collection. Every read is tolerant — a missing directory or malformed
  // file degrades to defaults, never to an error.
  async function loadPostoConfig(dir: string): Promise<PostoConfig | null> {
    setPostoConfig(null);
    const config: PostoConfig = { collections: {} };
    try {
      const index = await invoke<string>("read_text_file", { path: `${dir}/${POSTO_INDEX_PATH}` });
      config.collectionOrder = parsePostoIndex(index).collectionOrder;
    } catch {
      // No index file; per-collection settings may still exist.
    }
    let listed: { name: string; path: string }[] = [];
    try {
      listed = await invoke<{ name: string; path: string }[]>("list_dir_files", {
        dir: `${dir}/${POSTO_COLLECTIONS_DIR}`,
        extensions: ["json"],
      });
    } catch {
      // No collections directory.
    }
    for (const file of listed) {
      if (!file.name.endsWith(".json")) continue;
      try {
        const settings = parsePostoCollection(
          await invoke<string>("read_text_file", { path: file.path }),
        );
        if (settings) config.collections[file.name.slice(0, -".json".length)] = settings;
      } catch {
        // One unreadable file shouldn't take down the rest.
      }
    }
    if (config.collectionOrder || Object.keys(config.collections).length > 0) {
      setPostoConfig(config);
      return config;
    }
    return null;
  }

  // Astro projects generate a JSON Schema per content collection under
  // `.astro/collections/` (kept fresh by the dev server posto runs). Those
  // become fallback form schemas for folders `.pages.yml` doesn't cover.
  async function loadAstroConfig(dir: string): Promise<PagesConfig | null> {
    setAstroConfig(null);
    let listed: { name: string; path: string }[];
    try {
      listed = await invoke<{ name: string; path: string }[]>("list_dir_files", {
        dir: dir + "/.astro/collections",
        extensions: ["json"],
      });
    } catch {
      return null; // not an Astro project, or `astro sync` hasn't run yet
    }
    const collections: { name: string; fields: Field[] }[] = [];
    for (const file of listed) {
      if (!file.name.endsWith(".schema.json")) continue;
      const name = file.name.slice(0, -".schema.json".length);
      try {
        const fields = parseCollectionSchema(name, await invoke<string>("read_text_file", { path: file.path }));
        if (fields && fields.length > 0) collections.push({ name, fields });
      } catch {
        // One unreadable schema shouldn't take down the rest.
      }
    }
    if (collections.length === 0) return null;
    let loaders = new Map<string, LoaderInfo>();
    for (const configPath of ["/src/content.config.ts", "/src/content/config.ts"]) {
      try {
        loaders = parseLoaderConfig(await invoke<string>("read_text_file", { path: dir + configPath }));
        break;
      } catch {
        // Missing config file — the src/content/<name> convention applies.
      }
    }
    const parsed = buildAstroConfig(collections, loaders);
    setAstroConfig(parsed);
    return parsed;
  }

  /** Reloads every repository-owned schema/config source and returns the
   * effective result immediately. Callers that must rebuild derived file
   * groups should use this result rather than waiting for React state to
   * commit and then reading configRef. */
  async function loadSchemas(dir: string): Promise<PagesConfig> {
    const [pages, astro, posto] = await Promise.all([
      loadPagesConfig(dir),
      loadAstroConfig(dir),
      loadPostoConfig(dir),
    ]);
    return effectiveConfig(pages, astro, posto);
  }

  // Effective schema config: `.pages.yml` entries first (higher resolution —
  // labels, media, widget types), Astro collection schemas after them as a
  // fallback. matchEntry's first-match-wins ordering makes the precedence.
  const config = useMemo(
    () => effectiveConfig(pagesConfig, astroConfig, postoConfig),
    [pagesConfig, astroConfig, postoConfig],
  );
  const configRef = useRef(config);
  configRef.current = config;

  return {
    config,
    configRef,
    pagesConfig,
    astroConfig,
    configError,
    loadPagesConfig,
    loadAstroConfig,
    loadPostoConfig,
    loadSchemas,
  };
}

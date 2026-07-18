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

  async function loadPagesConfig(dir: string) {
    setPagesConfig(null);
    setConfigError(null);
    let source: string;
    try {
      source = await invoke<string>("read_text_file", { path: dir + "/.pages.yml" });
    } catch {
      return; // no config file — form editing simply isn't offered
    }
    try {
      setPagesConfig(parsePagesConfig(source));
    } catch (e) {
      setConfigError(e instanceof Error ? e.message : String(e));
    }
  }

  // `.posto/` holds user preferences layered over the derived config:
  // `index.json` for workspace settings and `collections/<name>.json` per
  // collection. Every read is tolerant — a missing directory or malformed
  // file degrades to defaults, never to an error.
  async function loadPostoConfig(dir: string) {
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
    }
  }

  // Astro projects generate a JSON Schema per content collection under
  // `.astro/collections/` (kept fresh by the dev server posto runs). Those
  // become fallback form schemas for folders `.pages.yml` doesn't cover.
  async function loadAstroConfig(dir: string) {
    setAstroConfig(null);
    let listed: { name: string; path: string }[];
    try {
      listed = await invoke<{ name: string; path: string }[]>("list_dir_files", {
        dir: dir + "/.astro/collections",
        extensions: ["json"],
      });
    } catch {
      return; // not an Astro project, or `astro sync` hasn't run yet
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
    if (collections.length === 0) return;
    let loaders = new Map<string, LoaderInfo>();
    for (const configPath of ["/src/content.config.ts", "/src/content/config.ts"]) {
      try {
        loaders = parseLoaderConfig(await invoke<string>("read_text_file", { path: dir + configPath }));
        break;
      } catch {
        // Missing config file — the src/content/<name> convention applies.
      }
    }
    setAstroConfig(buildAstroConfig(collections, loaders));
  }

  // Effective schema config: `.pages.yml` entries first (higher resolution —
  // labels, media, widget types), Astro collection schemas after them as a
  // fallback. matchEntry's first-match-wins ordering makes the precedence.
  const config = useMemo<PagesConfig | null>(() => {
    return mergePostoConfig(
      {
        media: pagesConfig?.media.length
          ? pagesConfig.media
          : (astroConfig?.media.length ? astroConfig.media : DEFAULT_ASTRO_MEDIA),
        content: [...(pagesConfig?.content ?? []), ...(astroConfig?.content ?? [])],
      },
      postoConfig,
    );
  }, [pagesConfig, astroConfig, postoConfig]);
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
  };
}

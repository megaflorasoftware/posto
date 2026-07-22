import { useMemo, useRef, useState } from "react";
import { invoke } from "@posto/ipc";
import {
  parsePagesConfig,
  type Field,
  type PagesConfig,
  type SchemaDiagnostic,
} from "@posto/core/pagescms/config";
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
        : astroConfig?.media.length
          ? astroConfig.media
          : DEFAULT_ASTRO_MEDIA,
      content: [...(pagesConfig?.content ?? []), ...(astroConfig?.content ?? [])],
      astroCollections: astroConfig?.astroCollections,
      imageLibraries: astroConfig?.imageLibraries,
      imageLibraryDiagnostics: astroConfig?.imageLibraryDiagnostics,
      schemaDiagnostics: astroConfig?.schemaDiagnostics,
    },
    postoConfig,
  );
}

/** Schema sources for form editing: `.pages.yml` plus Astro collection
 * schemas as a fallback, merged into one effective config. */
export function useSchemas() {
  const [pagesConfig, setPagesConfig] = useState<PagesConfig | null>(null);
  const pagesConfigRef = useRef<PagesConfig | null>(null);
  // Fallback schemas derived from Astro content collections; `.pages.yml`
  // entries take precedence when both describe a folder.
  const [astroConfig, setAstroConfig] = useState<PagesConfig | null>(null);
  const astroConfigRef = useRef<PagesConfig | null>(null);
  // `.posto/` user preferences, overlaid on the effective config below.
  const [postoConfig, setPostoConfig] = useState<PostoConfig | null>(null);
  const postoConfigRef = useRef<PostoConfig | null>(null);
  const [configErrors, setConfigErrors] = useState<Partial<Record<"pages" | "astro" | "posto", string>>>(
    {},
  );

  function setSourceError(source: "pages" | "astro" | "posto", message: string | null) {
    setConfigErrors((current) => {
      const next = { ...current };
      if (message) next[source] = message;
      else delete next[source];
      return next;
    });
  }

  function commitPagesConfig(config: PagesConfig | null) {
    pagesConfigRef.current = config;
    setPagesConfig(config);
  }

  function commitAstroConfig(config: PagesConfig | null) {
    astroConfigRef.current = config;
    setAstroConfig(config);
  }

  function commitPostoConfig(config: PostoConfig | null) {
    postoConfigRef.current = config;
    setPostoConfig(config);
  }

  async function loadPagesConfig(dir: string): Promise<PagesConfig | null> {
    setSourceError("pages", null);
    let source: string | null;
    try {
      source = await invoke<string | null>("read_text_file_optional", {
        path: dir + "/.pages.yml",
      });
    } catch (e) {
      setSourceError("pages", e instanceof Error ? e.message : String(e));
      return pagesConfigRef.current;
    }
    if (source === null) {
      commitPagesConfig(null);
      return null; // no config file — form editing simply isn't offered
    }
    try {
      const parsed = parsePagesConfig(source);
      commitPagesConfig(parsed);
      return parsed;
    } catch (e) {
      setSourceError("pages", e instanceof Error ? e.message : String(e));
      return pagesConfigRef.current;
    }
  }

  // `.posto/` holds user preferences layered over the derived config:
  // `index.json` for workspace settings and `collections/<name>.json` per
  // collection. Every read is tolerant — a missing directory or malformed
  // file degrades to defaults, never to an error.
  async function loadPostoConfig(dir: string): Promise<PostoConfig | null> {
    setSourceError("posto", null);
    const config: PostoConfig = { collections: {} };
    try {
      const index = await invoke<string | null>("read_text_file_optional", {
        path: `${dir}/${POSTO_INDEX_PATH}`,
      });
      if (index !== null) config.collectionOrder = parsePostoIndex(index).collectionOrder;
    } catch (e) {
      setSourceError("posto", e instanceof Error ? e.message : String(e));
      return postoConfigRef.current;
    }
    let listed: { name: string; path: string }[] | null;
    try {
      listed = await invoke<{ name: string; path: string }[] | null>("list_dir_files_optional", {
        dir: `${dir}/${POSTO_COLLECTIONS_DIR}`,
        extensions: ["json"],
      });
    } catch (e) {
      setSourceError("posto", e instanceof Error ? e.message : String(e));
      return postoConfigRef.current;
    }
    for (const file of listed ?? []) {
      if (!file.name.endsWith(".json")) continue;
      try {
        const source = await invoke<string | null>("read_text_file_optional", { path: file.path });
        if (source === null) continue;
        const settings = parsePostoCollection(source);
        if (settings) config.collections[file.name.slice(0, -".json".length)] = settings;
      } catch (e) {
        setSourceError("posto", e instanceof Error ? e.message : String(e));
        return postoConfigRef.current;
      }
    }
    if (config.collectionOrder || Object.keys(config.collections).length > 0) {
      commitPostoConfig(config);
      return config;
    }
    commitPostoConfig(null);
    return null;
  }

  // Astro projects generate a JSON Schema per content collection under
  // `.astro/collections/` (kept fresh by the dev server posto runs). Those
  // become fallback form schemas for folders `.pages.yml` doesn't cover.
  async function loadAstroConfig(dir: string): Promise<PagesConfig | null> {
    setSourceError("astro", null);
    let listed: { name: string; path: string }[] | null;
    try {
      listed = await invoke<{ name: string; path: string }[] | null>("list_dir_files_optional", {
        dir: dir + "/.astro/collections",
        extensions: ["json"],
      });
    } catch (e) {
      setSourceError("astro", e instanceof Error ? e.message : String(e));
      return astroConfigRef.current;
    }
    if (listed === null) {
      commitAstroConfig(null);
      return null; // not an Astro project, or `astro sync` hasn't run yet
    }
    const collections: { name: string; fields: Field[] }[] = [];
    for (const file of listed) {
      if (!file.name.endsWith(".schema.json")) continue;
      const name = file.name.slice(0, -".schema.json".length);
      try {
        const source = await invoke<string | null>("read_text_file_optional", { path: file.path });
        if (source === null) continue;
        const fields = parseCollectionSchema(name, source);
        if (fields && fields.length > 0) collections.push({ name, fields });
      } catch (e) {
        setSourceError("astro", e instanceof Error ? e.message : String(e));
        return astroConfigRef.current;
      }
    }
    if (collections.length === 0) {
      commitAstroConfig(null);
      return null;
    }
    let loaders = new Map<string, LoaderInfo>();
    let scannerDiagnostics: SchemaDiagnostic[] = [];
    for (const configPath of ["/src/content.config.ts", "/src/content/config.ts"]) {
      try {
        const source = await invoke<string | null>("read_text_file_optional", {
          path: dir + configPath,
        });
        if (source === null) continue;
        ({ loaders, diagnostics: scannerDiagnostics } = parseLoaderConfig(source));
        break;
      } catch (e) {
        setSourceError("astro", e instanceof Error ? e.message : String(e));
        return astroConfigRef.current;
      }
    }
    const parsed = buildAstroConfig(collections, loaders, scannerDiagnostics);
    commitAstroConfig(parsed);
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
  const configError = Object.values(configErrors).join(" ") || null;

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

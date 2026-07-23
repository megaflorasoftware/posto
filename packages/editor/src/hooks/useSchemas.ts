import { useMemo, useRef, useState } from "react";
import { parsePagesConfig, type PagesConfig } from "@posto/core/pagescms/config";
import type { ProjectAdapter, ProjectIO } from "@posto/core/project/adapter";
import {
  POSTO_COLLECTIONS_DIR,
  POSTO_INDEX_PATH,
  mergePostoConfig,
  parsePostoCollection,
  parsePostoIndex,
  type PostoConfig,
} from "@posto/core/posto/config";

export function resolveEffectiveConfig(
  pagesConfig: PagesConfig | null,
  derivedConfig: PagesConfig | null,
  postoConfig: PostoConfig | null,
  defaultMedia: PagesConfig["media"],
): PagesConfig {
  return mergePostoConfig(
    {
      media: pagesConfig?.media.length
        ? pagesConfig.media
        : derivedConfig?.media.length
          ? derivedConfig.media
          : defaultMedia,
      content: [...(pagesConfig?.content ?? []), ...(derivedConfig?.content ?? [])],
      collectionSchemas: derivedConfig?.collectionSchemas,
      mediaLibraries: derivedConfig?.mediaLibraries,
      diagnostics: derivedConfig?.diagnostics,
    },
    postoConfig,
  );
}

export function useSchemas(adapter: ProjectAdapter, io: ProjectIO) {
  const generationRef = useRef(0);
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;
  const ioRef = useRef(io);
  ioRef.current = io;
  const [pagesConfig, setPagesConfig] = useState<PagesConfig | null>(null);
  const pagesConfigRef = useRef<PagesConfig | null>(null);
  // Fallback schemas derived from Astro content collections; `.pages.yml`
  // entries take precedence when both describe a folder.
  const [derivedConfig, setDerivedConfig] = useState<PagesConfig | null>(null);
  const derivedConfigRef = useRef<PagesConfig | null>(null);
  // `.posto/` user preferences, overlaid on the effective config below.
  const [postoConfig, setPostoConfig] = useState<PostoConfig | null>(null);
  const postoConfigRef = useRef<PostoConfig | null>(null);
  const [configErrors, setConfigErrors] = useState<
    Partial<Record<"pages" | "derived" | "posto", string>>
  >({});

  function setSourceError(source: "pages" | "derived" | "posto", message: string | null) {
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

  function commitDerivedConfig(config: PagesConfig | null) {
    derivedConfigRef.current = config;
    setDerivedConfig(config);
  }

  function commitPostoConfig(config: PostoConfig | null) {
    postoConfigRef.current = config;
    setPostoConfig(config);
  }

  async function loadPagesConfig(
    dir: string,
    generation = generationRef.current,
    commit = true,
  ): Promise<PagesConfig | null> {
    if (generation === generationRef.current) setSourceError("pages", null);
    let source: string | null;
    try {
      source = await ioRef.current.readTextFileOptional(dir + "/.pages.yml");
    } catch (e) {
      if (generation === generationRef.current) {
        setSourceError("pages", e instanceof Error ? e.message : String(e));
      }
      return pagesConfigRef.current;
    }
    if (source === null) {
      if (commit && generation === generationRef.current) commitPagesConfig(null);
      return null; // no config file — form editing simply isn't offered
    }
    try {
      const parsed = parsePagesConfig(source);
      if (commit && generation === generationRef.current) commitPagesConfig(parsed);
      return parsed;
    } catch (e) {
      if (generation === generationRef.current) {
        setSourceError("pages", e instanceof Error ? e.message : String(e));
      }
      return pagesConfigRef.current;
    }
  }

  // `.posto/` holds user preferences layered over the derived config:
  // `index.json` for workspace settings and `collections/<name>.json` per
  // collection. Missing paths and malformed JSON degrade to defaults;
  // unreadable paths surface an I/O error while preserving the last good
  // preferences.
  async function loadPostoConfig(
    dir: string,
    generation = generationRef.current,
    commit = true,
  ): Promise<PostoConfig | null> {
    if (generation === generationRef.current) setSourceError("posto", null);
    const config: PostoConfig = { collections: {} };
    let indexSource: string | null;
    try {
      indexSource = await ioRef.current.readTextFileOptional(`${dir}/${POSTO_INDEX_PATH}`);
    } catch (e) {
      if (generation === generationRef.current) {
        setSourceError("posto", e instanceof Error ? e.message : String(e));
      }
      return postoConfigRef.current;
    }
    if (indexSource !== null) {
      config.collectionOrder = parsePostoIndex(indexSource).collectionOrder;
    }
    let listed: { name: string; path: string }[] | null;
    try {
      listed = await ioRef.current.listDirFilesOptional(`${dir}/${POSTO_COLLECTIONS_DIR}`, [
        "json",
      ]);
    } catch (e) {
      if (generation === generationRef.current) {
        setSourceError("posto", e instanceof Error ? e.message : String(e));
      }
      return postoConfigRef.current;
    }
    for (const file of listed ?? []) {
      if (!file.name.endsWith(".json")) continue;
      let source: string | null;
      try {
        source = await ioRef.current.readTextFileOptional(file.path);
      } catch (e) {
        if (generation === generationRef.current) {
          setSourceError("posto", e instanceof Error ? e.message : String(e));
        }
        return postoConfigRef.current;
      }
      if (source === null) continue;
      const settings = parsePostoCollection(source);
      if (settings) config.collections[file.name.slice(0, -".json".length)] = settings;
    }
    if (config.collectionOrder || Object.keys(config.collections).length > 0) {
      if (commit && generation === generationRef.current) commitPostoConfig(config);
      return config;
    }
    if (commit && generation === generationRef.current) commitPostoConfig(null);
    return null;
  }

  async function loadDerivedConfig(
    dir: string,
    selectedAdapter: ProjectAdapter = adapterRef.current,
    generation = generationRef.current,
    commit = true,
  ): Promise<PagesConfig | null> {
    if (generation === generationRef.current) setSourceError("derived", null);
    try {
      const loaded = await selectedAdapter.loadDerivedConfig(dir, ioRef.current);
      if (!loaded) {
        if (commit && generation === generationRef.current) commitDerivedConfig(null);
        return null;
      }
      const diagnostics = new Map(
        [...(loaded.config.diagnostics ?? []), ...loaded.diagnostics].map((diagnostic) => [
          `${diagnostic.feature}:${diagnostic.collection ?? ""}:${diagnostic.code}:${diagnostic.message}`,
          diagnostic,
        ]),
      );
      const config: PagesConfig = {
        ...loaded.config,
        diagnostics: diagnostics.size > 0 ? [...diagnostics.values()] : undefined,
      };
      if (commit && generation === generationRef.current) commitDerivedConfig(config);
      return config;
    } catch (e) {
      if (generation === generationRef.current) {
        setSourceError("derived", e instanceof Error ? e.message : String(e));
      }
      return derivedConfigRef.current;
    }
  }

  /** Reloads every repository-owned schema/config source and returns the
   * effective result immediately. Callers that must rebuild derived file
   * groups should use this result rather than waiting for React state to
   * commit and then reading configRef. */
  async function loadSchemas(
    dir: string,
    selectedAdapter: ProjectAdapter = adapterRef.current,
  ): Promise<PagesConfig> {
    const generation = ++generationRef.current;
    commitPagesConfig(null);
    commitDerivedConfig(null);
    commitPostoConfig(null);
    setConfigErrors({});
    const [pages, derived, posto] = await Promise.all([
      loadPagesConfig(dir, generation, false),
      loadDerivedConfig(dir, selectedAdapter, generation, false),
      loadPostoConfig(dir, generation, false),
    ]);
    if (generation !== generationRef.current) return configRef.current;
    commitPagesConfig(pages);
    commitDerivedConfig(derived);
    commitPostoConfig(posto);
    return resolveEffectiveConfig(pages, derived, posto, selectedAdapter.defaultMedia);
  }

  // Effective schema config: `.pages.yml` entries first (higher resolution —
  // labels, media, widget types), Astro collection schemas after them as a
  // fallback. matchEntry's first-match-wins ordering makes the precedence.
  const config = useMemo(
    () => resolveEffectiveConfig(pagesConfig, derivedConfig, postoConfig, adapter.defaultMedia),
    [pagesConfig, derivedConfig, postoConfig, adapter.defaultMedia],
  );
  const configRef = useRef(config);
  configRef.current = config;
  const configError = Object.values(configErrors).join(" ") || null;

  return {
    config,
    configRef,
    pagesConfig,
    derivedConfig,
    configError,
    loadPagesConfig,
    loadDerivedConfig,
    loadPostoConfig,
    loadSchemas,
  };
}

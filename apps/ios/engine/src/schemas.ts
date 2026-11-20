/**
 * The repository's effective schema config: `.pages.yml`, the adapter's
 * derived (Astro) config, and `.posto/` preferences. A headless port of
 * `useSchemas`: same sources, same precedence, same keep-the-last-good-config
 * behavior when a source fails to load.
 */
import { parsePagesConfig, type PagesConfig } from "@posto/core/pagescms/config";
import type { ProjectAdapter, ProjectIO } from "@posto/core/project/adapter";
import {
  POSTO_COLLECTIONS_DIR,
  POSTO_INDEX_PATH,
  parsePostoCollection,
  parsePostoIndex,
  type PostoConfig,
} from "@posto/core/posto/config";
import { resolveEffectiveConfig } from "../../../../packages/editor/src/hooks/useSchemas";
import { errorMessage } from "./host";

type Source = "pages" | "derived" | "posto";

export class Schemas {
  pagesConfig: PagesConfig | null = null;
  derivedConfig: PagesConfig | null = null;
  postoConfig: PostoConfig | null = null;
  config: PagesConfig;
  private errors: Partial<Record<Source, string>> = {};
  private activeSource: { dir: string; adapterType: string } | null = null;
  private generation = 0;

  constructor(
    private readonly io: ProjectIO,
    private adapter: ProjectAdapter,
  ) {
    this.config = resolveEffectiveConfig(null, null, null, adapter.defaultMedia);
  }

  get configError(): string | null {
    return Object.values(this.errors).join(" ") || null;
  }

  private setError(source: Source, message: string | null) {
    if (message) this.errors[source] = message;
    else delete this.errors[source];
  }

  private recompute() {
    this.config = resolveEffectiveConfig(
      this.pagesConfig,
      this.derivedConfig,
      this.postoConfig,
      this.adapter.defaultMedia,
    );
  }

  private async readPages(dir: string, fallback: PagesConfig | null): Promise<PagesConfig | null> {
    this.setError("pages", null);
    let source: string | null;
    try {
      source = await this.io.readTextFileOptional(`${dir}/.pages.yml`);
    } catch (error) {
      this.setError("pages", errorMessage(error));
      return fallback;
    }
    if (source === null) return null;
    try {
      return parsePagesConfig(source);
    } catch (error) {
      this.setError("pages", errorMessage(error));
      return fallback;
    }
  }

  private async readDerived(
    dir: string,
    adapter: ProjectAdapter,
    fallback: PagesConfig | null,
  ): Promise<PagesConfig | null> {
    this.setError("derived", null);
    try {
      const loaded = await adapter.loadDerivedConfig(dir, this.io);
      if (!loaded) return null;
      const diagnostics = new Map(
        [...(loaded.config.diagnostics ?? []), ...loaded.diagnostics].map((diagnostic) => [
          `${diagnostic.feature}:${diagnostic.collection ?? ""}:${diagnostic.code}:${diagnostic.message}`,
          diagnostic,
        ]),
      );
      return {
        ...loaded.config,
        diagnostics: diagnostics.size > 0 ? [...diagnostics.values()] : undefined,
      };
    } catch (error) {
      this.setError("derived", errorMessage(error));
      return fallback;
    }
  }

  private async readPosto(dir: string, fallback: PostoConfig | null): Promise<PostoConfig | null> {
    this.setError("posto", null);
    const config: PostoConfig = { collections: {} };
    try {
      const indexSource = await this.io.readTextFileOptional(`${dir}/${POSTO_INDEX_PATH}`);
      if (indexSource !== null) {
        const index = parsePostoIndex(indexSource);
        config.collectionOrder = index.collectionOrder;
        config.mediaSources = index.mediaSources;
      }
      const listed = await this.io.listDirFilesOptional(`${dir}/${POSTO_COLLECTIONS_DIR}`, [
        "json",
      ]);
      for (const file of listed ?? []) {
        if (!file.name.endsWith(".json")) continue;
        const source = await this.io.readTextFileOptional(file.path);
        if (source === null) continue;
        const settings = parsePostoCollection(source);
        if (settings) config.collections[file.name.slice(0, -".json".length)] = settings;
      }
    } catch (error) {
      this.setError("posto", errorMessage(error));
      return fallback;
    }
    return config.collectionOrder || config.mediaSources || Object.keys(config.collections).length
      ? config
      : null;
  }

  /** Reloads every source and returns the effective config. */
  async load(dir: string, adapter: ProjectAdapter = this.adapter): Promise<PagesConfig> {
    const generation = ++this.generation;
    const same = this.activeSource?.dir === dir && this.activeSource.adapterType === adapter.type;
    this.errors = {};
    const [pages, derived, posto] = await Promise.all([
      this.readPages(dir, same ? this.pagesConfig : null),
      this.readDerived(dir, adapter, same ? this.derivedConfig : null),
      this.readPosto(dir, same ? this.postoConfig : null),
    ]);
    if (generation !== this.generation) return this.config;
    this.adapter = adapter;
    this.pagesConfig = pages;
    this.derivedConfig = derived;
    this.postoConfig = posto;
    this.activeSource = { dir, adapterType: adapter.type };
    this.recompute();
    return this.config;
  }

  async reloadPages(dir: string): Promise<void> {
    this.pagesConfig = await this.readPages(dir, this.pagesConfig);
    this.recompute();
  }

  async reloadDerived(dir: string): Promise<void> {
    this.derivedConfig = await this.readDerived(dir, this.adapter, this.derivedConfig);
    this.recompute();
  }

  async reloadPosto(dir: string): Promise<void> {
    this.postoConfig = await this.readPosto(dir, this.postoConfig);
    this.recompute();
  }
}

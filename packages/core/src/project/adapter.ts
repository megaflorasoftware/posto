import type { Field, PagesConfig } from "../pagescms/config";
import type { ProjectType } from "./detect";

export interface ProjectIO {
  pathExists(path: string, kind?: "file" | "directory"): Promise<boolean>;
  readTextFileOptional(path: string): Promise<string | null>;
  listDirFilesOptional(
    dir: string,
    extensions: string[],
  ): Promise<{ name: string; path: string }[] | null>;
}

export interface ProjectDiagnostic {
  feature: string;
  code: string;
  message: string;
  collection?: string | null;
}

export interface DerivedConfig {
  config: PagesConfig;
  diagnostics: ProjectDiagnostic[];
}

export interface FileRoute {
  route: string;
  certain: boolean;
}

export interface SiteUrlSource {
  path: string;
  extract(source: string): string | null;
}

export interface PathMatcher {
  prefix?: string;
  exact?: string;
  glob?: string;
}

export type InvalidationScope =
  | "derivedConfig"
  | "componentSchemas"
  | "mediaLibraries"
  | "dataDocuments"
  | "projectType"
  | "workspaceLayout";

export interface InvalidationRule {
  paths: PathMatcher[];
  refresh: InvalidationScope;
}

export interface IgnoreRule {
  prefix?: string;
  glob?: string;
  exceptPrefixes?: string[];
}

export interface ComponentRef {
  name: string;
  path: string;
}

export interface ComponentSchemaSource {
  componentDirs(root: string): string[];
  listComponents(root: string, io: ProjectIO): Promise<ComponentRef[]>;
  componentFields(
    ref: ComponentRef,
    io: ProjectIO,
  ): Promise<{ fields: Field[]; diagnostics: ProjectDiagnostic[] }>;
  importFor(ref: ComponentRef, documentPath: string): string;
}

export interface ProjectAdapter {
  readonly type: ProjectType;
  loadDerivedConfig(root: string, io: ProjectIO): Promise<DerivedConfig | null>;
  invalidations(root: string, config?: PagesConfig | null): InvalidationRule[];
  routeForFile(root: string, path: string, content: string): FileRoute | null;
  siteUrlSources(root: string): SiteUrlSource[];
  watchIgnores(): IgnoreRule[];
  capabilities: {
    imageLibraries: boolean;
    dataDocuments: boolean;
    componentBlocks: ComponentSchemaSource | null;
    entryIds: "framework" | null;
  };
}

function matches(path: string, matcher: PathMatcher): boolean {
  if (matcher.exact && path === matcher.exact) return true;
  if (matcher.prefix && path.startsWith(matcher.prefix)) return true;
  if (matcher.glob) {
    const escaped = matcher.glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
    return new RegExp(`^${escaped}$`).test(path);
  }
  return false;
}

/** Resolves changed paths to a de-duplicated set of adapter refresh scopes. */
export function invalidationScopesForPaths(
  adapter: ProjectAdapter,
  root: string,
  paths: string[],
  config?: PagesConfig | null,
): Set<InvalidationScope> {
  const scopes = new Set<InvalidationScope>();
  for (const rule of adapter.invalidations(root, config)) {
    if (paths.some((path) => rule.paths.some((matcher) => matches(path, matcher)))) {
      scopes.add(rule.refresh);
    }
  }
  return scopes;
}

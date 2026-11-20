/**
 * Smaller screens' logic: deployment status, developer-mode collection
 * settings and order, and MDX component insertion for the body editor.
 */
import type { WorkflowRun } from "@posto/ipc";
import { computeDeploymentRing } from "@posto/core/github/deployment";
import type { ContentEntry } from "@posto/core/pagescms/config";
import { serializeJsx } from "@posto/core/mdx/mdx";
import { jsValueProp } from "@posto/core/mdx/propFields";
import type { ProjectAdapter } from "@posto/core/project/adapter";
import {
  LABEL_SORT,
  parsePostoCollection,
  POSTO_COLLECTIONS_DIR,
  POSTO_INDEX_PATH,
  updatePostoCollectionSource,
  updatePostoIndexSource,
  type PostoCollectionSettings,
} from "@posto/core/posto/config";
import { orderableCollections } from "../../../../packages/editor/src/sidebarTree";
import { dateControls, type DateControl } from "./dates";
import { fieldViews, type FieldView } from "./fieldViews";
import { invoke } from "./host";
import { MetadataForm } from "./metadataForm";
import { ipcProjectIO, type RepoSession } from "./repo";

// --- Deployments -----------------------------------------------------------

function normalizeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withProtocol).toString();
  } catch {
    return null;
  }
}

/** The site's live URL: the adapter's config (Astro `site`), `public/CNAME`,
 * then package.json `homepage` — the same order as useSiteUrl. */
export async function resolveSiteUrl(
  root: string,
  adapter: ProjectAdapter,
): Promise<string | null> {
  const read = (path: string) => invoke<string | null>("read_text_file_optional", { path });
  for (const candidate of adapter.siteUrlSources(root)) {
    const source = await read(candidate.path);
    if (source) {
      const url = normalizeUrl(candidate.extract(source) ?? "");
      if (url) return url;
    }
  }
  const cname = await read(`${root}/public/CNAME`);
  if (cname) {
    const host = cname.split(/\r?\n/).find((line) => line.trim() !== "");
    const url = host ? normalizeUrl(host) : null;
    if (url) return url;
  }
  const pkg = await read(`${root}/package.json`);
  if (pkg) {
    try {
      const homepage = (JSON.parse(pkg) as { homepage?: unknown }).homepage;
      if (typeof homepage === "string") return normalizeUrl(homepage);
    } catch {
      // Malformed package.json — nothing to learn from it.
    }
  }
  return null;
}

export async function deploymentStatus(repo: RepoSession) {
  const identity = repo.repo;
  if (!identity) throw new Error("No repository is connected.");
  const branch = repo.branches.branch ?? identity.defaultBranch;
  const [runs, pagesUrl, siteUrl] = await Promise.all([
    invoke<WorkflowRun[]>("list_workflow_runs", {
      owner: identity.owner,
      name: identity.name,
      branch,
    }),
    invoke<string | null>("github_pages_url", { owner: identity.owner, name: identity.name }).catch(
      () => null,
    ),
    resolveSiteUrl(repo.root, repo.adapter).catch(() => null),
  ]);
  const latest = runs[0] ?? null;
  return {
    owner: identity.owner,
    name: identity.name,
    branch,
    running: latest !== null && latest.status !== "completed",
    ring: computeDeploymentRing(
      runs.map((run) => ({
        workflowId: run.workflow_id,
        status: run.status,
        conclusion: run.conclusion,
        runStartedAt: run.run_started_at,
        updatedAt: run.updated_at,
        createdAt: run.created_at,
      })),
      Date.now(),
    ),
    runs: runs.map((run) => ({
      workflowId: run.workflow_id,
      status: run.status,
      conclusion: run.conclusion,
      runStartedAt: run.run_started_at,
      updatedAt: run.updated_at,
      createdAt: run.created_at,
    })),
    siteUrl: siteUrl ?? pagesUrl,
    actionsUrl: `https://github.com/${identity.owner}/${identity.name}/actions`,
  };
}

/** Recomputes the ring between polls so a running deploy keeps filling. */
export function deploymentRing(
  runs: Parameters<typeof computeDeploymentRing>[0],
): ReturnType<typeof computeDeploymentRing> {
  return computeDeploymentRing(runs, Date.now());
}

// --- Collection settings ---------------------------------------------------

function collection(repo: RepoSession, name: string): ContentEntry {
  const entry = repo.config.content.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`Unknown collection ${name}`);
  return entry;
}

export async function collectionSettings(repo: RepoSession, name: string) {
  const entry = collection(repo, name);
  const path = `${repo.root}/${POSTO_COLLECTIONS_DIR}/${entry.name}.json`;
  const source = await invoke<string | null>("read_text_file_optional", { path });
  const settings: PostoCollectionSettings = (source && parsePostoCollection(source)) || {};
  const group = repo.files.groups.find(
    (candidate) =>
      candidate.path === `${repo.root}/${entry.path}` || candidate.dataCollection === entry.name,
  );
  return {
    name: entry.name,
    label: entry.label ?? entry.name,
    displayName: settings.displayName ?? "",
    entryName: settings.entryName ?? "",
    sortBy: settings.sort?.by ?? null,
    sortDirection: settings.sort?.direction ?? "desc",
    pinned: settings.pinned ?? [],
    sortOptions: [
      { value: LABEL_SORT, label: "Entry label" },
      ...entry.fields
        .filter((field) => field.type !== "object" && !field.list && field.name !== "body")
        .map((field) => ({
          value: `fields.${field.name}`,
          label: typeof field.label === "string" ? field.label : field.name,
        })),
    ],
    fileNames: group?.files.map((file) => file.name) ?? [],
  };
}

export async function saveCollectionSettings(
  repo: RepoSession,
  input: {
    name: string;
    displayName: string;
    entryName: string;
    sortBy: string | null;
    sortDirection: "asc" | "desc";
    pinned: string[];
  },
): Promise<void> {
  const entry = collection(repo, input.name);
  const path = `${repo.root}/${POSTO_COLLECTIONS_DIR}/${entry.name}.json`;
  const source = await invoke<string | null>("read_text_file_optional", { path });
  const content = updatePostoCollectionSource(source, {
    displayName: input.displayName.trim() || undefined,
    entryName: input.entryName.trim() || undefined,
    sort: input.sortBy ? { by: input.sortBy, direction: input.sortDirection } : undefined,
    pinned: input.pinned.length > 0 ? input.pinned : undefined,
  });
  await invoke("write_text_file", { path, content });
  await repo.schemas.reloadPosto(repo.root);
  repo.changed();
}

export function collectionOrder(repo: RepoSession) {
  return orderableCollections(repo.config).map((entry) => ({
    name: entry.name,
    label: entry.label ?? entry.name,
  }));
}

export async function saveCollectionOrder(repo: RepoSession, order: string[]): Promise<void> {
  const path = `${repo.root}/${POSTO_INDEX_PATH}`;
  const source = await invoke<string | null>("read_text_file_optional", { path });
  await invoke("write_text_file", { path, content: updatePostoIndexSource(source, order) });
  await repo.schemas.reloadPosto(repo.root);
  repo.changed();
}

// --- MDX components --------------------------------------------------------

export async function listComponents(repo: RepoSession) {
  const source = repo.adapter.capabilities.componentBlocks;
  if (!source) return { components: [], directories: [] };
  const components = await source.listComponents(repo.root, ipcProjectIO);
  return {
    components: components.map((component) => ({
      name: component.name,
      path: component.path,
      relativePath: component.path.slice(repo.root.length + 1),
    })),
    directories: source.componentDirs(repo.root).map((dir) => dir.slice(repo.root.length + 1)),
  };
}

let componentForm: {
  name: string;
  path: string;
  form: MetadataForm;
  slots: string[];
  hasDefaultSlot: boolean;
} | null = null;

export async function openComponentForm(repo: RepoSession, name: string, path: string) {
  const source = repo.adapter.capabilities.componentBlocks;
  if (!source) throw new Error("This project doesn't support component blocks.");
  const schema = await source.componentFields({ name, path }, ipcProjectIO, repo.config);
  componentForm = {
    name,
    path,
    form: new MetadataForm(schema?.fields ?? [], {}),
    slots: schema?.slots ?? [],
    hasDefaultSlot: schema?.hasDefaultSlot ?? true,
  };
  return componentFormView();
}

export function componentFormView(): {
  name: string;
  fields: FieldView[];
  values: Record<string, unknown>;
  errors: Record<string, string>;
  dates: Record<string, DateControl>;
  slots: string[];
  hasDefaultSlot: boolean;
} {
  if (!componentForm) throw new Error("No component is being inserted");
  return {
    name: componentForm.name,
    fields: fieldViews(componentForm.form.fields, null, { media: [], content: [] }, false, []),
    values: componentForm.form.values(),
    errors: Object.fromEntries(componentForm.form.errors()),
    dates: dateControls(componentForm.form.fields, componentForm.form.values()),
    slots: componentForm.slots,
    hasDefaultSlot: componentForm.hasDefaultSlot,
  };
}

export function componentFormStore(): MetadataForm {
  if (!componentForm) throw new Error("No component is being inserted");
  return componentForm.form;
}

/** The JSX to insert, and the import the document now needs. */
export function finishComponent(repo: RepoSession): { snippet: string } {
  const pending = componentForm;
  if (!pending) throw new Error("No component is being inserted");
  if (!pending.form.valid) throw new Error("Fix the highlighted fields first.");
  const document = repo.requireDocument();
  const source = repo.adapter.capabilities.componentBlocks;
  const props = pending.form.fields.flatMap((field) => {
    const prop = jsValueProp(
      field.name,
      pending.form.values()[field.name],
      field.required === true,
    );
    return prop ? [prop] : [];
  });
  const children = pending.hasDefaultSlot || pending.slots.length > 0 ? "\n" : null;
  if (source && !document.hasImportFor(pending.name)) {
    document.addImport(source.importFor({ name: pending.name, path: pending.path }, document.path));
  }
  componentForm = null;
  return { snippet: serializeJsx(pending.name, props, children) };
}

export { fieldViews };

/**
 * Smaller screens' logic: deployment status, developer-mode collection
 * settings and order, and MDX component insertion for the body editor.
 */
import type { WorkflowRun } from "@posto/ipc";
import { computeDeploymentRing } from "@posto/core/github/deployment";
import { cdnObjectUrl, type CdnSource } from "@posto/core/media/sources";
import type { MediaCredential } from "@posto/ipc";
import { markdownMediaKind } from "../../../../packages/editor/src/markdownMedia";
import { listMediaObjects, saveMediaCredential } from "./ipc";
import {
  expandFieldTemplate,
  type ContentEntry,
  type Field,
  type FieldTemplateSchema,
  type PagesConfig,
} from "@posto/core/pagescms/config";
import {
  assembleSlotChildren,
  dedent,
  parseProps,
  scanJsxBlock,
  serializeJsx,
  splitSlots,
  type MdxProp,
} from "@posto/core/mdx/mdx";
import { jsValueProp, propJsValue, UNPARSED, valueFits } from "@posto/core/mdx/propFields";
import type { ProjectAdapter } from "@posto/core/project/adapter";
import {
  LABEL_SORT,
  parsePostoCollection,
  POSTO_COLLECTIONS_DIR,
  POSTO_INDEX_PATH,
  updatePostoCollectionSource,
  updatePostoFieldTemplateSource,
  updatePostoIndexSource,
  type PostoCollectionSettings,
} from "@posto/core/posto/config";
import { orderableCollections } from "../../../../packages/editor/src/sidebarTree";
import { scanBodyEmbeds } from "./bodyEmbeds";
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

/** Developer mode: saves (or removes) a field's template or row count in
 * the open document's collection settings, then applies a controlled
 * template right away, as the desktop dialogs do. Entries of data
 * collections have them too, except the filename (they have none). */
export async function saveFieldTemplate(
  repo: RepoSession,
  fieldName: string,
  schema: FieldTemplateSchema | null,
): Promise<string | null> {
  const document = repo.requireDocument();
  const entry = document.entry;
  if (!entry) throw new Error("Only collection entries have field templates.");
  if (document.dataEntry && fieldName === "filename")
    throw new Error("Data collection entries have no filename template.");
  const path = `${repo.root}/${POSTO_COLLECTIONS_DIR}/${entry.name}.json`;
  const source = await invoke<string | null>("read_text_file_optional", { path });
  await invoke("write_text_file", {
    path,
    content: updatePostoFieldTemplateSource(source, fieldName, schema),
  });
  await repo.schemas.reloadPosto(repo.root);
  repo.changed();
  if (!schema?.template || schema.editBehavior !== "controlled") return null;
  if (fieldName === "filename") return repo.refreshFilename();
  const value = expandFieldTemplate(schema.template, document.view().form?.values ?? {});
  if (value !== null) document.edit(fieldName.split("."), value);
  return null;
}

// --- CDN browsing ----------------------------------------------------------

/** One folder of a CDN source's images, or a request for its password. */
export async function listCdnImages(source: CdnSource, prefix: string | null) {
  const root = source.prefix ?? "";
  const current = prefix ?? root;
  if (!(await invoke<boolean>("media_credential_exists", { source }))) {
    return { needsCredential: true, root, prefix: current, directories: [], images: [] };
  }
  const listing = await listMediaObjects(source, current);
  return {
    needsCredential: false,
    root,
    prefix: current,
    directories: listing.directories.map((directory) => ({
      key: directory,
      name: directory.slice(directory.lastIndexOf("/") + 1),
    })),
    images: listing.objects
      .filter((object) => markdownMediaKind(object.key) === "image")
      .map((object) => ({
        key: object.key,
        name: object.key.slice(object.key.lastIndexOf("/") + 1),
        url: cdnObjectUrl(source, object.key),
      })),
  };
}

export function saveCdnCredential(source: CdnSource, credential: MediaCredential): Promise<void> {
  return saveMediaCredential(source, credential, source.prefix ?? "");
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

/** A slot's text in the component form: `name` null for the default slot. */
export interface SlotText {
  name: string | null;
  text: string;
}

let componentForm: {
  name: string;
  path: string;
  form: MetadataForm;
  slots: string[];
  hasDefaultSlot: boolean;
  /** The children as one text per slot, as the form shows them. */
  slotTexts: SlotText[];
  /** Props edited as their source text, as the desktop form's raw rows. */
  rawProps: RawProp[];
  /** What the props' fields resolve against: the site's config (image
   * libraries, collections) and whether entry ids exist, so a
   * `CollectionEntry<'media'>['id']` prop is an image-library picker. */
  context: { config: PagesConfig; hasEntryIds: boolean };
  /** The component declares its props (a type definition Posto read), so
   * the form covers every option, as the desktop card's typed indicator. */
  typed: boolean;
  /** Set when editing a block already in the body: where it is, its
   * children, and props the form doesn't cover (kept verbatim). */
  editing?: {
    start: number;
    end: number;
    /** The component's source as found, kept when nothing is edited. */
    raw: string;
    /** The form's values when it opened, to tell whether props changed. */
    values: string;
    children: string | null;
    kept: MdxProp[];
    /** Opens a line, rather than sitting inside a paragraph. */
    block: boolean;
  };
} | null = null;

/** Opens the props form for the component around `offset` in the body
 * `text` (offsets in UTF-16 units, as UITextView counts them): the
 * innermost block opening a line, or exactly the component at `start` when
 * given (an inline one, say). */
export async function openComponentAt(
  repo: RepoSession,
  text: string,
  offset: number,
  start?: number,
) {
  let found: { start: number; block: NonNullable<ReturnType<typeof scanJsxBlock>> } | null = null;
  if (start !== undefined) {
    const block = scanJsxBlock(text.slice(start));
    if (block) found = { start, block };
  } else {
    // Only components the body shows as cards or pills (and those nested in
    // them), not samples inside code.
    const outside = scanBodyEmbeds(text, true).filter((embed) => embed.kind === "component");
    for (const match of text.matchAll(/(^|\n)[ \t]*<[A-Z]/g)) {
      const blockStart = (match.index ?? 0) + match[0].length - 2;
      if (blockStart > offset) break;
      if (!outside.some((embed) => embed.start <= blockStart && blockStart < embed.end)) continue;
      const block = scanJsxBlock(text.slice(blockStart));
      // Later starts are nested inside earlier ones, so the innermost wins.
      if (block && offset <= blockStart + block.raw.length) found = { start: blockStart, block };
    }
  }
  if (!found) throw new Error("Put the cursor inside a component to edit it.");
  const { block } = found;
  const blockStart = found.start;
  const props = parseProps(block.propsSource);
  if (!props) {
    throw new Error(
      `${block.name}'s props use expressions Posto can't edit here. Edit them as text.`,
    );
  }
  const document = repo.requireDocument();
  const source = repo.adapter.capabilities.componentBlocks;
  const path = document.importPathFor(block.name);
  const schema =
    source && path
      ? await source.componentFields({ name: block.name, path }, ipcProjectIO, repo.config)
      : null;
  const { fields, values, rawProps, kept } = propsForm(schema?.fields ?? [], props);
  const slots = schema?.slots ?? [];
  const hasDefaultSlot = schema?.hasDefaultSlot ?? true;
  const form = new MetadataForm(fields, values);
  componentForm = {
    name: block.name,
    path: path ?? "",
    form,
    rawProps,
    slots,
    hasDefaultSlot,
    slotTexts: slotTextsOf(block.children, slots, hasDefaultSlot || schema === null),
    context: fieldContext(repo),
    typed: (schema?.fields.length ?? 0) > 0,
    editing: {
      start: blockStart,
      end: blockStart + block.raw.length,
      raw: block.raw,
      values: JSON.stringify(form.values()),
      children: block.children,
      kept,
      block: blockStart === 0 || text[blockStart - 1] === "\n",
    },
  };
  return componentFormView();
}

/** A prop edited as its source text (the desktop form's raw rows): one
 * whose value the form can't represent (`roles={roles}`), whose declared
 * type has no control (`PolaroidMediaItem[]`), or that the component
 * doesn't declare. */
interface RawProp {
  name: string;
  /** How the prop was written, or will be when added. */
  kind: MdxProp["kind"];
  /** Whether the tag had it, so clearing it removes it. */
  existed: boolean;
}

function schemaKind(type: string | null): MdxProp["kind"] {
  return (type ?? "").replace(/\s/g, "") === "string" ? "string" : "expression";
}

/** The props form, as the desktop builds it: a declared prop gets its field
 * when its value fits; anything else becomes a raw text row holding the
 * prop's source. Spreads stay verbatim (`kept`). */
function propsForm(
  declared: Field[],
  props: MdxProp[],
): { fields: Field[]; values: Record<string, unknown>; rawProps: RawProp[]; kept: MdxProp[] } {
  const fields: Field[] = [];
  const values: Record<string, unknown> = {};
  const rawProps: RawProp[] = [];
  const named = props.filter((prop) => prop.kind !== "spread");
  const rawRow = (name: string, declaredType: string | null, prop: MdxProp | undefined) => {
    rawProps.push({
      name,
      kind: prop ? prop.kind : schemaKind(declaredType),
      existed: prop !== undefined,
    });
    const isExpression = (prop?.kind ?? schemaKind(declaredType)) !== "string";
    fields.push({
      name,
      type: "string",
      label: name,
      description: [isExpression ? "Edited as source: {…}" : "Edited as source", declaredType]
        .filter(Boolean)
        .join(" · "),
      options: { mdxRawField: true },
    } as Field);
    if (prop) values[name] = prop.value;
  };
  for (const field of declared) {
    const rawType = typeof field.options?.mdxRawType === "string" ? field.options.mdxRawType : null;
    const declaredType =
      typeof field.options?.mdxDeclaredType === "string" ? field.options.mdxDeclaredType : rawType;
    const prop = named.find((candidate) => candidate.name === field.name);
    const value = prop ? propJsValue(prop) : undefined;
    if (!rawType && value !== UNPARSED && valueFits(field, value)) {
      fields.push(field);
      if (prop) values[field.name] = value;
    } else {
      rawRow(field.name, declaredType, prop);
    }
  }
  const declaredNames = new Set(declared.map((field) => field.name));
  for (const prop of named) {
    if (!declaredNames.has(prop.name)) rawRow(prop.name, null, prop);
  }
  return { fields, values, rawProps, kept: props.filter((prop) => prop.kind === "spread") };
}

/** A raw row's prop: its text as written, in the prop's kind (a boolean
 * shorthand edited to anything else becomes an expression, as on desktop).
 * Emptied, it's dropped. */
function rawPropFrom(raw: RawProp, value: unknown): MdxProp[] {
  const text = typeof value === "string" ? value : "";
  if (text.trim() === "") return [];
  const kind = raw.kind === "boolean" && text !== "true" ? "expression" : raw.kind;
  return [{ name: raw.name, value: text, kind } as MdxProp];
}

/** A component's children as one text per slot: the default slot (when the
 * component has one, or content is already there), then each named slot it
 * uses or declares, as the desktop editor's children fields show them. */
function slotTextsOf(
  children: string | null,
  declared: string[],
  showDefault: boolean,
): SlotText[] {
  const buckets = splitSlots(children);
  const tidy = (text: string) => dedent(text).trim();
  const texts: SlotText[] = [];
  if (showDefault || buckets.defaultContent.trim() !== "") {
    texts.push({ name: null, text: tidy(buckets.defaultContent) });
  }
  const names = buckets.named.map((bucket) => bucket.name);
  for (const name of declared) if (!names.includes(name)) names.push(name);
  for (const name of names) {
    const pieces = buckets.named.find((bucket) => bucket.name === name)?.pieces ?? [];
    texts.push({ name, text: tidy(pieces.map((piece) => piece.text).join("")) });
  }
  return texts;
}

/** Children rebuilt from edited slot texts. Content on its own lines stays
 * on its own lines, so block components keep their shape. */
function childrenFrom(slotTexts: SlotText[], multiline: boolean): string | null {
  const wrap = (text: string) =>
    multiline && text.trim() !== "" ? `\n${text.trim()}\n` : text.trim();
  const defaultText = slotTexts.find((slot) => slot.name == null)?.text ?? "";
  const named = slotTexts.flatMap((slot) =>
    slot.name == null ? [] : [{ name: slot.name, text: wrap(slot.text) }],
  );
  return assembleSlotChildren(wrap(defaultText), named);
}

export async function openComponentForm(repo: RepoSession, name: string, path: string) {
  const source = repo.adapter.capabilities.componentBlocks;
  if (!source) throw new Error("This project doesn't support component blocks.");
  const schema = await source.componentFields({ name, path }, ipcProjectIO, repo.config);
  const { fields, rawProps } = propsForm(schema?.fields ?? [], []);
  componentForm = {
    name,
    path,
    form: new MetadataForm(fields, {}),
    rawProps,
    slots: schema?.slots ?? [],
    hasDefaultSlot: schema?.hasDefaultSlot ?? true,
    slotTexts: slotTextsOf(null, schema?.slots ?? [], schema?.hasDefaultSlot ?? true),
    context: fieldContext(repo),
    typed: (schema?.fields.length ?? 0) > 0,
  };
  return componentFormView();
}

function fieldContext(repo: RepoSession) {
  return { config: repo.config, hasEntryIds: repo.adapter.capabilities.entryIds !== null };
}

export function componentFormView(): {
  name: string;
  fields: FieldView[];
  values: Record<string, unknown>;
  errors: Record<string, string>;
  dates: Record<string, DateControl>;
  slots: string[];
  hasDefaultSlot: boolean;
  slotTexts: SlotText[];
  typed: boolean;
} {
  if (!componentForm) throw new Error("No component is being inserted");
  return {
    name: componentForm.name,
    typed: componentForm.typed,
    fields: fieldViews(
      componentForm.form.fields,
      null,
      componentForm.context.config,
      componentForm.context.hasEntryIds,
      [],
    ),
    values: componentForm.form.values(),
    errors: Object.fromEntries(componentForm.form.errors()),
    dates: dateControls(componentForm.form.fields, componentForm.form.values()),
    slots: componentForm.slots,
    hasDefaultSlot: componentForm.hasDefaultSlot,
    slotTexts: componentForm.slotTexts,
  };
}

export function componentFormStore(): MetadataForm {
  if (!componentForm) throw new Error("No component is being inserted");
  return componentForm.form;
}

/** The JSX to insert (or the range it replaces, when editing), and the
 * import the document now needs. `slots` carries edited children; without
 * it (or when nothing changed) the children are kept verbatim. */
export function finishComponent(
  repo: RepoSession,
  slots?: SlotText[],
): {
  snippet: string;
  range: [number, number] | null;
} {
  const pending = componentForm;
  if (!pending) throw new Error("No component is being inserted");
  if (!pending.form.valid) throw new Error("Fix the highlighted fields first.");
  const document = repo.requireDocument();
  const source = repo.adapter.capabilities.componentBlocks;
  const values = pending.form.values();
  const props = pending.form.fields.flatMap((field): MdxProp[] => {
    const raw = pending.rawProps.find((candidate) => candidate.name === field.name);
    if (raw) return rawPropFrom(raw, values[field.name]);
    const prop = jsValueProp(field.name, values[field.name], field.required === true);
    return prop ? [prop] : [];
  });
  componentForm = null;
  const edited =
    slots !== undefined &&
    (slots.length !== pending.slotTexts.length ||
      slots.some(
        (slot, index) =>
          (slot.name ?? null) !== pending.slotTexts[index].name ||
          slot.text.trim() !== pending.slotTexts[index].text,
      ));
  if (pending.editing) {
    const { start, end, raw, children, kept, block } = pending.editing;
    // Saved without changes: the source stays exactly as written (prop
    // order, quotes, spacing), as on desktop.
    if (!edited && JSON.stringify(values) === pending.editing.values) {
      return { snippet: raw, range: [start, end] };
    }
    const multiline = children === null ? block : /^[ \t]*\n/.test(children);
    return {
      snippet: serializeJsx(
        pending.name,
        [...props, ...kept],
        edited ? childrenFrom(slots!, multiline) : children,
      ),
      range: [start, end],
    };
  }
  const empty = pending.hasDefaultSlot || pending.slots.length > 0 ? "\n" : null;
  const children = edited ? (childrenFrom(slots!, true) ?? empty) : empty;
  if (source && !document.hasImportFor(pending.name)) {
    document.addImport(source.importFor({ name: pending.name, path: pending.path }, document.path));
  }
  return { snippet: serializeJsx(pending.name, props, children), range: null };
}

export { fieldViews };

/**
 * Engine entry: installs the JavaScriptCore runtime, connects the transport,
 * and exposes `PostoEngine` — the object Swift drives. Every call is
 * `call(callId, method, argsJSON)`; the result comes back through
 * `__postoNative.reply(callId, {"ok": …} | {"error": "…"})`.
 */
import { fireTimer, installRuntime } from "./runtime";
import type { ValuePath } from "@posto/core/pagescms/frontmatter";
import type { ChangedFile, MediaCredential } from "@posto/ipc";
import type { EditorTab } from "../../../../packages/editor/src/editorTabs";
import {
  collectionOrder,
  collectionSettings,
  componentFormStore,
  componentFormView,
  deploymentRing,
  deploymentStatus,
  finishComponent,
  listCdnImages,
  listComponents,
  openComponentAt,
  openComponentForm,
  saveCollectionOrder,
  saveCdnCredential,
  saveCollectionSettings,
  saveFieldTemplate,
  type SlotText,
} from "./extras";
import type { FieldTemplateSchema } from "@posto/core/pagescms/config";
import type { CdnSource } from "@posto/core/media/sources";
import type { FormStore } from "./forms";
import {
  dispatchBackendEvent,
  errorMessage,
  invoke,
  notify,
  onBackendEvent,
  setNotifier,
  setTransport,
} from "./host";
import { expandFieldTemplate } from "@posto/core/pagescms/config";
import { dateControls, dateFromControl } from "./dates";
import { rememberConvertedSource } from "./ipc";
import {
  cancelReferenceDraft,
  finishReferenceDraft,
  referenceDraftForm,
  referenceDraftScope,
  startReferenceDraft,
} from "./references";
import { fieldAt, selectValues } from "../../../../packages/editor/src/formModel";
import type { Field } from "@posto/core/pagescms/config";
import type { DocumentSession, FieldScope } from "./document";
import { MediaSession } from "./media";
import { RepoSession, type RepoIdentity } from "./repo";
import { pageOnSite, seoPreview, siteUrl } from "./site";

installRuntime();

type Args = Record<string, unknown>;
type Method = (args: Args) => unknown;

let repo: RepoSession | null = null;
let media: MediaSession | null = null;
let demo = false;

function requireRepo(): RepoSession {
  if (!repo) throw new Error("No repository is open");
  return repo;
}

/** The open document, when it's still the one an edit was typed into: a
 * debounced edit that arrives after the user switched files must not land
 * in the next file. Compared by session, which a template rename keeps. */
function requireOpen(session: unknown): DocumentSession {
  const document = requireRepo().requireDocument();
  if (typeof session === "number" && document.session !== session) {
    throw new Error("That file is no longer open.");
  }
  return document;
}

function requireMedia(): MediaSession {
  if (!media) media = new MediaSession(requireRepo());
  return media;
}

function path(args: Args): ValuePath {
  return args.path as ValuePath;
}

/** The form a field edit targets: the open document, or a metadata form. */
function formFor(target: string): { store: FormStore | null; document: boolean } {
  if (target === "document") return { store: null, document: true };
  if (target === "asset") {
    const editor = requireMedia().assetEditor;
    if (!editor) throw new Error("No image is being edited");
    return { store: editor.form, document: false };
  }
  if (target === "component") return { store: componentFormStore(), document: false };
  if (target === "reference") return { store: referenceDraftForm(), document: false };
  if (target.startsWith("import:")) {
    return { store: requireMedia().importDraft(Number(target.slice(7))).form, document: false };
  }
  throw new Error(`Unknown form ${target}`);
}

/** The field a form path lands on and the scope it resolves against. The
 * document's own fields leave both to the document (undefined). */
function fieldTarget(args: Args): {
  document: DocumentSession;
  field: Field | null | undefined;
  scope: FieldScope | undefined;
} {
  const target = (args.form as string | undefined) ?? "document";
  const { store } = formFor(target);
  return {
    document: requireRepo().requireDocument(),
    field: store ? fieldAt(store.fields, path(args)) : undefined,
    scope: target === "reference" ? referenceDraftScope(requireRepo()) : undefined,
  };
}

function formResult(target: string, store: FormStore | null) {
  if (!store) return requireRepo().requireDocument().view();
  void target;
  return {
    values: store.values(),
    errors: Object.fromEntries(store.errors()),
    dates: dateControls(store.fields, store.values()),
  };
}

function formEdit(
  args: Args,
  apply: (store: FormStore) => void,
  document: (doc: ReturnType<RepoSession["requireDocument"]>) => void,
) {
  const target = (args.form as string | undefined) ?? "document";
  const { store } = formFor(target);
  if (store) apply(store);
  else document(requireRepo().requireDocument());
  return formResult(target, store);
}

const methods: Record<string, Method> = {
  // Backend passthrough, used by Swift in demo mode.
  "backend.invoke": (args) => invoke(args.command as string, args.args as Args | undefined),
  "engine.useDemo": async () => {
    const { installMockBackend } = await import("../../../../packages/ipc/src/mock");
    demo = true;
    installMockBackend();
    return null;
  },

  // Repository.
  "repo.open": async (args) => {
    await repo?.close();
    media = null;
    repo = new RepoSession(
      args.repoRoot as string,
      (args.repo as RepoIdentity | null) ?? null,
      args.local === true,
    );
    repo.developerMode = args.developerMode === true;
    await repo.open();
    return repo.view();
  },
  "repo.close": async () => {
    await repo?.close();
    repo = null;
    media = null;
    return null;
  },
  "repo.view": () => requireRepo().view(),
  "repo.refresh": async () => {
    await requireRepo().refresh();
    media?.invalidate();
    return requireRepo().view();
  },
  "repo.chooseWorkspace": async (args) => {
    await requireRepo().chooseWorkspace((args.dir as string | null) ?? null);
    media = null;
    return requireRepo().view();
  },
  "repo.showWorkspaceChooser": async () => {
    await requireRepo().showWorkspaceChooser();
    return requireRepo().view();
  },
  "repo.cancelWorkspaceChooser": () => {
    requireRepo().cancelWorkspaceChooser();
    return requireRepo().view();
  },
  "repo.listWorkspaceCandidates": () => requireRepo().listWorkspaceCandidates(),
  "repo.listChildDirectories": (args) => invoke("list_child_directories", { dir: args.dir }),
  "repo.setDeveloperMode": (args) => {
    const current = requireRepo();
    current.developerMode = args.enabled === true;
    if (!current.developerMode && current.document) current.document.setTab("content");
    current.changed();
    current.documentChanged();
    return current.view();
  },
  "repo.createFile": (args) =>
    requireRepo().createFile(
      args.groupPath as string,
      (args.dataCollection as string | null) ?? null,
    ),
  "repo.setStatus": (args) => {
    requireRepo().setStatus(
      args.message as string,
      (args.severity as "success" | "error") ?? "success",
    );
    return null;
  },
  "repo.dismissStatus": (args) => {
    requireRepo().dismissStatus(args.id as number);
    return requireRepo().view();
  },
  "repo.deleteFile": async (args) => {
    await requireRepo().deleteFile(args.key as string);
    return requireRepo().view();
  },

  // Open document.
  "doc.open": (args) => requireRepo().openFile(args.key as string),
  "doc.close": async () => {
    const session = requireRepo();
    await session.inDocumentQueue(() => session.closeDocument());
    return session.view();
  },
  "doc.view": () => requireRepo().requireDocument().view(),
  "doc.flush": async () => {
    await requireRepo().document?.flushPendingSave();
    return null;
  },
  "doc.setTab": (args) => {
    const document = requireRepo().requireDocument();
    document.setTab(args.tab as EditorTab);
    return document.view();
  },
  "doc.setBody": (args) => {
    const document = requireOpen(args.session);
    document.setBody(args.text as string);
    return { saveState: document.saveState };
  },
  "doc.setRaw": (args) => {
    const document = requireOpen(args.session);
    document.setRaw(args.text as string);
    return { saveState: document.saveState };
  },
  "doc.rename": async (args) => ({
    error: await requireRepo().renameOpenFile(args.filename as string),
    view: requireRepo().requireDocument().view(),
  }),
  "doc.refreshFilename": async () => ({
    error: await requireRepo().refreshFilename(),
    view: requireRepo().requireDocument().view(),
  }),
  "doc.delete": async () => {
    await requireRepo().deleteOpenFile();
    return requireRepo().view();
  },
  "doc.imagePreview": (args) =>
    requireRepo()
      .requireDocument()
      .imagePreview(path(args), args.value as string),
  "doc.imageChoices": (args) => requireRepo().requireDocument().imageChoices(path(args)),
  // Image and reference fields in any form. A component's props resolve
  // against the open document, as the desktop editor's component fields do;
  // a referenced entry being created resolves against its own collection.
  "form.imageChoices": (args) => {
    const { document, field, scope } = fieldTarget(args);
    const current = (args.value as string | undefined) || undefined;
    return document.imageChoices(path(args), field, current, scope);
  },
  "form.referenceOptions": (args) => {
    const { document, field } = fieldTarget(args);
    return document.referenceOptions(path(args), field);
  },
  "form.imageValue": (args) => {
    const { document, field, scope } = fieldTarget(args);
    const current = (args.value as string | undefined) || undefined;
    return document.imageFieldValue(path(args), args.absolutePath as string, field, current, scope);
  },
  "form.imagePreview": (args) => {
    const { document, field, scope } = fieldTarget(args);
    return document.imagePreview(path(args), args.value as string, field, scope);
  },
  // A select's options when there are too many to send with the form view
  // (see INLINE_SELECT_OPTIONS). Any form; no document needed.
  "form.selectOptions": (args) => {
    const { store } = formFor((args.form as string | undefined) ?? "document");
    const fields = store ? store.fields : requireRepo().requireDocument().formFields;
    const field = fieldAt(fields, path(args));
    return field?.type === "select" ? selectValues(field) : [];
  },
  "doc.referenceOptions": (args) => requireRepo().requireDocument().referenceOptions(path(args)),
  "doc.bodyMediaValue": (args) =>
    requireRepo()
      .requireDocument()
      .bodyMediaValue(args.absolutePath as string),
  // The markdown for media picked into the body; a library image brings
  // its alt text, as on desktop.
  "doc.bodyMediaSnippet": async (args) => {
    const document = requireRepo().requireDocument();
    const absolutePath = (args.absolutePath as string | null) ?? null;
    const url = (args.url as string | null) ?? null;
    const alt =
      (args.alt as string | null) ??
      (await requireMedia().libraryImageAlt({ path: absolutePath, url }));
    return document.bodyMediaSnippet({
      absolutePath,
      url,
      kind: (args.kind as string | null) ?? null,
      alt,
      label: (args.label as string | null) ?? null,
    });
  },

  // Field edits on any form.
  "form.edit": (args) =>
    formEdit(
      args,
      (store) => store.edit(path(args), args.value === null ? undefined : args.value),
      (document) => document.edit(path(args), args.value),
    ),
  "form.listAppend": (args) =>
    formEdit(
      args,
      (store) => store.listAppend(path(args), args.value),
      (document) => document.listAppend(path(args), args.value),
    ),
  "form.listRemove": (args) =>
    formEdit(
      args,
      (store) => store.listRemove(path(args), args.index as number),
      (document) => document.listRemove(path(args), args.index as number),
    ),
  "form.listMove": (args) =>
    formEdit(
      args,
      (store) => store.listMove(path(args), args.from as number, args.to as number),
      (document) => document.listMove(path(args), args.from as number, args.to as number),
    ),

  "form.editDate": (args) => {
    const target = (args.form as string | undefined) ?? "document";
    const { store } = formFor(target);
    const values = store ? store.values() : requireRepo().requireDocument().view().form?.values;
    let current: unknown = values;
    for (const key of path(args)) {
      current =
        current && typeof current === "object"
          ? (current as Record<string | number, unknown>)[key as string | number]
          : undefined;
    }
    const value = args.control
      ? dateFromControl(args.control as string, current, args.time === true)
      : undefined;
    return methods["form.edit"]({ ...args, value: value ?? null });
  },

  /** Manual field templates: writes the template's current expansion. */
  "form.regenerate": (args) => {
    const document = requireRepo().requireDocument();
    const schemaPath = (args.path as ValuePath).filter((key) => typeof key === "string").join(".");
    const template = document.entry?.fieldSchemas?.[schemaPath]?.template;
    const values = document.view().form?.values ?? {};
    const value = template ? expandFieldTemplate(template, values) : null;
    if (value === null) return document.view();
    return methods["form.edit"]({ ...args, value });
  },

  // Creating a referenced entry from a reference field.
  "reference.start": (args) => startReferenceDraft(requireRepo(), path(args)),
  "reference.finish": async () => {
    await finishReferenceDraft(requireRepo());
    return requireRepo().requireDocument().view();
  },
  "reference.cancel": () => {
    cancelReferenceDraft();
    return null;
  },

  // Git.
  "git.checkUpstream": async () => {
    await requireRepo().git.checkUpstream();
    return requireRepo().view();
  },
  "git.refreshLocalChanges": async () => {
    await requireRepo().git.refreshLocalChanges();
    return requireRepo().view();
  },
  "git.pull": async () => {
    await requireRepo().git.pull();
    return requireRepo().view();
  },
  "git.loadChanges": async () => {
    const current = requireRepo();
    await current.document?.flushPendingSave();
    await current.git.refreshLocalChanges();
    await current.git.loadChanges();
    return current.git.publishView(scopeLabel(current));
  },
  "git.publishView": () => requireRepo().git.publishView(scopeLabel(requireRepo())),
  "git.closeChanges": () => {
    requireRepo().git.closeChanges();
    return null;
  },
  "git.revert": async (args) => {
    const current = requireRepo();
    if (await current.git.revert(args.file as ChangedFile)) {
      void current.refreshContent();
      if (await current.document?.reloadFromDisk()) current.documentChanged();
    }
    return current.git.publishView(scopeLabel(current));
  },
  "git.publish": async (args) => {
    const current = requireRepo();
    const published = await current.git.publish(args.message as string);
    return { published, view: current.git.publishView(scopeLabel(current)) };
  },
  "git.submitCredential": (args) => {
    requireRepo().git.submitCredential((args.credential as MediaCredential | null) ?? null);
    return null;
  },

  // Branches.
  "branch.load": async () => {
    await requireRepo().branches.load();
    return requireRepo().branches.branches;
  },
  // A failed switch also shows as an error notice, as the Tauri app's
  // branch errors do.
  "branch.switch": async (args) => {
    const current = requireRepo();
    await current.document?.flushPendingSave();
    const error = await current.branches.switchTo(args.name as string, {
      create: args.create === true,
    });
    if (error) current.setStatus(error, "error");
    return { error, view: current.view() };
  },
  "branch.force": async () => {
    const current = requireRepo();
    const error = await current.branches.forceSwitch();
    if (error) current.setStatus(error, "error");
    return { error, view: current.view() };
  },
  "branch.clearConflict": () => {
    requireRepo().branches.clearConflict();
    return requireRepo().view();
  },

  // Media.
  "media.tabs": () => requireMedia().tabs(),
  "media.libraryAssets": (args) => requireMedia().libraryAssets(args.library as string),
  "media.locate": (args) => requireMedia().locate(args.folder as string),
  "media.list": (args) =>
    requireMedia().list(args.tab as string, (args.directory as string) ?? "", args.reload === true),
  "media.createFolder": async (args) => {
    await requireMedia().createFolder(
      args.tab as string,
      args.directory as string,
      args.name as string,
    );
    return null;
  },
  "media.deleteItems": async (args) => {
    await requireMedia().deleteItems(
      args.tab as string,
      args.ids as string[],
      args.folders as string[],
    );
    return null;
  },
  "media.moveTargets": (args) => requireMedia().moveTargets(args.tab as string),
  "media.moveItems": async (args) => {
    await requireMedia().moveItems(
      args.tab as string,
      args.ids as string[],
      args.folders as string[],
      args.destination as string,
    );
    return null;
  },
  "media.validate": (args) =>
    requireMedia().validate(args.tab as string, args.ids as string[], args.folders as string[]),
  "media.submitCredential": (args) => {
    requireMedia().submitCredential((args.credential as MediaCredential | null) ?? null);
    return null;
  },
  "media.openAsset": (args) => requireMedia().openAsset(args.tab as string, args.id as string),
  "media.assetView": () => requireMedia().assetView(),
  "media.saveAsset": async (args) => {
    await requireMedia().saveAsset((args.filename as string | null) ?? null);
    return null;
  },
  "media.deleteAsset": async () => {
    await requireMedia().deleteEditedAsset();
    return null;
  },
  "media.closeAsset": () => {
    requireMedia().assetEditor = null;
    return null;
  },
  "media.renamePublic": async (args) => {
    await requireMedia().renamePublicFile(args.path as string, args.filename as string);
    return null;
  },
  "media.importPublic": (args) =>
    requireMedia().importPublic((args.directory as string) ?? "", args.sources as string[]),
  "media.startImport": (args) =>
    requireMedia().startImport(
      args.tab as string,
      (args.folder as string) ?? "",
      args.sources as string[],
    ),
  "media.importView": () => requireMedia().importView(),
  "media.updateDraft": (args) => {
    requireMedia().updateDraft(args.index as number, {
      filename: args.filename as string | undefined,
      metadataExtension: args.metadataExtension as "yaml" | "yml" | "json" | undefined,
    });
    return requireMedia().importView();
  },
  "media.executeImport": () => requireMedia().executeImport(),
  "media.cancelImport": () => {
    requireMedia().importer = null;
    return null;
  },
  "media.rememberConverted": (args) => {
    rememberConvertedSource(args.converted as string, args.original as string);
    return null;
  },

  // Deployments.
  "deploy.status": () => deploymentStatus(requireRepo()),
  "deploy.ring": (args) => deploymentRing(args.runs as Parameters<typeof deploymentRing>[0]),

  // The live site: its address, the open file's page on it, and the search
  // and social cards of a page Swift fetched from it.
  "repo.siteUrl": () => siteUrl(requireRepo()),
  "site.page": () => pageOnSite(requireRepo()),
  "seo.preview": (args) => seoPreview(args.html as string, args.url as string),

  // Developer-mode collection settings.
  "collections.settings": (args) => collectionSettings(requireRepo(), args.name as string),
  "collections.save": async (args) => {
    await saveCollectionSettings(
      requireRepo(),
      args as Parameters<typeof saveCollectionSettings>[1],
    );
    return requireRepo().view();
  },
  "collections.order": () => collectionOrder(requireRepo()),
  "collections.saveOrder": async (args) => {
    await saveCollectionOrder(requireRepo(), args.order as string[]);
    return requireRepo().view();
  },

  "collections.saveFieldTemplate": async (args) => {
    const current = requireRepo();
    const error = await saveFieldTemplate(
      current,
      args.fieldName as string,
      (args.schema as FieldTemplateSchema | null) ?? null,
    );
    return { error, view: current.requireDocument().view() };
  },

  // CDN browsing for image fields.
  "cdn.list": (args) =>
    listCdnImages(args.source as CdnSource, (args.prefix as string | null) ?? null),
  "cdn.saveCredential": async (args) => {
    await saveCdnCredential(args.source as CdnSource, args.credential as MediaCredential);
    return null;
  },

  // The macOS preview pane: which page shows the open file, and which file
  // a page the user browsed to belongs to.
  "preview.route": () => requireRepo().previewRoute(),
  "preview.fileForRoute": (args) => requireRepo().fileForRoute(args.route as string),

  // Cards and pills in the body editor.
  "body.embeds": (args) =>
    requireRepo()
      .requireDocument()
      .bodyEmbeds(args.text as string),
  // The image-library entry a body image shows, for its library editor.
  "body.imageAsset": (args) => requireMedia().bodyImageAsset(args.src as string),

  // MDX components.
  "components.list": () => listComponents(requireRepo()),
  "components.openAt": (args) =>
    openComponentAt(
      requireRepo(),
      args.text as string,
      args.offset as number,
      typeof args.start === "number" ? args.start : undefined,
    ),
  "components.open": (args) =>
    openComponentForm(requireRepo(), args.name as string, args.path as string),
  "components.view": () => componentFormView(),
  "components.finish": (args) =>
    finishComponent(
      requireRepo(),
      (args.slots as SlotText[] | undefined) ?? undefined,
      args.inline === true,
    ),
};

function scopeLabel(current: RepoSession): string | null {
  return current.root !== current.repoRoot ? current.root.slice(current.repoRoot.length + 1) : null;
}

/** Runs one engine method and settles it with a JSON envelope. */
export async function run(
  method: string,
  args: Args,
): Promise<{ ok: unknown } | { error: string }> {
  const handler = methods[method];
  if (!handler) return { error: `Unknown engine method: ${method}` };
  try {
    const value = await handler(args);
    return { ok: value ?? null };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

const pendingInvokes = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
let nextInvokeId = 1;

const native = globalThis.__postoNative;
if (native) {
  setTransport({
    invoke(command, args) {
      const id = nextInvokeId++;
      return new Promise((resolve, reject) => {
        pendingInvokes.set(id, { resolve, reject });
        native.invoke(id, command, JSON.stringify(args ?? {}));
      });
    },
  });
  setNotifier((name, payload) => native.emit(name, JSON.stringify(payload ?? null)));
}

// Demo-mode backend events belong to Swift's own screens (sign-in, clone).
for (const event of ["clone-progress", "auth-device-code"]) {
  onBackendEvent(event, (payload) => {
    if (demo) notify("backend-event", { event, payload });
  });
}

const engine = {
  call(callId: number, method: string, argsJSON: string): void {
    let args: Args = {};
    try {
      args = argsJSON ? (JSON.parse(argsJSON) as Args) : {};
    } catch (error) {
      native?.reply(callId, JSON.stringify({ error: `Bad arguments: ${errorMessage(error)}` }));
      return;
    }
    void run(method, args).then((response) => {
      let json: string;
      try {
        json = JSON.stringify(response);
      } catch (error) {
        json = JSON.stringify({ error: `Unserializable result: ${errorMessage(error)}` });
      }
      native?.reply(callId, json);
    });
  },
  resolveInvoke(requestId: number, responseJSON: string): void {
    const pending = pendingInvokes.get(requestId);
    if (!pending) return;
    pendingInvokes.delete(requestId);
    try {
      const response = JSON.parse(responseJSON) as { ok?: unknown; error?: string };
      if (response.error !== undefined) pending.reject(new Error(response.error));
      else pending.resolve(response.ok ?? null);
    } catch (error) {
      pending.reject(new Error(`Bad backend response: ${errorMessage(error)}`));
    }
  },
  backendEvent(name: string, payloadJSON: string): void {
    try {
      dispatchBackendEvent(name, JSON.parse(payloadJSON));
    } catch (error) {
      console.error(`Bad backend event ${name}`, error);
    }
  },
  fireTimer,
};

(globalThis as unknown as { PostoEngine: typeof engine }).PostoEngine = engine;

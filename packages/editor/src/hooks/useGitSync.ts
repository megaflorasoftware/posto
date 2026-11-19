import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CdnSource } from "@posto/core/media/sources";
import type { PagesConfig } from "@posto/core/pagescms/config";
import { invoke, publishMedia } from "@posto/ipc";
import type {
  ChangedFile,
  FileGroup,
  MediaCredential,
  MediaPublishProgress,
  MediaPublishRecovery,
} from "@posto/ipc";
import { flushRegisteredSaves } from "../autosave";
import { countPendingCdnMedia, planCdnPublish, type CdnPublishPlan } from "../cdnPublish/plan";
import { refreshImageLibraryAssets } from "./useImageLibraryAssets";

const FETCH_INTERVAL_MS = 30_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Callbacks = {
  /** Status-bar message updates ("Publishing…", results, errors). */
  onStatus: (message: string, severity: "progress" | "success" | "error") => void;
  /** Flushes pending edits to disk so git sees them. */
  beforeSync?: () => void | Promise<void>;
  /** Runs after a pull, media publish, or recovery rewrote the working tree. */
  afterPull?: (dir: string) => void | Promise<void>;
  /** When set, publish skips onStatus entirely — progress is read from the
   * `publishing` flag and only failures are reported, through this. */
  onPublishError?: (message: string) => void;
  /** The site's schemas and content, which CDN-bound media publishing reads. */
  media?: {
    config: () => PagesConfig | null;
    groups: () => FileGroup[];
  };
};

/** Where a publish is, for progress shown while the dialog stays open. */
export type PublishStage = { stage: "planning" } | { stage: "credentials" } | MediaPublishProgress;

/** A CDN source that needs a password before its images can upload. */
export interface CredentialRequest {
  source: CdnSource;
  /** Why the previous attempt was refused, if there was one. */
  error: string | null;
}

/** CDN media state the Publish dialog shows. */
export interface MediaPublishState {
  plan: CdnPublishPlan | null;
  planning: boolean;
  planError: string | null;
  stage: PublishStage | null;
  credentialRequest: CredentialRequest | null;
  submitCredential: (credential: MediaCredential | null) => void;
  publishError: string | null;
}

/** Git state for the selected root: local changes, upstream polling,
 * pull ("server wins") and publish. */
export function useGitSync(root: string | null, callbacks: Callbacks) {
  // Whether the upstream branch has commits we don't (kept fresh by the
  // 30-second fetch poll); the header offers "Fetch Changes" instead of
  // Publish while true.
  const [behindUpstream, setBehindUpstream] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const publishingRef = useRef(false);
  // Whether git reports uncommitted local changes; the header's Publish
  // button is disabled while false. Kept fresh by refreshLocalChanges (run
  // on saves via the fs watcher, deletes, reverts, pulls, …) and publish.
  const [hasLocalChanges, setHasLocalChanges] = useState(false);
  // Local images waiting for a CDN, such as after a library is switched to
  // one. They make Publish available even when git reports no changes.
  const [pendingMediaCount, setPendingMediaCount] = useState(0);
  // null while the publish modal is loading the change list.
  const [changes, setChanges] = useState<ChangedFile[] | null>(null);
  const [changesError, setChangesError] = useState<string | null>(null);
  const changedFilesRef = useRef<{ root: string; files: ChangedFile[] } | null>(null);
  const [mediaPlan, setMediaPlan] = useState<CdnPublishPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [stage, setStage] = useState<PublishStage | null>(null);
  const [credentialRequest, setCredentialRequest] = useState<CredentialRequest | null>(null);
  const credentialResolver = useRef<((credential: MediaCredential | null) => void) | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  const rootRef = useRef(root);
  const cb = useRef(callbacks);
  useLayoutEffect(() => {
    rootRef.current = root;
    cb.current = callbacks;
  }, [root, callbacks]);

  /** Fetches the remote and updates the behind-upstream flag. Errors (no
   * remote/upstream, offline) just mean there is nothing to fetch. */
  function checkUpstream(): Promise<void> {
    const dir = rootRef.current;
    if (!dir) return Promise.resolve();
    return invoke<boolean>("fetch_upstream", { root: dir })
      .then((behind) => {
        if (rootRef.current === dir) setBehindUpstream(behind);
      })
      .catch(() => {
        if (rootRef.current === dir) setBehindUpstream(false);
      });
  }

  function mediaConfig(): PagesConfig | null {
    const config = cb.current.media?.config() ?? null;
    return config?.cdnSources?.length ? config : null;
  }

  function refreshMediaLibraries(dir: string) {
    for (const library of mediaConfig()?.mediaLibraries ?? []) {
      void refreshImageLibraryAssets(dir, library);
    }
  }

  /** Resolves a publish that stopped partway, such as when the app quit while
   * uploading or pushing. */
  async function recoverInterruptedPublish(dir: string) {
    let outcome: MediaPublishRecovery;
    try {
      outcome = await invoke<MediaPublishRecovery>("media_publish_recover", { root: dir });
    } catch {
      return;
    }
    if (rootRef.current !== dir || !outcome || typeof outcome !== "object") return;
    if (outcome.state === "blocked") {
      cb.current.onStatus(outcome.message, "error");
      return;
    }
    if (outcome.state !== "rolledBack" && outcome.state !== "finalized") return;
    cb.current.onStatus(
      outcome.state === "rolledBack"
        ? "Your last publish didn't finish, so Posto undid it. Your changes are ready to publish again."
        : "Your last publish finished.",
      outcome.state === "rolledBack" ? "error" : "success",
    );
    await cb.current.afterPull?.(dir);
    refreshMediaLibraries(dir);
    await refreshLocalChanges(dir);
  }

  // Poll the remote so the header can offer "Fetch Changes" soon after
  // someone publishes elsewhere, and re-check immediately when the app
  // returns to the foreground (mobile) or the window regains visibility.
  useEffect(() => {
    if (!root) return;
    void recoverInterruptedPublish(root);
    void checkUpstream();
    const timer = setInterval(() => void checkUpstream(), FETCH_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void checkUpstream();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // checkUpstream reads the current root from rootRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  async function refreshPendingMedia(dir: string, changed: ChangedFile[]) {
    const config = mediaConfig();
    // Only a clean tree needs the scan: any change already enables Publish.
    const count =
      config && changed.length === 0 ? await countPendingCdnMedia(dir, config).catch(() => 0) : 0;
    if (rootRef.current === dir) setPendingMediaCount(count);
  }

  async function refreshLocalChanges(dir: string) {
    try {
      const changed = await invoke<ChangedFile[]>("changed_files", { root: dir });
      if (rootRef.current === dir) {
        changedFilesRef.current = { root: dir, files: changed };
        setHasLocalChanges(changed.length > 0);
        setChanges((current) => (current === null ? current : changed));
        await refreshPendingMedia(dir, changed);
      }
    } catch {
      // Status unavailable (e.g. not a git repo) — leave the button enabled
      // so publishing surfaces the real error instead of silently locking.
      if (rootRef.current === dir) setHasLocalChanges(true);
    }
  }

  async function fetchChanges() {
    const dir = rootRef.current;
    if (!dir) return;
    // Local edits must be on disk so the pull can stash-carry them.
    await cb.current.beforeSync?.();
    await flushRegisteredSaves();
    setPulling(true);
    cb.current.onStatus("Fetching changes…", "progress");
    try {
      cb.current.onStatus(await invoke<string>("pull_upstream", { root: dir }), "success");
      setBehindUpstream(false);
    } catch (e) {
      cb.current.onStatus(`Fetch failed: ${errorMessage(e)}`, "error");
    } finally {
      await cb.current.afterPull?.(dir);
      setPulling(false);
    }
  }

  /** Works out what CDN media the next publish would include, for the dialog. */
  async function previewMediaPlan(dir: string) {
    const config = mediaConfig();
    const groups = cb.current.media?.groups() ?? [];
    setPlanError(null);
    if (!config) {
      setMediaPlan(null);
      return;
    }
    setPlanning(true);
    try {
      const plan = await planCdnPublish({ root: dir, config, groups });
      if (rootRef.current === dir) setMediaPlan(plan);
    } catch (e) {
      if (rootRef.current === dir) {
        setMediaPlan(null);
        setPlanError(errorMessage(e));
      }
    } finally {
      setPlanning(false);
    }
  }

  /** (Re)loads the publish modal's change list. */
  async function loadChanges(dir: string) {
    setChangesError(null);
    setPublishError(null);
    void previewMediaPlan(dir);
    const cached = changedFilesRef.current;
    if (cached?.root === dir) {
      setChanges(cached.files);
      return;
    }
    setChanges(null);
    try {
      const changed = await invoke<ChangedFile[]>("changed_files", { root: dir });
      changedFilesRef.current = { root: dir, files: changed };
      setHasLocalChanges(changed.length > 0);
      setChanges(changed);
    } catch (e) {
      setChangesError(String(e));
    }
  }

  /** Reverts one file and reloads the change list. Returns false when the
   * revert itself failed (the caller skips its follow-up work then). */
  async function revertChange(dir: string, file: ChangedFile): Promise<boolean> {
    try {
      await invoke("revert_file", { root: dir, path: file.path, status: file.status });
    } catch (e) {
      setChangesError(String(e));
      return false;
    }
    const cached = changedFilesRef.current;
    const next = (cached?.root === dir ? cached.files : (changes ?? [])).filter(
      (candidate) => candidate.path !== file.path,
    );
    changedFilesRef.current = { root: dir, files: next };
    setChanges(next);
    setHasLocalChanges(next.length > 0);
    void previewMediaPlan(dir);
    return true;
  }

  function requestCredential(source: CdnSource, error: string | null) {
    return new Promise<MediaCredential | null>((resolve) => {
      credentialResolver.current = resolve;
      setStage({ stage: "credentials" });
      setCredentialRequest({ source, error });
    });
  }

  function submitCredential(credential: MediaCredential | null) {
    const resolve = credentialResolver.current;
    credentialResolver.current = null;
    setCredentialRequest(null);
    resolve?.(credential);
  }

  /** Asks for any missing passwords. Returns false if the user cancels. */
  async function ensureCredentials(sources: CdnSource[]): Promise<boolean> {
    for (const source of sources) {
      if (await invoke<boolean>("media_credential_exists", { source })) continue;
      let refusal: string | null = null;
      for (;;) {
        const credential = await requestCredential(source, refusal);
        if (!credential) return false;
        setStage({ stage: "planning" });
        try {
          await invoke("media_credential_save", {
            source,
            credential,
            prefix: source.prefix ?? "",
          });
          break;
        } catch (e) {
          refusal = errorMessage(e);
        }
      }
    }
    return true;
  }

  /** Publishes once. Returns the result message, or null if the user
   * cancelled before anything was uploaded or committed. */
  async function publishOnce(dir: string, message: string): Promise<string | null> {
    const config = mediaConfig();
    if (!config) return invoke<string>("publish", { root: dir, message });
    setStage({ stage: "planning" });
    const plan = await planCdnPublish({
      root: dir,
      config,
      groups: cb.current.media?.groups() ?? [],
    });
    setMediaPlan(plan);
    if (plan.blockers.length > 0) throw new Error(plan.blockers.join(" "));
    if (plan.uploads.length === 0) return invoke<string>("publish", { root: dir, message });
    const sources = (config.cdnSources ?? []).filter((source) =>
      plan.uploads.some((upload) => upload.sourceName === source.name),
    );
    if (!(await ensureCredentials(sources))) return null;
    try {
      const summary = await publishMedia(
        {
          root: dir,
          message,
          sources,
          uploads: plan.uploads,
          writes: plan.writes,
          removals: plan.removals,
        },
        setStage,
      );
      const kept = summary.kept.length;
      return kept === 0
        ? summary.message
        : `${summary.message} ${kept} ${kept === 1 ? "image" : "images"} that git ignores stayed on this device.`;
    } finally {
      // Content was rewritten, or restored after a failure.
      await cb.current.afterPull?.(dir);
      refreshMediaLibraries(dir);
    }
  }

  async function publish(message: string) {
    const dir = rootRef.current;
    if (!dir || publishingRef.current) return false;
    publishingRef.current = true;
    const quiet = cb.current.onPublishError !== undefined;
    let published = false;
    setPublishing(true);
    setPublishError(null);
    try {
      await cb.current.beforeSync?.();
      await flushRegisteredSaves();
      if (!quiet) cb.current.onStatus("Publishing…", "progress");
      try {
        const result = await publishOnce(dir, message);
        if (result !== null) {
          published = true;
          if (!quiet || result.includes("stayed on this device")) {
            cb.current.onStatus(result, "success");
          }
        }
      } catch (e) {
        const failure = `Publish failed: ${errorMessage(e)}`;
        setPublishError(failure);
        if (quiet) cb.current.onPublishError?.(failure);
        else cb.current.onStatus(failure, "error");
      }
      // Committing doesn't touch watched files, so refresh the flag directly —
      // and before clearing `publishing`, so the button lands on "Up to date"
      // without flashing an enabled "Publish…" in between.
      await refreshLocalChanges(dir);
    } finally {
      publishingRef.current = false;
      setPublishing(false);
      setStage(null);
    }
    return published;
  }

  const mediaPublish: MediaPublishState = {
    plan: mediaPlan,
    planning,
    planError,
    stage,
    credentialRequest,
    submitCredential,
    publishError,
  };

  return {
    behindUpstream,
    pulling,
    publishing,
    hasLocalChanges,
    pendingMediaCount,
    /** Publish is available for local changes or images waiting for a CDN. */
    canPublish: hasLocalChanges || pendingMediaCount > 0,
    changes,
    changesError,
    mediaPublish,
    checkUpstream,
    refreshLocalChanges,
    fetchChanges,
    loadChanges,
    revertChange,
    publish,
  };
}

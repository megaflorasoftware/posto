import { useEffect, useRef, useState } from "react";
import { invoke } from "@posto/ipc";
import type { ChangedFile } from "@posto/ipc";

const FETCH_INTERVAL_MS = 30_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Callbacks = {
  /** Status-bar message updates ("Publishing…", results, errors). */
  onStatus: (message: string | null) => void;
  /** Flushes pending edits to disk so git sees them. */
  beforeSync?: () => void | Promise<void>;
  /** Runs after a pull rewrote the working tree. */
  afterPull?: (dir: string) => void | Promise<void>;
  /** When set, publish skips onStatus entirely — progress is read from the
   * `publishing` flag and only failures are reported, through this. */
  onPublishError?: (message: string) => void;
};

/** Git state for the selected root: local changes, upstream polling,
 * pull ("server wins") and publish. */
export function useGitSync(root: string | null, callbacks: Callbacks) {
  // Whether the upstream branch has commits we don't (kept fresh by the
  // 30-second fetch poll); the header offers "Fetch Changes" instead of
  // Publish while true.
  const [behindUpstream, setBehindUpstream] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [publishing, setPublishing] = useState(false);
  // Whether git reports uncommitted local changes; the header's Publish
  // button is disabled while false. Kept fresh by refreshLocalChanges (run
  // on saves via the fs watcher, deletes, reverts, pulls, …) and publish.
  const [hasLocalChanges, setHasLocalChanges] = useState(false);
  // null while the publish modal is loading the change list.
  const [changes, setChanges] = useState<ChangedFile[] | null>(null);
  const [changesError, setChangesError] = useState<string | null>(null);
  const changedFilesRef = useRef<{ root: string; files: ChangedFile[] } | null>(null);

  const rootRef = useRef(root);
  rootRef.current = root;
  const cb = useRef(callbacks);
  cb.current = callbacks;

  /** Fetches the remote and updates the behind-upstream flag. Errors (no
   * remote/upstream, offline) just mean there is nothing to fetch. */
  async function checkUpstream() {
    const dir = rootRef.current;
    if (!dir) return;
    try {
      const behind = await invoke<boolean>("fetch_upstream", { root: dir });
      if (rootRef.current === dir) setBehindUpstream(behind);
    } catch {
      if (rootRef.current === dir) setBehindUpstream(false);
    }
  }

  // Poll the remote so the header can offer "Fetch Changes" soon after
  // someone publishes elsewhere, and re-check immediately when the app
  // returns to the foreground (mobile) or the window regains visibility.
  useEffect(() => {
    if (!root) return;
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

  async function refreshLocalChanges(dir: string) {
    try {
      const changed = await invoke<ChangedFile[]>("changed_files", { root: dir });
      if (rootRef.current === dir) {
        changedFilesRef.current = { root: dir, files: changed };
        setHasLocalChanges(changed.length > 0);
        setChanges((current) => (current === null ? current : changed));
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
    setPulling(true);
    cb.current.onStatus("Fetching changes…");
    try {
      cb.current.onStatus(await invoke<string>("pull_upstream", { root: dir }));
      setBehindUpstream(false);
    } catch (e) {
      cb.current.onStatus(`Fetch failed: ${errorMessage(e)}`);
    } finally {
      await cb.current.afterPull?.(dir);
      setPulling(false);
    }
  }

  /** (Re)loads the publish modal's change list. */
  async function loadChanges(dir: string) {
    setChangesError(null);
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
    return true;
  }

  async function publish(message: string) {
    const dir = rootRef.current;
    if (!dir) return;
    await cb.current.beforeSync?.();
    const quiet = cb.current.onPublishError !== undefined;
    setPublishing(true);
    if (!quiet) cb.current.onStatus("Publishing…");
    try {
      const result = await invoke<string>("publish", { root: dir, message });
      if (!quiet) cb.current.onStatus(result);
    } catch (e) {
      if (quiet) cb.current.onPublishError?.(`Publish failed: ${errorMessage(e)}`);
      else cb.current.onStatus(`Publish failed: ${errorMessage(e)}`);
    }
    // Committing doesn't touch watched files, so refresh the flag directly —
    // and before clearing `publishing`, so the button lands on "Up to date"
    // without flashing an enabled "Publish…" in between.
    await refreshLocalChanges(dir);
    setPublishing(false);
  }

  return {
    behindUpstream,
    pulling,
    publishing,
    hasLocalChanges,
    changes,
    changesError,
    checkUpstream,
    refreshLocalChanges,
    fetchChanges,
    loadChanges,
    revertChange,
    publish,
  };
}

import { useEffect, useRef, useState } from "react";
import { invoke } from "../ipc";
import type { ChangedFile } from "../ipc";

const FETCH_INTERVAL_MS = 30_000;

type Callbacks = {
  /** Status-bar message updates ("Publishing…", results, errors). */
  onStatus: (message: string | null) => void;
  /** Flushes pending edits to disk so git sees them. */
  beforeSync?: () => void;
  /** Runs after a pull rewrote the working tree. */
  afterPull?: (dir: string) => void;
};

/** Git state for the selected root: local changes, upstream polling,
 * pull ("server wins") and publish. */
export function useGitSync(root: string | null, callbacks: Callbacks) {
  // Whether the upstream branch has commits we don't (kept fresh by the
  // 30-second fetch poll); the header offers "Fetch Changes" instead of
  // Publish while true.
  const [behindUpstream, setBehindUpstream] = useState(false);
  const [pulling, setPulling] = useState(false);
  // Whether git reports uncommitted local changes; the header's Publish
  // button is disabled while false. Kept fresh by refreshLocalChanges (run
  // on saves via the fs watcher, deletes, reverts, pulls, …) and publish.
  const [hasLocalChanges, setHasLocalChanges] = useState(false);
  // null while the publish modal is loading the change list.
  const [changes, setChanges] = useState<ChangedFile[] | null>(null);
  const [changesError, setChangesError] = useState<string | null>(null);

  const rootRef = useRef(root);
  rootRef.current = root;
  const cb = useRef(callbacks);
  cb.current = callbacks;

  // Poll the remote so the header can offer "Fetch Changes" soon after
  // someone publishes elsewhere. Errors (no remote/upstream, offline) just
  // mean there is nothing to fetch.
  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    const check = async () => {
      try {
        const behind = await invoke<boolean>("fetch_upstream", { root });
        if (!cancelled) setBehindUpstream(behind);
      } catch {
        if (!cancelled) setBehindUpstream(false);
      }
    };
    void check();
    const timer = setInterval(() => void check(), FETCH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [root]);

  async function refreshLocalChanges(dir: string) {
    try {
      const changed = await invoke<ChangedFile[]>("changed_files", { root: dir });
      if (rootRef.current === dir) setHasLocalChanges(changed.length > 0);
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
    cb.current.beforeSync?.();
    setPulling(true);
    cb.current.onStatus("Fetching changes…");
    try {
      cb.current.onStatus(await invoke<string>("pull_upstream", { root: dir }));
      setBehindUpstream(false);
    } catch (e) {
      cb.current.onStatus(`Fetch failed: ${e}`);
    } finally {
      setPulling(false);
    }
    cb.current.afterPull?.(dir);
  }

  /** (Re)loads the publish modal's change list. */
  async function loadChanges(dir: string) {
    setChanges(null);
    setChangesError(null);
    try {
      setChanges(await invoke<ChangedFile[]>("changed_files", { root: dir }));
    } catch (e) {
      setChangesError(String(e));
    }
  }

  /** Reverts one file and reloads the change list. Returns false when the
   * revert itself failed (the caller skips its follow-up work then). */
  async function revertChange(dir: string, file: ChangedFile): Promise<boolean> {
    try {
      await invoke("revert_file", { root: dir, path: file.path });
    } catch (e) {
      setChangesError(String(e));
      return false;
    }
    try {
      setChanges(await invoke<ChangedFile[]>("changed_files", { root: dir }));
    } catch (e) {
      setChangesError(String(e));
    }
    return true;
  }

  async function publish(message: string) {
    const dir = rootRef.current;
    if (!dir) return;
    cb.current.beforeSync?.();
    cb.current.onStatus("Publishing…");
    try {
      cb.current.onStatus(await invoke<string>("publish", { root: dir, message }));
    } catch (e) {
      cb.current.onStatus(`Publish failed: ${e}`);
    }
    // Committing doesn't touch watched files, so refresh the flag directly.
    void refreshLocalChanges(dir);
  }

  return {
    behindUpstream,
    pulling,
    hasLocalChanges,
    changes,
    changesError,
    refreshLocalChanges,
    fetchChanges,
    loadChanges,
    revertChange,
    publish,
  };
}

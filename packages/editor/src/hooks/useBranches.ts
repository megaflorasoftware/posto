import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@posto/ipc";
import type { BranchInfo, CheckoutOutcome } from "@posto/ipc";

/** Turns free text into a valid, conventional branch name: lowercase, spaces
 * to dashes, and the characters git ref names disallow stripped. Slashes are
 * kept so grouped names like "feature/foo" work. */
export function slugifyBranchName(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[~^:?*[\]\\@{}]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/\/{2,}/g, "/")
    .replace(/-{2,}/g, "-")
    .replace(/\.lock$/, "")
    .replace(/^[-./]+|[-./]+$/g, "");
}

type Callbacks = {
  onError: (message: string) => void;
  /** Runs after a switch rewrote the working tree. */
  onSwitched?: (dir: string) => void | Promise<void>;
};

/** A safe checkout refused because these files' unpublished changes would be
 * lost; drives the confirm-discard dialog for a forced retry. */
export type BranchConflict = { branch: string; files: string[] };

/** Branch state for the selected root: the active branch (null when the
 * chooser should hide — no repo, detached HEAD), the chooser's list, and
 * switch/create with the safe-then-confirm-force conflict flow. */
export function useBranches(root: string | null, callbacks: Callbacks) {
  const [branch, setBranch] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [switching, setSwitching] = useState(false);
  const [conflict, setConflict] = useState<BranchConflict | null>(null);
  const switchingRef = useRef(false);

  const rootRef = useRef(root);
  const cb = useRef(callbacks);
  useLayoutEffect(() => {
    rootRef.current = root;
    cb.current = callbacks;
  }, [root, callbacks]);

  useEffect(() => {
    setConflict(null);
    if (!root) {
      setBranch(null);
      setBranches([]);
      return;
    }
    let active = true;
    void invoke<string | null>("current_branch", { root })
      .then((name) => active && setBranch(name))
      .catch(() => active && setBranch(null));
    return () => {
      active = false;
    };
  }, [root]);

  /** (Re)loads the chooser's list. The local list shows immediately; a
   * best-effort background fetch then refreshes the remote-only entries, so
   * being offline just means the remote side is whatever was last fetched. */
  async function loadBranches() {
    const dir = rootRef.current;
    if (!dir) return;
    try {
      setBranches(await invoke<BranchInfo[]>("list_branches", { root: dir }));
    } catch {
      setBranches([]);
      return;
    }
    void invoke("fetch_upstream", { root: dir })
      .then(async () => {
        const refreshed = await invoke<BranchInfo[]>("list_branches", { root: dir });
        if (rootRef.current === dir) setBranches(refreshed);
      })
      .catch(() => {});
  }

  async function switchTo(
    name: string,
    options?: { create?: boolean; force?: boolean },
  ): Promise<boolean> {
    const dir = rootRef.current;
    if (!dir || switchingRef.current) return false;
    switchingRef.current = true;
    setSwitching(true);
    try {
      const outcome = await invoke<CheckoutOutcome>("checkout_branch", {
        root: dir,
        name,
        create: options?.create === true,
        force: options?.force === true,
      });
      if (!outcome.switched) {
        setConflict({ branch: name, files: outcome.conflicts });
        return false;
      }
      setConflict(null);
      if (rootRef.current === dir) setBranch(name);
      await cb.current.onSwitched?.(dir);
      return true;
    } catch (e) {
      cb.current.onError(`Could not switch branch: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    } finally {
      switchingRef.current = false;
      setSwitching(false);
    }
  }

  /** Retries the conflicted switch with force, discarding the listed edits. */
  function forceSwitch(): Promise<boolean> {
    const pending = conflict;
    setConflict(null);
    return pending ? switchTo(pending.branch, { force: true }) : Promise.resolve(false);
  }

  return {
    branch,
    branches,
    switching,
    conflict,
    clearConflict: () => setConflict(null),
    loadBranches,
    switchTo,
    forceSwitch,
  };
}

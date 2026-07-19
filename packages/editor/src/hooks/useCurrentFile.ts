import { useEffect, useRef, useState } from "react";
import { invoke } from "@posto/ipc";
import type { FileEntry } from "@posto/ipc";

const AUTOSAVE_DELAY_MS = 800;

export type SaveState = "saved" | "saving" | "error" | "invalid";

type Callbacks = {
  /** Runs after each successful write to disk. */
  onAfterSave?: (path: string, content: string) => void;
  /** Runs after a file is opened and its content loaded. */
  onOpened?: (path: string, content: string, file?: FileEntry) => void;
  onOpenError?: (message: string) => void;
};

/** The open file: load, in-memory edits, debounced autosave, save state. */
export function useCurrentFile(callbacks: Callbacks) {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [dataEntry, setDataEntry] = useState<FileEntry["dataEntry"]>(undefined);
  const [fileContent, setFileContent] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("saved");

  // Latest values for callbacks that outlive the render they were created in
  // (autosave timer, awaited file opens).
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;
  const fileContentRef = useRef(fileContent);
  fileContentRef.current = fileContent;
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  const cb = useRef(callbacks);
  cb.current = callbacks;

  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const activeSave = useRef<Promise<void> | null>(null);

  useEffect(() => {
    return () => clearTimeout(saveTimer.current);
  }, []);

  function saveNow(path: string, content: string): Promise<void> {
    setSaveState("saving");
    const previous = activeSave.current ?? Promise.resolve();
    // The target path resolves when the write actually runs, not when it was
    // scheduled: a rename queued ahead of it may have moved the file, and a
    // write to the old path would resurrect it.
    let target = path;
    const task = previous
      .then(() => {
        if (filePathRef.current !== null) target = filePathRef.current;
        return invoke("write_text_file", { path: target, content });
      })
      .then(() => {
        setSaveState("saved");
        cb.current.onAfterSave?.(target, content);
      })
      .catch(() => {
        setSaveState("error");
      })
      .finally(() => {
        if (activeSave.current === task) activeSave.current = null;
      });
    activeSave.current = task;
    return task;
  }

  /** Moves the open file on disk, queued behind any in-flight save so the
   * content lands at `from` before the move. Resolves false when the rename
   * failed (e.g. the target appeared meanwhile); the file then keeps its
   * name. */
  function renameOpenFile(from: string, to: string): Promise<boolean> {
    const previous = activeSave.current ?? Promise.resolve();
    let renamed = false;
    const task = previous
      .then(() => invoke("rename_file", { from, to }))
      .then(() => {
        renamed = true;
        // Only retarget state still pointing at the old path — the user may
        // have switched files while the rename was queued.
        if (filePathRef.current === from) {
          setFilePath(to);
          filePathRef.current = to;
          setActiveKey(to);
          activeKeyRef.current = to;
        }
      })
      .catch(() => {})
      .finally(() => {
        if (activeSave.current === task) activeSave.current = null;
      });
    activeSave.current = task;
    return task.then(() => renamed);
  }

  async function flushPendingSave() {
    if (saveTimer.current !== undefined) {
      clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
      const path = filePathRef.current;
      if (path) await saveNow(path, fileContentRef.current);
      return;
    }
    if (activeSave.current) await activeSave.current;
  }

  /** Drops a pending autosave without writing it (delete/revert flows, where
   * a late write would resurrect the file or the edits). */
  function clearPendingSave() {
    clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
  }

  function hasPendingSave() {
    return saveTimer.current !== undefined;
  }

  function onEdit(content: string) {
    setFileContent(content);
    setSaveState("saving");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = undefined;
      const path = filePathRef.current;
      if (path) void saveNow(path, content);
    }, AUTOSAVE_DELAY_MS);
  }

  // Form edits only reach disk while the form validates; invalid states keep
  // the in-memory content (so Raw shows it) but never save.
  function onFormEdit(content: string, valid: boolean) {
    if (valid) {
      onEdit(content);
    } else {
      setFileContent(content);
      clearPendingSave();
      setSaveState("invalid");
    }
  }

  async function openFile(target: string | FileEntry) {
    const file = typeof target === "string" ? undefined : target;
    const path = typeof target === "string" ? target : target.path;
    const key = file?.key ?? path;
    if (key === activeKeyRef.current) return;
    await flushPendingSave();
    if (path === filePathRef.current) {
      setActiveKey(key);
      activeKeyRef.current = key;
      setDataEntry(file?.dataEntry);
      cb.current.onOpened?.(path, fileContentRef.current, file);
      return;
    }
    try {
      const content = await invoke<string>("read_text_file", { path });
      setFilePath(path);
      filePathRef.current = path;
      setFileContent(content);
      fileContentRef.current = content;
      setActiveKey(key);
      activeKeyRef.current = key;
      setDataEntry(file?.dataEntry);
      setSaveState("saved");
      cb.current.onOpened?.(path, content, file);
    } catch (e) {
      cb.current.onOpenError?.(String(e));
    }
  }

  /** Resets to "no file selected". */
  function closeFile() {
    setFilePath(null);
    filePathRef.current = null;
    setFileContent("");
    setActiveKey(null);
    activeKeyRef.current = null;
    setDataEntry(undefined);
    fileContentRef.current = "";
    setSaveState("saved");
  }

  /** Replaces the in-memory content with what's on disk (already read). */
  function setContentFromDisk(content: string) {
    setFileContent(content);
    fileContentRef.current = content;
    setSaveState("saved");
  }

  /** Re-reads the open file after an external change (git pull, another
   * editor) — only while no local edit is pending, so the user's in-progress
   * changes are never clobbered. */
  async function reloadFromDisk() {
    const open = filePathRef.current;
    if (!open || saveTimer.current !== undefined) return;
    let content: string;
    try {
      content = await invoke<string>("read_text_file", { path: open });
    } catch {
      return; // deleted externally; the refreshed sidebar reflects it
    }
    if (
      filePathRef.current === open &&
      saveTimer.current === undefined &&
      content !== fileContentRef.current
    ) {
      setContentFromDisk(content);
    }
  }

  return {
    filePath,
    activeKey,
    dataEntry,
    filePathRef,
    fileContent,
    fileContentRef,
    saveState,
    openFile,
    closeFile,
    onEdit,
    onFormEdit,
    renameOpenFile,
    flushPendingSave,
    clearPendingSave,
    hasPendingSave,
    setContentFromDisk,
    reloadFromDisk,
  };
}

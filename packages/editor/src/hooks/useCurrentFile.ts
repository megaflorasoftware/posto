import { useEffect, useRef, useState } from "react";
import { invoke } from "@posto/ipc";

const AUTOSAVE_DELAY_MS = 800;

export type SaveState = "saved" | "saving" | "error" | "invalid";

type Callbacks = {
  /** Runs after each successful write to disk. */
  onAfterSave?: (path: string, content: string) => void;
  /** Runs after a file is opened and its content loaded. */
  onOpened?: (path: string, content: string) => void;
  onOpenError?: (message: string) => void;
};

/** The open file: load, in-memory edits, debounced autosave, save state. */
export function useCurrentFile(callbacks: Callbacks) {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("saved");

  // Latest values for callbacks that outlive the render they were created in
  // (autosave timer, awaited file opens).
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;
  const fileContentRef = useRef(fileContent);
  fileContentRef.current = fileContent;
  const cb = useRef(callbacks);
  cb.current = callbacks;

  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => clearTimeout(saveTimer.current);
  }, []);

  async function saveNow(path: string, content: string) {
    setSaveState("saving");
    try {
      await invoke("write_text_file", { path, content });
      setSaveState("saved");
      cb.current.onAfterSave?.(path, content);
    } catch {
      setSaveState("error");
    }
  }

  function flushPendingSave() {
    if (saveTimer.current !== undefined) {
      clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
      const path = filePathRef.current;
      if (path) void saveNow(path, fileContentRef.current);
    }
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

  async function openFile(path: string) {
    if (path === filePathRef.current) return;
    flushPendingSave();
    try {
      const content = await invoke<string>("read_text_file", { path });
      setFilePath(path);
      filePathRef.current = path;
      setFileContent(content);
      fileContentRef.current = content;
      setSaveState("saved");
      cb.current.onOpened?.(path, content);
    } catch (e) {
      cb.current.onOpenError?.(String(e));
    }
  }

  /** Resets to "no file selected". */
  function closeFile() {
    setFilePath(null);
    filePathRef.current = null;
    setFileContent("");
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
    filePathRef,
    fileContent,
    fileContentRef,
    saveState,
    openFile,
    closeFile,
    onEdit,
    onFormEdit,
    flushPendingSave,
    clearPendingSave,
    hasPendingSave,
    setContentFromDisk,
    reloadFromDisk,
  };
}

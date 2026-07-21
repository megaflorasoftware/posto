import { useState } from "react";
import { Pin, X } from "lucide-react";
import type { FileEntry } from "@posto/ipc";

/** Hover-revealed delete control for a sidebar file; confirms before deleting. */
function DeleteFileButton(props: { file: FileEntry; onDelete: (file: FileEntry) => void }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <button
        type="button"
        className="file-delete-confirm"
        // The pointer is already over this button (it replaces the ×);
        // leaving it without clicking cancels.
        onMouseLeave={() => setConfirming(false)}
        onClick={() => props.onDelete(props.file)}
      >
        Delete?
      </button>
    );
  }
  return (
    <button
      type="button"
      className="file-delete"
      title={`Delete ${props.file.name}`}
      aria-label={`Delete ${props.file.name}`}
      onClick={() => setConfirming(true)}
    >
      <X size={12} />
    </button>
  );
}

export function FileList(props: {
  files: FileEntry[];
  activeKey: string | null;
  /** Filenames pinned to the top of the group (`.posto` collection settings);
   * their rows get a pin marker. */
  pinned?: string[];
  onOpen: (file: FileEntry) => void;
  onDelete: (file: FileEntry) => void;
}) {
  return (
    <>
      {props.files.map((file) => (
        <div
          key={file.key ?? file.path}
          className={`file-item${props.activeKey === (file.key ?? file.path) ? " active" : ""}`}
        >
          <button className="file-item-name" onClick={() => props.onOpen(file)} title={file.name}>
            {file.title ?? file.name}
          </button>
          {props.pinned?.includes(file.name) && (
            <Pin size={12} className="file-pin" aria-label="Pinned" />
          )}
          <DeleteFileButton file={file} onDelete={props.onDelete} />
        </div>
      ))}
    </>
  );
}

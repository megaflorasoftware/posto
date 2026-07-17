import { useState } from "react";
import { X } from "lucide-react";
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
  activePath: string | null;
  onOpen: (path: string) => void;
  onDelete: (file: FileEntry) => void;
}) {
  return (
    <>
      {props.files.map((file) => (
        <div
          key={file.path}
          className={`file-item${props.activePath === file.path ? " active" : ""}`}
        >
          <button
            className="file-item-name"
            onClick={() => props.onOpen(file.path)}
            title={file.name}
          >
            {file.title ?? file.name}
          </button>
          <DeleteFileButton file={file} onDelete={props.onDelete} />
        </div>
      ))}
    </>
  );
}

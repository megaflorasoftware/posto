import { useEffect, useState } from "react";
import { Modal } from "@mantine/core";

import { invoke } from "../ipc";
import type { FileEntry } from "../ipc";
import type { MediaEntry } from "../pagescms/config";
import { mediaOutputPath } from "../pagescms/config";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "ico"];

export function ImagePicker(props: {
  root: string;
  media: MediaEntry;
  onClose: () => void;
  onPick: (outputPath: string) => void;
}) {
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const dir = props.root + "/" + props.media.input;

  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    setError(null);
    invoke<FileEntry[]>("list_dir_files", { dir, extensions: IMAGE_EXTENSIONS })
      .then((list) => {
        if (!cancelled) setFiles(list);
      })
      .catch((e) => {
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [dir]);

  return (
    <Modal opened onClose={props.onClose} title={props.media.label ?? "Choose image"}>
      {error != null && (
        <div className="picker-error">
          Could not read {props.media.input}: {String(error)}
        </div>
      )}
      {files &&
        (files.length === 0 ? (
          <div className="picker-empty">No images in {props.media.input}</div>
        ) : (
          <div className="picker-list">
            {files.map((file) => {
              const output = mediaOutputPath(props.root, props.media, file.path);
              return (
                <button
                  key={file.path}
                  className="picker-item"
                  disabled={output === null}
                  onClick={() => output !== null && props.onPick(output)}
                >
                  <span className="picker-item-name">{file.name}</span>
                  <span className="picker-item-path">{output ?? file.path}</span>
                </button>
              );
            })}
          </div>
        ))}
    </Modal>
  );
}

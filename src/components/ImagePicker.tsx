import { useEffect, useState } from "react";
import { Button, Modal } from "@mantine/core";

import { assetUrl, invoke, openPath } from "../ipc";
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
    <Modal opened onClose={props.onClose} title={props.media.label ?? "Choose image"} size="xl">
      {error != null && (
        <div className="picker-error">
          Could not read {props.media.input}: {String(error)}
        </div>
      )}
      {files &&
        (files.length === 0 ? (
          <div className="picker-empty">No images in {props.media.input}</div>
        ) : (
          <div className="picker-grid">
            {files.map((file) => {
              const output = mediaOutputPath(props.root, props.media, file.path);
              const src = assetUrl(file.path);
              return (
                <button
                  key={file.path}
                  className="picker-card"
                  disabled={output === null}
                  onClick={() => output !== null && props.onPick(output)}
                >
                  <span className="picker-card-preview">
                    {src !== null ? (
                      <img src={src} alt={file.name} loading="lazy" />
                    ) : (
                      <span className="picker-card-noimg">No preview</span>
                    )}
                  </span>
                  <span className="picker-item-name">{file.name}</span>
                  <span className="picker-item-path">{output ?? file.path}</span>
                </button>
              );
            })}
          </div>
        ))}
      <Button fullWidth variant="light" mt="sm" onClick={() => void openPath(dir)}>
        Open Media Folder
      </Button>
    </Modal>
  );
}

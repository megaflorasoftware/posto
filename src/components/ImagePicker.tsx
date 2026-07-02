import { For, Show, createResource } from "solid-js";

import "@awesome.me/webawesome/dist/components/dialog/dialog.js";

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
  const [files] = createResource(
    () => props.root + "/" + props.media.input,
    (dir) => invoke<FileEntry[]>("list_dir_files", { dir, extensions: IMAGE_EXTENSIONS }),
  );

  return (
    <wa-dialog
      attr:label={props.media.label ?? "Choose image"}
      prop:open={true}
      on:wa-hide={(e: Event) => {
        // Nested WA components (e.g. inputs) also emit wa-hide; only react to
        // the dialog's own.
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <Show when={files.error}>
        <div class="picker-error">Could not read {props.media.input}: {String(files.error)}</div>
      </Show>
      <Show when={files()}>
        {(list) => (
          <Show
            when={list().length > 0}
            fallback={<div class="picker-empty">No images in {props.media.input}</div>}
          >
            <div class="picker-list">
              <For each={list()}>
                {(file) => {
                  const output = mediaOutputPath(props.root, props.media, file.path);
                  return (
                    <button
                      class="picker-item"
                      disabled={output === null}
                      onClick={() => output !== null && props.onPick(output)}
                    >
                      <span class="picker-item-name">{file.name}</span>
                      <span class="picker-item-path">{output ?? file.path}</span>
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>
        )}
      </Show>
    </wa-dialog>
  );
}

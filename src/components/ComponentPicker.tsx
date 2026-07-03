import { useEffect, useState } from "react";
import { Loader } from "@mantine/core";
import { Spotlight, spotlight } from "@mantine/spotlight";
import { Blocks } from "lucide-react";

import { invoke } from "../ipc";
import type { FileEntry } from "../ipc";
import { componentNameFromFile } from "../mdx/mdx";

const COMPONENT_EXTENSIONS = ["astro", "tsx", "jsx", "vue", "svelte"];

/** Directories checked for framework components, in order. */
function componentDirs(root: string): string[] {
  return [root + "/src/components", root + "/components"];
}

/**
 * Searchable component palette (Mantine Spotlight). Mounted on demand: opens
 * itself on mount and reports closing through `onClose` so the parent can
 * unmount it.
 */
export function ComponentPicker(props: {
  root: string;
  onClose: () => void;
  onPick: (file: FileEntry) => void;
}) {
  const [files, setFiles] = useState<FileEntry[] | null>(null);

  useEffect(() => {
    spotlight.open();
    let cancelled = false;
    void (async () => {
      for (const dir of componentDirs(props.root)) {
        try {
          const list = await invoke<FileEntry[]>("list_dir_files", {
            dir,
            extensions: COMPONENT_EXTENSIONS,
          });
          if (list.length > 0) {
            if (!cancelled) setFiles(list);
            return;
          }
        } catch {
          // Directory doesn't exist — try the next candidate.
        }
      }
      if (!cancelled) setFiles([]);
    })();
    return () => {
      cancelled = true;
    };
  }, [props.root]);

  const actions = (files ?? []).map((file) => ({
    id: file.path,
    label: componentNameFromFile(file.name),
    description: file.path.slice(props.root.length + 1),
    leftSection: <Blocks size={16} />,
    onClick: () => props.onPick(file),
  }));

  return (
    <Spotlight
      shortcut={null}
      actions={actions}
      highlightQuery
      onSpotlightClose={props.onClose}
      searchProps={{ placeholder: "Search components…" }}
      nothingFound={
        files === null ? <Loader size="sm" /> : `No components found in ${componentDirs(props.root).join(", ")}`
      }
    />
  );
}

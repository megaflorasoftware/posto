import { useEffect, useState } from "react";
import { Loader } from "@mantine/core";
import { Spotlight, spotlight } from "@mantine/spotlight";
import { Blocks, CodeXml } from "lucide-react";

import type { ComponentRef, ComponentSchemaSource } from "@posto/core/project/adapter";
import { useProjectIO } from "../projectIO";

/**
 * Searchable component palette (Mantine Spotlight). Mounted on demand: opens
 * itself on mount and reports closing through `onClose` so the parent can
 * unmount it.
 */
export function ComponentPicker(props: {
  root: string;
  source: ComponentSchemaSource;
  onClose: () => void;
  onPick: (file: ComponentRef) => void;
  /** Picked the built-in "HTML" entry (a custom raw-HTML chip). */
  onPickHtml: () => void;
}) {
  const [files, setFiles] = useState<ComponentRef[] | null>(null);
  const projectIO = useProjectIO();

  useEffect(() => {
    spotlight.open();
    let cancelled = false;
    void (async () => {
      try {
        const list = await props.source.listComponents(props.root, projectIO);
        if (!cancelled) setFiles(list);
      } catch {
        if (!cancelled) setFiles([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectIO, props.root, props.source]);

  const actions = [
    {
      id: "__html__",
      label: "HTML",
      description: "Custom HTML element",
      leftSection: <CodeXml size={16} />,
      onClick: props.onPickHtml,
    },
    ...(files ?? []).map((file) => ({
      id: file.path,
      label: file.name,
      description: file.path.slice(props.root.length + 1),
      leftSection: <Blocks size={16} />,
      onClick: () => props.onPick(file),
    })),
  ];

  return (
    <Spotlight
      shortcut={null}
      actions={actions}
      classNames={{
        content: "component-picker-content",
        body: "component-picker-body",
        actionsList: "component-picker-actions",
        action: "component-picker-action",
        actionBody: "component-picker-action-body",
        actionLabel: "component-picker-action-label",
        actionDescription: "component-picker-action-description",
      }}
      highlightQuery
      onSpotlightClose={props.onClose}
      searchProps={{ placeholder: "Search components…" }}
      nothingFound={
        files === null ? (
          <Loader size="sm" />
        ) : (
          `No components found in ${props.source.componentDirs(props.root).join(", ")}`
        )
      }
    />
  );
}

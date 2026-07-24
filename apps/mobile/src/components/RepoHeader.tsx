import { ActionIcon, Group, Text } from "@mantine/core";
import { ChevronLeft, Code2, Menu, Trash2 } from "lucide-react";
import type { EditorTab } from "@posto/editor";

export function RepoHeader(props: {
  repoName: string;
  showEditor: boolean;
  showSettings: boolean;
  showDeployments: boolean;
  showMedia: boolean;
  choosingWorkspace: boolean;
  editorTabs: EditorTab[];
  activeTab: EditorTab;
  openFileName: string;
  onBack: () => void;
  onTabChange: (tab: EditorTab) => void;
  onOpenSettings: () => void;
  onRequestDelete: () => void;
}) {
  const title = props.showDeployments
    ? "Deployments"
    : props.showMedia
      ? "Media"
      : props.showSettings
        ? "Settings"
        : props.choosingWorkspace
          ? "Choose project"
          : props.repoName;
  return (
    <header className={`mobile-header${props.showEditor ? " mobile-editor-header" : ""}`}>
      <Group gap={0} wrap="nowrap" className="mobile-header-title">
        <ActionIcon variant="subtle" aria-label="Back" onClick={props.onBack}>
          <ChevronLeft size={22} />
        </ActionIcon>
        {!props.showEditor && (
          <Text fw={600} size="sm" truncate>
            {title}
          </Text>
        )}
      </Group>
      {props.showEditor &&
        props.editorTabs.includes("content") &&
        props.editorTabs.includes("raw") && (
          <div className="mobile-header-tabs">
            <ActionIcon
              variant="subtle"
              aria-label={props.activeTab === "raw" ? "Show visual editor" : "Show raw file"}
              title={props.activeTab === "raw" ? "Show visual editor" : "Show raw file"}
              onClick={() => props.onTabChange(props.activeTab === "raw" ? "content" : "raw")}
            >
              <Code2 size={19} />
            </ActionIcon>
          </div>
        )}
      {!props.showEditor && !props.showSettings && !props.choosingWorkspace && (
        <ActionIcon
          variant="subtle"
          aria-label="Site settings"
          title="Site settings"
          onClick={props.onOpenSettings}
        >
          <Menu size={20} />
        </ActionIcon>
      )}
      {props.showEditor && (
        <ActionIcon
          variant="subtle"
          color="red"
          aria-label={`Delete ${props.openFileName}`}
          title={`Delete ${props.openFileName}`}
          onClick={props.onRequestDelete}
        >
          <Trash2 size={19} />
        </ActionIcon>
      )}
    </header>
  );
}

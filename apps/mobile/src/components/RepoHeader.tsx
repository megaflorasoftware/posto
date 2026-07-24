import { ActionIcon, Button, Group, Tabs, Text } from "@mantine/core";
import { ChevronLeft, Menu, Trash2 } from "lucide-react";
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
  confirmingDelete: boolean;
  openFileName: string;
  onBack: () => void;
  onTabChange: (tab: EditorTab) => void;
  onOpenSettings: () => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
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
      {props.showEditor && (
        <Tabs
          className="mobile-header-tabs"
          variant="pills"
          value={props.activeTab}
          onChange={(value) => props.onTabChange(value as EditorTab)}
        >
          <Tabs.List justify="center">
            {props.editorTabs.map((tab) => (
              <Tabs.Tab key={tab} value={tab} tt="capitalize">
                {tab}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs>
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
      {props.showEditor &&
        (props.confirmingDelete ? (
          <Button
            color="red"
            variant="light"
            size="compact-md"
            className="mobile-delete-confirm"
            onClick={props.onConfirmDelete}
          >
            Delete?
          </Button>
        ) : (
          <ActionIcon
            variant="subtle"
            color="red"
            aria-label={`Delete ${props.openFileName}`}
            title={`Delete ${props.openFileName}`}
            onClick={props.onRequestDelete}
          >
            <Trash2 size={19} />
          </ActionIcon>
        ))}
    </header>
  );
}

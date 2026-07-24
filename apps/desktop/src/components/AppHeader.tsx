import { ActionIcon, Button, Menu, Tooltip } from "@mantine/core";
import { ChevronDown, Image as ImageIcon } from "lucide-react";
import { DeploymentControl } from "./DeploymentControl";
import type { Deployment } from "../hooks/useDeployment";

/** The top bar: site chooser with recents, a media browser shortcut,
 * deployment status, and the Publish / Fetch Changes action. */
export function AppHeader(props: {
  root: string | null;
  repoRoot: string | null;
  canSwitchProject: boolean;
  recentRoots: string[];
  behindUpstream: boolean;
  pulling: boolean;
  hasLocalChanges: boolean;
  deployment: Deployment;
  canOpenMedia: boolean;
  onChooseDirectory: () => void;
  onSelectRoot: (dir: string) => void;
  onSwitchProject: () => void;
  onOpenMedia: () => void;
  onFetchChanges: () => void;
  onOpenPublish: () => void;
}) {
  const repositoryName = props.repoRoot?.split("/").filter(Boolean).pop() ?? "";
  const rootName = props.root
    ? props.repoRoot && props.root !== props.repoRoot
      ? `${repositoryName} / ${props.root.slice(props.repoRoot.length + 1)}`
      : (props.root.split("/").filter(Boolean).pop() ?? "")
    : repositoryName;
  // Dropdown entries for the recent-sites menu; the open site would be a
  // no-op, so it's left out.
  const recentOptions = props.recentRoots.filter((dir) => dir !== props.repoRoot).slice(0, 10);
  return (
    <header className="navbar">
      <Button.Group>
        <Button size="xs" variant="default" onClick={props.onChooseDirectory}>
          {props.root ? rootName : "Choose directory"}
        </Button>
        <Menu position="bottom-start" width={220}>
          <Menu.Target>
            <Button
              size="xs"
              variant="default"
              px={6}
              aria-label="Recent sites"
              disabled={recentOptions.length === 0 && !props.canSwitchProject}
            >
              <ChevronDown size={14} />
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            {props.repoRoot && props.canSwitchProject && (
              <>
                <Menu.Label>Current repository</Menu.Label>
                <Menu.Item onClick={props.onSwitchProject}>Switch project…</Menu.Item>
              </>
            )}
            <Menu.Label>Recent sites</Menu.Label>
            {recentOptions.map((dir) => (
              <Menu.Item key={dir} title={dir} onClick={() => props.onSelectRoot(dir)}>
                {dir.split("/").filter(Boolean).pop()}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      </Button.Group>
      <span className="navbar-spacer" />
      {props.root && <DeploymentControl deployment={props.deployment} />}
      {props.root && (
        <Tooltip label={props.canOpenMedia ? "Media" : "No media libraries found"} openDelay={400}>
          <ActionIcon
            size={30}
            variant="subtle"
            color="gray"
            aria-label="Media"
            disabled={!props.canOpenMedia}
            onClick={props.onOpenMedia}
          >
            <ImageIcon size={18} />
          </ActionIcon>
        </Tooltip>
      )}
      {props.behindUpstream ? (
        <Button size="xs" color="teal" loading={props.pulling} onClick={props.onFetchChanges}>
          Fetch Changes
        </Button>
      ) : (
        <Button
          size="xs"
          disabled={!props.root || !props.hasLocalChanges}
          onClick={props.onOpenPublish}
        >
          Publish…
        </Button>
      )}
    </header>
  );
}

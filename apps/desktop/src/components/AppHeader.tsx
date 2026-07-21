import { ActionIcon, Button, Menu, Tooltip } from "@mantine/core";
import { ChevronDown, Globe } from "lucide-react";
import { openUrl } from "@posto/ipc";
import { DeploymentControl } from "./DeploymentControl";
import type { Deployment } from "../hooks/useDeployment";

/** The top bar: site chooser with recents, status message, deployment status,
 * an open-live-site shortcut, and the Publish / Fetch Changes action. */
export function AppHeader(props: {
  root: string | null;
  recentRoots: string[];
  status: string | null;
  behindUpstream: boolean;
  pulling: boolean;
  hasLocalChanges: boolean;
  deployment: Deployment;
  siteUrl: string | null;
  onChooseDirectory: () => void;
  onSelectRoot: (dir: string) => void;
  onFetchChanges: () => void;
  onOpenPublish: () => void;
}) {
  const rootName = props.root?.split("/").filter(Boolean).pop() ?? "";
  // Dropdown entries for the recent-sites menu; the open site would be a
  // no-op, so it's left out.
  const recentOptions = props.recentRoots.filter((dir) => dir !== props.root).slice(0, 10);
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
              disabled={recentOptions.length === 0}
            >
              <ChevronDown size={14} />
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>Recent sites</Menu.Label>
            {recentOptions.map((dir) => (
              <Menu.Item key={dir} title={dir} onClick={() => props.onSelectRoot(dir)}>
                {dir.split("/").filter(Boolean).pop()}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      </Button.Group>
      <span className="navbar-status">{props.status}</span>
      {props.root && (
        <Tooltip
          label={props.siteUrl ? "Open live site" : "No live site URL found"}
          openDelay={400}
        >
          <ActionIcon
            size={30}
            variant="subtle"
            color="gray"
            aria-label="Open live site"
            disabled={!props.siteUrl}
            onClick={() => props.siteUrl && void openUrl(props.siteUrl)}
          >
            <Globe size={18} />
          </ActionIcon>
        </Tooltip>
      )}
      {props.root && <DeploymentControl deployment={props.deployment} />}
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

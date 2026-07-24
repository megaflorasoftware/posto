import { ActionIcon, Button, Tooltip } from "@mantine/core";
import { Image as ImageIcon } from "lucide-react";
import { DeploymentControl } from "./DeploymentControl";
import type { Deployment } from "../hooks/useDeployment";

/** The native-titlebar toolbar: media, deployment status, and publishing. */
export function AppHeader(props: {
  root: string | null;
  behindUpstream: boolean;
  pulling: boolean;
  hasLocalChanges: boolean;
  deployment: Deployment;
  canOpenMedia: boolean;
  onOpenMedia: () => void;
  onFetchChanges: () => void;
  onOpenPublish: () => void;
}) {
  return (
    <header className="navbar" data-tauri-drag-region>
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

import { ActionIcon, RingProgress, Tooltip, UnstyledButton } from "@mantine/core";
import { Check, CirclePlay, X } from "lucide-react";
import type { DeploymentState } from "@posto/core/github/deployment";
import type { Deployment } from "../hooks/useDeployment";

const RING_COLOR: Record<DeploymentState, string> = {
  running: "blue",
  queued: "gray",
  success: "teal",
  failure: "red",
  idle: "gray",
};

function ringTooltip(deployment: Deployment): string {
  switch (deployment.ring.state) {
    case "running":
      return `Deploying… ${Math.round(deployment.ring.value)}%`;
    case "queued":
      return "Deployment queued";
    case "success":
      return "Deployed";
    case "failure":
      return "Deployment failed";
    default:
      return "Deployment status";
  }
}

/** Header control for deployment status: a circle-play button until a repo's
 * runs are known, then a live RingProgress. Both open the drawer, where the
 * link out to the repo's GitHub Actions page lives. */
export function DeploymentControl({ deployment }: { deployment: Deployment }) {
  if (!deployment.hasRing) {
    return (
      <Tooltip label="Deployment status" openDelay={400}>
        <ActionIcon
          size={26}
          variant="subtle"
          color="gray"
          aria-label="Deployment status"
          onClick={deployment.openDrawer}
        >
          <CirclePlay size={16} />
        </ActionIcon>
      </Tooltip>
    );
  }

  const { ring } = deployment;
  const color = RING_COLOR[ring.state] ?? "gray";
  // The ring's label band is left-aligned with horizontal insets, so center the
  // icon in a full-width flex box to keep the check truly centered.
  const label = ring.done ? (
    <span className="deployment-ring-label">
      {ring.success ? (
        <Check size={10} color="var(--mantine-color-teal-6)" strokeWidth={3} />
      ) : (
        <X size={10} color="var(--mantine-color-red-6)" strokeWidth={3} />
      )}
    </span>
  ) : undefined;

  return (
    <Tooltip label={ringTooltip(deployment)} openDelay={200}>
      <UnstyledButton
        className="deployment-ring"
        aria-label="Deployment status"
        onClick={deployment.openDrawer}
      >
        <RingProgress
          size={24}
          thickness={3}
          roundCaps
          sections={[{ value: ring.value, color }]}
          label={label}
        />
      </UnstyledButton>
    </Tooltip>
  );
}

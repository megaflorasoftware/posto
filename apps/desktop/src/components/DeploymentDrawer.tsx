import {
  Alert,
  Avatar,
  Button,
  Drawer,
  Group,
  Loader,
  RingProgress,
  Stack,
  Text,
  ThemeIcon,
} from "@mantine/core";
import {
  Check,
  CirclePlay,
  Copy,
  ExternalLink,
  FolderGit2,
  Globe,
  LogOut,
  Smartphone,
  X,
} from "lucide-react";
import { useState } from "react";
import { openUrl } from "@posto/ipc";
import type { DeploymentState } from "@posto/core/github/deployment";
import type { Deployment } from "../hooks/useDeployment";

const RING_COLOR: Record<DeploymentState, string> = {
  running: "blue",
  queued: "gray",
  success: "teal",
  failure: "red",
  idle: "gray",
};

function statusText(deployment: Deployment): string {
  switch (deployment.ring.state) {
    case "running":
      return "Deploying…";
    case "queued":
      return "Queued";
    case "success":
      return "Deployed";
    case "failure":
      return "Deployment failed";
    default:
      return "No recent deployments";
  }
}

/** GitHub sign-in prompt, mirroring the mobile onboarding flow. */
function SignIn({ deployment }: { deployment: Deployment }) {
  return (
    <Stack gap="lg" align="center" mt="xl">
      <ThemeIcon size={56} radius="md" variant="light">
        <CirclePlay size={30} />
      </ThemeIcon>
      <Stack gap={4} align="center">
        <Text fw={600} size="lg">
          Connect GitHub
        </Text>
        <Text c="dimmed" ta="center" size="sm">
          Sign in to watch this site's deployments as they run.
        </Text>
      </Stack>
      <Button
        leftSection={<FolderGit2 size={16} />}
        loading={deployment.signingIn && !deployment.device}
        onClick={deployment.signIn}
      >
        Continue with GitHub
      </Button>
    </Stack>
  );
}

/** Device-code step: the user enters the code on github.com; sign-in resolves
 * automatically once they approve. */
function Authorizing({ deployment }: { deployment: Deployment }) {
  const [copied, setCopied] = useState(false);
  const device = deployment.device;

  if (!device) {
    return (
      <Stack gap="lg" align="center" mt="xl">
        <Loader />
        <Text c="dimmed" size="sm">
          Requesting a one-time sign-in code…
        </Text>
      </Stack>
    );
  }

  async function copyCode() {
    if (!device) return;
    await navigator.clipboard.writeText(device.user_code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Stack gap="lg" mt="md">
      <ThemeIcon size={56} radius="md" variant="light" mx="auto">
        <Smartphone size={30} />
      </ThemeIcon>
      <Text fw={600} ta="center">
        Enter this code on GitHub
      </Text>
      <button className="device-code" type="button" onClick={() => void copyCode()}>
        <span>{device.user_code}</span>
        {copied ? <Check size={20} /> : <Copy size={20} />}
      </button>
      <Button rightSection={<ExternalLink size={16} />} onClick={deployment.openVerification}>
        Open GitHub
      </Button>
      <Text size="sm" c="dimmed" ta="center">
        Posto continues automatically after you approve access.
      </Text>
    </Stack>
  );
}

/** Signed-in status: the resolved repo, a large deployment ring, and sign-out. */
function Status({ deployment }: { deployment: Deployment }) {
  const { ring, slug, user } = deployment;
  const color = RING_COLOR[ring.state] ?? "gray";
  const label =
    ring.done && slug ? (
      <span className="deployment-ring-label">
        {ring.success ? (
          <Check size={36} color="var(--mantine-color-teal-6)" strokeWidth={2.5} />
        ) : (
          <X size={36} color="var(--mantine-color-red-6)" strokeWidth={2.5} />
        )}
      </span>
    ) : ring.state === "running" ? (
      <Text ta="center" fw={700} size="lg">
        {Math.round(ring.value)}%
      </Text>
    ) : undefined;

  return (
    <Stack gap="lg">
      {user && (
        <Group gap="sm">
          <Avatar src={user.avatar_url} alt={user.name} radius="xl" size={36} />
          <div>
            <Text fw={600} size="sm">
              {user.name}
            </Text>
            <Text c="dimmed" size="xs">
              {user.login}
            </Text>
          </div>
        </Group>
      )}

      {slug ? (
        <Stack gap="md" align="center">
          <RingProgress
            size={168}
            thickness={14}
            roundCaps
            sections={[{ value: slug ? ring.value : 0, color }]}
            label={label}
          />
          <Stack gap={2} align="center">
            <Text fw={600}>{statusText(deployment)}</Text>
            <Text c="dimmed" size="sm">
              {slug.owner}/{slug.name} · main
            </Text>
          </Stack>
          <Button
            variant="light"
            rightSection={<ExternalLink size={16} />}
            disabled={!deployment.actionsUrl}
            onClick={deployment.openActions}
          >
            View on GitHub Actions
          </Button>
        </Stack>
      ) : (
        <Alert color="gray" variant="light" icon={<FolderGit2 size={18} />}>
          This site has no GitHub repository, so there's no deployment to track. Open a site whose
          origin remote points at GitHub to see its progress.
        </Alert>
      )}

      <Button
        variant="subtle"
        color="gray"
        leftSection={<LogOut size={16} />}
        onClick={deployment.signOut}
      >
        Sign out
      </Button>
    </Stack>
  );
}

/** Right-side drawer for the GitHub deployment integration: an open-live-site
 * shortcut, login when signed out, deployment status once connected. */
export function DeploymentDrawer({
  deployment,
  siteUrl,
}: {
  deployment: Deployment;
  siteUrl: string | null;
}) {
  const authorizing = deployment.signingIn || deployment.device !== null;

  return (
    <Drawer
      opened={deployment.drawerOpen}
      onClose={deployment.closeDrawer}
      position="right"
      size={360}
      title="Deployments"
    >
      <Stack gap="md">
        {deployment.error && (
          <Alert color="red" variant="light">
            {deployment.error}
          </Alert>
        )}
        {siteUrl && (
          <Button
            variant="light"
            leftSection={<Globe size={16} />}
            onClick={() => void openUrl(siteUrl)}
          >
            Open Site
          </Button>
        )}
        {deployment.signedIn ? (
          <Status deployment={deployment} />
        ) : authorizing ? (
          <Authorizing deployment={deployment} />
        ) : (
          <SignIn deployment={deployment} />
        )}
      </Stack>
    </Drawer>
  );
}

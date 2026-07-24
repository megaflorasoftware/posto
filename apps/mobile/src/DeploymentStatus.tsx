import { Alert, Button, RingProgress, Stack, Text } from "@mantine/core";
import { Check, ExternalLink, Globe, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { invoke, openUrl } from "@posto/ipc";
import type { WorkflowRun } from "@posto/ipc";
import { useSiteUrl } from "@posto/editor";
import {
  computeDeploymentRing,
  type DeploymentRun,
  type DeploymentState,
} from "@posto/core/github/deployment";
import type { ProjectAdapter } from "@posto/core/project/adapter";

// The deployment ring tracks the default branch's own pipeline.
const BRANCH = "main";
const POLL_INTERVAL_MS = 15_000;
const TICK_INTERVAL_MS = 1_000;

const RING_COLOR: Record<DeploymentState, string> = {
  running: "blue",
  queued: "gray",
  success: "teal",
  failure: "red",
  idle: "gray",
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toDeploymentRun(run: WorkflowRun): DeploymentRun {
  return {
    workflowId: run.workflow_id,
    status: run.status,
    conclusion: run.conclusion,
    runStartedAt: run.run_started_at,
    updatedAt: run.updated_at,
    createdAt: run.created_at,
  };
}

function statusText(state: DeploymentState): string {
  switch (state) {
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

/** Live deployment status for `owner/name` on `main`: polls recent GitHub
 * Actions runs and renders the same ring the desktop app shows, as a full
 * mobile page. Mobile is always signed in by the time a repo is open. */
export function DeploymentStatus({
  owner,
  name,
  root,
  adapter,
  siteUrlVersion,
}: {
  owner: string;
  name: string;
  root: string;
  adapter: ProjectAdapter;
  siteUrlVersion: number;
}) {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [pagesUrl, setPagesUrl] = useState<string | null>(null);
  const siteUrl = useSiteUrl(root, adapter, siteUrlVersion);

  useEffect(() => {
    let active = true;
    setPagesUrl(null);
    void invoke<string | null>("github_pages_url", { owner, name })
      .then((url) => {
        if (active) setPagesUrl(url);
      })
      .catch(() => {
        if (active) setPagesUrl(null);
      });
    return () => {
      active = false;
    };
  }, [owner, name]);

  useEffect(() => {
    let active = true;
    const load = () =>
      invoke<WorkflowRun[]>("list_workflow_runs", { owner, name, branch: BRANCH })
        .then((next) => {
          if (!active) return;
          setRuns(next);
          setNow(Date.now());
          setError(null);
        })
        .catch((e) => active && setError(message(e)));
    void load();
    const id = window.setInterval(load, POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [owner, name]);

  const latest = runs[0] ?? null;
  const running = latest !== null && latest.status !== "completed";

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [running]);

  const ring = useMemo(() => computeDeploymentRing(runs.map(toDeploymentRun), now), [runs, now]);
  const actionsUrl = `https://github.com/${owner}/${name}/actions`;
  const liveSiteUrl = siteUrl ?? pagesUrl;
  const color = RING_COLOR[ring.state] ?? "gray";
  const label = ring.done ? (
    <span className="deployment-ring-label">
      {ring.success ? (
        <Check size={48} color="var(--mantine-color-teal-6)" strokeWidth={2.5} />
      ) : (
        <X size={48} color="var(--mantine-color-red-6)" strokeWidth={2.5} />
      )}
    </span>
  ) : ring.state === "running" ? (
    <Text ta="center" fw={700} size="xl">
      {Math.round(ring.value)}%
    </Text>
  ) : undefined;

  return (
    <main className="mobile-deployment-screen">
      <div className="mobile-deployment-scroll">
        <Stack gap="lg" align="center">
          {error && (
            <Alert color="red" variant="light" w="100%">
              {error}
            </Alert>
          )}
          <RingProgress
            size={220}
            thickness={18}
            roundCaps
            sections={[{ value: ring.value, color }]}
            label={label}
          />
          <Stack gap={2} align="center">
            <Text fw={600} size="lg">
              {statusText(ring.state)}
            </Text>
            <Text c="dimmed" size="sm">
              {owner}/{name} · main
            </Text>
          </Stack>
          {liveSiteUrl && (
            <Button
              variant="light"
              leftSection={<Globe size={18} />}
              onClick={() => void openUrl(liveSiteUrl)}
            >
              Open Site
            </Button>
          )}
        </Stack>
      </div>
      <div className="mobile-deployment-footer">
        <Button
          fullWidth
          variant="light"
          rightSection={<ExternalLink size={18} />}
          onClick={() => void openUrl(actionsUrl)}
        >
          View on GitHub Actions
        </Button>
      </div>
    </main>
  );
}

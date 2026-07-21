import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, onAuthDeviceCode, openUrl } from "@posto/ipc";
import type {
  AuthStatus,
  DeviceAuthorization,
  GitHubSlug,
  GitHubUser,
  WorkflowRun,
} from "@posto/ipc";
import {
  computeDeploymentRing,
  type DeploymentRing,
  type DeploymentRun,
} from "@posto/core/github/deployment";

// The deployment ring tracks the default branch's own pipeline.
const BRANCH = "main";
// How often to re-fetch runs while a repo is open and signed in.
const POLL_INTERVAL_MS = 15_000;
// How often to advance an in-progress ring between fetches.
const TICK_INTERVAL_MS = 1_000;

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

export interface Deployment {
  signedIn: boolean;
  user: GitHubUser | null;
  /** The pending device-flow code, while sign-in is in progress. */
  device: DeviceAuthorization | null;
  signingIn: boolean;
  error: string | null;
  /** GitHub repo behind the open site, or null when none is found. */
  slug: GitHubSlug | null;
  latestRun: WorkflowRun | null;
  ring: DeploymentRing;
  /** True when there's a run to render a ring for. */
  hasRing: boolean;
  actionsUrl: string | null;
  drawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  signIn: () => void;
  signOut: () => void;
  openActions: () => void;
  openVerification: () => void;
  /** Re-fetch runs now — e.g. shortly after a publish triggers a new deploy. */
  refresh: () => void;
}

/** GitHub sign-in plus the deployment status of the open site's repo: resolves
 * the repo from the local remote, polls its recent Actions runs on `main`, and
 * derives the ring the header renders. */
export function useDeployment(root: string | null): Deployment {
  const [signedIn, setSignedIn] = useState(false);
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [device, setDevice] = useState<DeviceAuthorization | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slug, setSlug] = useState<GitHubSlug | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Holds the active poll's fetch so `refresh()` can trigger it off-schedule.
  const loadRunsRef = useRef<() => void>(() => {});

  // Initial auth status, and the device-code events sign-in emits.
  useEffect(() => {
    const stopDevice = onAuthDeviceCode(setDevice);
    void invoke<AuthStatus>("auth_status")
      .then((status) => {
        setSignedIn(status.signed_in);
        setUser(status.user);
      })
      .catch(() => {
        setSignedIn(false);
      });
    return stopDevice;
  }, []);

  // Resolve the open site's GitHub repo from its local remote.
  useEffect(() => {
    if (!root || !signedIn) {
      setSlug(null);
      return;
    }
    let active = true;
    void invoke<GitHubSlug | null>("github_remote", { root })
      .then((resolved) => active && setSlug(resolved))
      .catch(() => active && setSlug(null));
    return () => {
      active = false;
    };
  }, [root, signedIn]);

  // Poll the repo's recent runs while it's open and we're signed in.
  useEffect(() => {
    if (!signedIn || !slug) {
      setRuns([]);
      loadRunsRef.current = () => {};
      return;
    }
    let active = true;
    const load = () =>
      invoke<WorkflowRun[]>("list_workflow_runs", {
        owner: slug.owner,
        name: slug.name,
        branch: BRANCH,
      })
        .then((next) => {
          if (!active) return;
          setRuns(next);
          setNow(Date.now());
          setError(null);
        })
        .catch((e) => active && setError(message(e)));
    loadRunsRef.current = load;
    void load();
    const id = window.setInterval(load, POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(id);
      loadRunsRef.current = () => {};
    };
  }, [signedIn, slug]);

  const latestRun = runs[0] ?? null;
  const running = latestRun !== null && latestRun.status !== "completed";

  // Advance the fill of an in-progress run between polls.
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [running]);

  const ring = useMemo(() => computeDeploymentRing(runs.map(toDeploymentRun), now), [runs, now]);

  const actionsUrl = slug ? `https://github.com/${slug.owner}/${slug.name}/actions` : null;
  const hasRing = signedIn && slug !== null && latestRun !== null;

  const signIn = useCallback(() => {
    setError(null);
    setDevice(null);
    setSigningIn(true);
    void invoke<GitHubUser>("sign_in")
      .then((signedInUser) => {
        setUser(signedInUser);
        setSignedIn(true);
      })
      .catch((e) => setError(message(e)))
      .finally(() => {
        setSigningIn(false);
        setDevice(null);
      });
  }, []);

  const signOut = useCallback(() => {
    void invoke("sign_out").catch(() => {});
    setSignedIn(false);
    setUser(null);
    setSlug(null);
    setRuns([]);
    setDevice(null);
    setError(null);
  }, []);

  const openActions = useCallback(() => {
    if (actionsUrl) void openUrl(actionsUrl);
  }, [actionsUrl]);

  const openVerification = useCallback(() => {
    if (device) void openUrl(device.verification_uri);
  }, [device]);

  const refresh = useCallback(() => loadRunsRef.current(), []);

  return {
    signedIn,
    user,
    device,
    signingIn,
    error,
    slug,
    latestRun,
    ring,
    hasRing,
    actionsUrl,
    drawerOpen,
    openDrawer: useCallback(() => setDrawerOpen(true), []),
    closeDrawer: useCallback(() => setDrawerOpen(false), []),
    signIn,
    signOut,
    openActions,
    openVerification,
    refresh,
  };
}

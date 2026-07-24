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
  retryingCredentialAccess: boolean;
  credentialError: string | null;
  error: string | null;
  /** GitHub repo behind the open site, or null when none is found. */
  slug: GitHubSlug | null;
  latestRun: WorkflowRun | null;
  ring: DeploymentRing;
  /** True when there's a run to render a ring for. */
  hasRing: boolean;
  /** GitHub Pages URL, used when the local project declares no live URL. */
  pagesUrl: string | null;
  actionsUrl: string | null;
  drawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  signIn: () => void;
  retryCredentialAccess: () => void;
  signOut: () => void;
  openActions: () => void;
  openVerification: () => void;
  /** Re-fetch runs now — e.g. shortly after a publish triggers a new deploy. */
  refresh: () => void;
  /** Polls briefly until a run newer than the one present before publish appears. */
  expectNewRun: (sinceRunId: number | null) => void;
}

/** GitHub sign-in plus the deployment status of the open site's repo: resolves
 * the repo from the local remote, polls its recent Actions runs on `main`, and
 * derives the ring the header renders. */
export function useDeployment(root: string | null): Deployment {
  const [signedIn, setSignedIn] = useState(false);
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [device, setDevice] = useState<DeviceAuthorization | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [retryingCredentialAccess, setRetryingCredentialAccess] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slug, setSlug] = useState<GitHubSlug | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [pagesUrl, setPagesUrl] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Holds the active poll's fetch so `refresh()` can trigger it off-schedule.
  const loadRunsRef = useRef<() => Promise<WorkflowRun[] | null>>(async () => null);
  const expectationTimers = useRef<number[]>([]);
  const expectationToken = useRef(0);

  const clearExpectation = useCallback(() => {
    expectationToken.current++;
    for (const timer of expectationTimers.current) window.clearTimeout(timer);
    expectationTimers.current = [];
  }, []);

  // Initial auth status, and the device-code events sign-in emits.
  useEffect(() => {
    const stopDevice = onAuthDeviceCode(setDevice);
    void invoke<AuthStatus>("auth_status")
      .then((status) => {
        setSignedIn(status.signed_in);
        setUser(status.user);
      })
      .catch((e) => {
        setSignedIn(false);
        setCredentialError(message(e));
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

  // Resolve GitHub Pages once per repository. Local project metadata remains
  // the preferred live URL; this fills the gap for repos that declare none.
  useEffect(() => {
    if (!signedIn || !slug) {
      setPagesUrl(null);
      return;
    }
    let active = true;
    setPagesUrl(null);
    void invoke<string | null>("github_pages_url", {
      owner: slug.owner,
      name: slug.name,
    })
      .then((url) => {
        if (active) setPagesUrl(url);
      })
      .catch(() => {
        if (active) setPagesUrl(null);
      });
    return () => {
      active = false;
    };
  }, [signedIn, slug]);

  // Poll the repo's recent runs while it's open and we're signed in.
  useEffect(() => {
    if (!signedIn || !slug) {
      setRuns([]);
      loadRunsRef.current = async () => null;
      return;
    }
    let active = true;
    const load = async (): Promise<WorkflowRun[] | null> => {
      try {
        const next = await invoke<WorkflowRun[]>("list_workflow_runs", {
          owner: slug.owner,
          name: slug.name,
          branch: BRANCH,
        });
        if (!active) return null;
        setRuns(next);
        setNow(Date.now());
        setError(null);
        return next;
      } catch (e) {
        if (active) setError(message(e));
        return null;
      }
    };
    loadRunsRef.current = load;
    void load();
    const id = window.setInterval(load, POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(id);
      loadRunsRef.current = async () => null;
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
    setCredentialError(null);
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

  const retryCredentialAccess = useCallback(() => {
    setRetryingCredentialAccess(true);
    void invoke<AuthStatus>("retry_auth_status")
      .then((status) => {
        setSignedIn(status.signed_in);
        setUser(status.user);
        setCredentialError(null);
      })
      .catch((e) => {
        setSignedIn(false);
        setCredentialError(message(e));
      })
      .finally(() => setRetryingCredentialAccess(false));
  }, []);

  const signOut = useCallback(() => {
    setError(null);
    void invoke("sign_out")
      .then(() => {
        setSignedIn(false);
        setUser(null);
        setSlug(null);
        setRuns([]);
        setPagesUrl(null);
        setDevice(null);
        setCredentialError(null);
      })
      .catch((e) => setError(message(e)));
  }, []);

  const openActions = useCallback(() => {
    if (actionsUrl) void openUrl(actionsUrl);
  }, [actionsUrl]);

  const openVerification = useCallback(() => {
    if (device) void openUrl(device.verification_uri);
  }, [device]);

  const refresh = useCallback(() => loadRunsRef.current(), []);
  const expectNewRun = useCallback(
    (sinceRunId: number | null) => {
      clearExpectation();
      const token = expectationToken.current;
      for (const delay of [3_000, 8_000, 15_000]) {
        const timer = window.setTimeout(() => {
          void loadRunsRef.current().then((next) => {
            if (token !== expectationToken.current || !next) return;
            const found =
              sinceRunId === null ? next.length > 0 : next.some((run) => run.id > sinceRunId);
            if (found) clearExpectation();
          });
        }, delay);
        expectationTimers.current.push(timer);
      }
    },
    [clearExpectation],
  );

  useEffect(() => {
    clearExpectation();
    return clearExpectation;
  }, [root, clearExpectation]);

  return {
    signedIn,
    user,
    device,
    signingIn,
    retryingCredentialAccess,
    credentialError,
    error,
    slug,
    latestRun,
    ring,
    hasRing,
    pagesUrl,
    actionsUrl,
    drawerOpen,
    openDrawer: useCallback(() => setDrawerOpen(true), []),
    closeDrawer: useCallback(() => setDrawerOpen(false), []),
    signIn,
    retryCredentialAccess,
    signOut,
    openActions,
    openVerification,
    refresh,
    expectNewRun,
  };
}

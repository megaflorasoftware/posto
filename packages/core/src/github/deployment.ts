// Turns a repository's recent GitHub Actions runs into the state the desktop
// deployment ring renders. Kept free of any GitHub/IPC types so the fill math
// can be unit-tested in isolation.

/** The minimal shape of a workflow run this module reasons about. */
export interface DeploymentRun {
  /** Groups runs "of that type" for duration averaging. */
  workflowId: number;
  /** "queued" | "in_progress" | "completed" (other values treated as done). */
  status: string;
  /** "success" | "failure" | …; null while still running. */
  conclusion: string | null;
  /** When the run actually began; falls back to createdAt when absent. */
  runStartedAt: string | null;
  /** Last update — for a completed run, its finish time. */
  updatedAt: string;
  createdAt: string;
}

export type DeploymentState =
  | "idle" // no runs to show
  | "queued" // scheduled, not started
  | "running" // in progress
  | "success" // finished successfully
  | "failure"; // finished unsuccessfully (failed, cancelled, timed out, …)

export interface DeploymentRing {
  /** 0–100 for a Mantine RingProgress `value`. */
  value: number;
  state: DeploymentState;
  /** True once the latest run has finished (show a check). */
  done: boolean;
  /** Whether the finished run succeeded (drives the check's color). */
  success: boolean;
}

/** How long the ring assumes a run takes when there's no history to learn from. */
export const DEFAULT_DURATION_MS = 120_000; // 2 minutes

/** Runs never quite reach a full ring until they actually finish. */
const RUNNING_CAP = 97;

/** How many past runs "of that type" feed the duration average. */
const SAMPLE_SIZE = 3;

function ms(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * Average duration of the last {@link SAMPLE_SIZE} completed runs of
 * `workflowId`, falling back to {@link DEFAULT_DURATION_MS} when there isn't
 * enough history (or the timestamps don't yield a positive duration).
 */
export function estimateDurationMs(runs: DeploymentRun[], workflowId: number): number {
  const durations: number[] = [];
  for (const run of runs) {
    if (run.workflowId !== workflowId || run.status !== "completed") continue;
    const start = ms(run.runStartedAt ?? run.createdAt);
    const end = ms(run.updatedAt);
    const duration = end - start;
    if (Number.isFinite(duration) && duration > 0) durations.push(duration);
    if (durations.length === SAMPLE_SIZE) break;
  }
  if (durations.length === 0) return DEFAULT_DURATION_MS;
  return durations.reduce((total, value) => total + value, 0) / durations.length;
}

/**
 * Ring state for the most recent run on the branch. `runs` must be newest
 * first (as GitHub returns them); `now` is the current epoch time, passed in so
 * the caller can tick the fill forward without this module reading the clock.
 */
export function computeDeploymentRing(runs: DeploymentRun[], now: number): DeploymentRing {
  const latest = runs[0];
  if (!latest) return { value: 0, state: "idle", done: false, success: false };

  if (latest.status === "completed") {
    const success = latest.conclusion === "success";
    return { value: 100, state: success ? "success" : "failure", done: true, success };
  }

  if (latest.status === "queued") {
    return { value: 0, state: "queued", done: false, success: false };
  }

  const estimate = estimateDurationMs(runs, latest.workflowId);
  const started = ms(latest.runStartedAt ?? latest.createdAt);
  const elapsed = Math.max(0, now - started);
  const value = Math.min(RUNNING_CAP, (elapsed / estimate) * 100);
  return { value, state: "running", done: false, success: false };
}

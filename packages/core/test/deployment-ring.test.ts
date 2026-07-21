import { test } from "vitest";
import {
  DEFAULT_DURATION_MS,
  computeDeploymentRing,
  estimateDurationMs,
  type DeploymentRun,
} from "../src/github/deployment";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const NOW = Date.parse("2026-07-20T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function completed(workflowId: number, startedAgo: number, durationMs: number): DeploymentRun {
  return {
    workflowId,
    status: "completed",
    conclusion: "success",
    runStartedAt: iso(startedAgo),
    updatedAt: iso(startedAgo - durationMs),
    createdAt: iso(startedAgo),
  };
}

test("averages the last three completed runs of that workflow type", () => {
  // Averaging: last three completed runs of the workflow, ignoring older ones
  // and runs of other workflows.
  const runs: DeploymentRun[] = [
    completed(42, 100_000, 60_000),
    completed(42, 200_000, 90_000),
    completed(42, 300_000, 120_000),
    completed(42, 400_000, 999_000), // 4th — must not count
    completed(7, 150_000, 5_000), // other workflow — must not count
  ];
  assert(
    estimateDurationMs(runs, 42) === 90_000,
    "averages the last three completed runs of that workflow type",
  );
});

test("falls back to the default duration without matching history", () => {
  const runs: DeploymentRun[] = [completed(7, 100_000, 60_000)];
  assert(
    estimateDurationMs(runs, 42) === DEFAULT_DURATION_MS,
    "falls back to the default duration without matching history",
  );
});

test("an in-progress run fills proportionally to elapsed time", () => {
  const runs: DeploymentRun[] = [
    {
      workflowId: 42,
      status: "in_progress",
      conclusion: null,
      runStartedAt: iso(45_000), // 45s in
      updatedAt: iso(0),
      createdAt: iso(47_000),
    },
    completed(42, 200_000, 90_000),
    completed(42, 300_000, 90_000),
  ];
  const ring = computeDeploymentRing(runs, NOW);
  assert(ring.state === "running" && !ring.done, "an in-progress run reads as running");
  // 45s of a 90s estimate ≈ 50%.
  assert(
    Math.round(ring.value) === 50,
    `running ring fills to elapsed/estimate (got ${ring.value})`,
  );
});

test("an overrunning run never shows as complete", () => {
  const runs: DeploymentRun[] = [
    {
      workflowId: 42,
      status: "in_progress",
      conclusion: null,
      runStartedAt: iso(10_000_000),
      updatedAt: iso(0),
      createdAt: iso(10_000_000),
    },
  ];
  const ring = computeDeploymentRing(runs, NOW);
  assert(ring.value < 100 && !ring.done, "an overrunning ring never shows as complete");
});

test("completed runs show a full ring with the right success flag", () => {
  const success = computeDeploymentRing([completed(42, 60_000, 60_000)], NOW);
  assert(
    success.done && success.success && success.value === 100 && success.state === "success",
    "a successful run is done, full, and marked success",
  );

  const failed = computeDeploymentRing(
    [{ ...completed(42, 60_000, 60_000), conclusion: "failure" }],
    NOW,
  );
  assert(
    failed.done && !failed.success && failed.state === "failure",
    "a failed run is done but not marked success",
  );
});

test("no runs read as an idle, empty ring", () => {
  const ring = computeDeploymentRing([], NOW);
  assert(ring.state === "idle" && ring.value === 0 && !ring.done, "no runs reads as idle");
});

import { useEffect, useRef, useState } from "react";
import { invoke } from "../ipc";

const PING_INTERVAL_MS = 500;
const PING_TIMEOUT_MS = 60_000;

export type SetupStepId = "git" | "node" | "pm" | "deps" | "server";

export type SetupStep = {
  id: SetupStepId;
  label: string;
  status: "pending" | "active" | "done" | "error";
  detail?: string;
};

/** Result of the backend's `check_environment` command. */
type EnvCheck = {
  git_version: string | null;
  node_version: string | null;
  package_manager: string;
  package_manager_version: string | null;
  needs_node_modules: boolean;
};

export type ServerStatus =
  | { state: "idle" }
  // Environment checks/installs running (or awaiting the Install click)
  // before the dev server is up; `steps` drives the numbered checklist.
  | { state: "setup"; steps: SetupStep[]; awaitingInstall: boolean }
  | { state: "running"; port: number }
  | { state: "error"; message: string };

/** The preview's dev server: environment checks/installs, start, restart,
 * readiness polling. Desktop-only. */
export function useDevServer() {
  const [server, setServer] = useState<ServerStatus>({ state: "idle" });
  const serverRef = useRef(server);
  serverRef.current = server;

  const pingTimer = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    return () => clearInterval(pingTimer.current);
  }, []);

  function updateStep(id: SetupStepId, patch: Partial<SetupStep>) {
    setServer((s) =>
      s.state === "setup"
        ? { ...s, steps: s.steps.map((st) => (st.id === id ? { ...st, ...patch } : st)) }
        : s,
    );
  }

  function watchServer(port: number) {
    clearInterval(pingTimer.current);
    const startedAt = Date.now();
    pingTimer.current = setInterval(async () => {
      try {
        const up = await invoke<boolean>("ping_dev_server");
        if (up) {
          clearInterval(pingTimer.current);
          setServer({ state: "running", port });
        } else if (Date.now() - startedAt > PING_TIMEOUT_MS) {
          clearInterval(pingTimer.current);
          updateStep("server", {
            status: "error",
            detail: "Dev server did not start within 60 seconds.",
          });
        }
      } catch (e) {
        clearInterval(pingTimer.current);
        updateStep("server", { status: "error", detail: String(e) });
      }
    }, PING_INTERVAL_MS);
  }

  async function startServer(dir: string) {
    clearInterval(pingTimer.current);
    setServer({
      state: "setup",
      steps: [
        { id: "git", label: "Git", status: "active", detail: "Checking…" },
        { id: "node", label: "Node.js", status: "active", detail: "Checking…" },
        { id: "pm", label: "Package manager", status: "active", detail: "Checking…" },
        { id: "deps", label: "Project dependencies", status: "pending" },
        { id: "server", label: "Dev server", status: "pending" },
      ],
      awaitingInstall: false,
    });
    let env: EnvCheck;
    try {
      env = await invoke<EnvCheck>("check_environment", { root: dir });
    } catch (e) {
      setServer({ state: "error", message: String(e) });
      return;
    }
    const gitOk = env.git_version !== null;
    const nodeOk = env.node_version !== null;
    const pmOk = env.package_manager_version !== null;
    const depsOk = !env.needs_node_modules;
    const steps: SetupStep[] = [
      {
        id: "git",
        label: "Git",
        status: gitOk ? "done" : "pending",
        detail: gitOk ? env.git_version! : "Not found — will be installed",
      },
      {
        id: "node",
        label: "Node.js",
        status: nodeOk ? "done" : "pending",
        detail: nodeOk ? env.node_version! : "Not found — will be installed",
      },
      {
        id: "pm",
        label: `Package manager (${env.package_manager})`,
        status: pmOk ? "done" : "pending",
        detail: pmOk ? env.package_manager_version! : "Not found — will be installed",
      },
      {
        id: "deps",
        label: "Project dependencies",
        status: depsOk ? "done" : "pending",
        detail: depsOk ? undefined : "Will be installed",
      },
      { id: "server", label: "Dev server", status: "pending" },
    ];
    // Anything that would install waits for one explicit Install click;
    // when everything is already in place, go straight to the server.
    const needsInstall = !gitOk || !nodeOk || !pmOk || !depsOk;
    setServer({ state: "setup", steps, awaitingInstall: needsInstall });
    if (!needsInstall) void runSetup(dir, steps);
  }

  /** Runs the pending steps in order, then starts the dev server. */
  async function runSetup(dir: string, steps: SetupStep[]) {
    setServer({ state: "setup", steps, awaitingInstall: false });
    const pending = new Set(steps.filter((s) => s.status === "pending").map((s) => s.id));
    let current: SetupStepId = "git";
    try {
      if (pending.has("git")) {
        // On macOS this opens Apple's Command Line Tools dialog; the backend
        // waits for the user to finish it.
        updateStep("git", { status: "active", detail: "Installing… follow any system prompt" });
        const version = await invoke<string>("install_git");
        updateStep("git", { status: "done", detail: version });
      }
      if (pending.has("node")) {
        current = "node";
        updateStep("node", { status: "active", detail: "Installing…" });
        const version = await invoke<string>("install_node");
        updateStep("node", { status: "done", detail: version });
      }
      if (pending.has("pm")) {
        current = "pm";
        updateStep("pm", { status: "active", detail: "Installing…" });
        const version = await invoke<string>("install_package_manager", { root: dir });
        updateStep("pm", { status: "done", detail: version });
      }
      if (pending.has("deps")) {
        current = "deps";
        updateStep("deps", { status: "active", detail: "Installing…" });
        await invoke("install_dependencies", { root: dir });
        updateStep("deps", { status: "done", detail: undefined });
      }
      current = "server";
      updateStep("server", { status: "active", detail: "Starting…" });
      const port = await invoke<number>("start_dev_server", { root: dir });
      watchServer(port);
    } catch (e) {
      updateStep(current, { status: "error", detail: String(e) });
    }
  }

  async function restartServer(dir: string) {
    try {
      await invoke("stop_dev_server");
    } catch {
      // Best effort — an already-dead server shouldn't block the restart.
    }
    void startServer(dir);
  }

  return { server, serverRef, startServer, runSetup, restartServer };
}

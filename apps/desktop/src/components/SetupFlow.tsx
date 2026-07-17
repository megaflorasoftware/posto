import { useState } from "react";
import { ActionIcon, Button, CopyButton, Loader } from "@mantine/core";
import { Check, Copy, X } from "lucide-react";
import { invoke } from "@posto/ipc";
import type { SetupStep } from "../hooks/useDevServer";

/** "Show info for developers" reveal for a failed dev server start: fetches
 * the server's captured stdout/stderr only when the user asks for it. */
function DevServerLogs() {
  const [lines, setLines] = useState<string[] | null>(null);
  if (lines === null) {
    return (
      <Button
        size="xs"
        variant="subtle"
        onClick={() => void invoke<string[]>("get_dev_server_logs").then(setLines)}
      >
        Show info for developers
      </Button>
    );
  }
  return (
    <div className="dev-server-logs-wrap">
      <pre className="dev-server-logs">
        {lines.length > 0 ? lines.join("\n") : "The dev server produced no output."}
      </pre>
      <CopyButton value={lines.join("\n")}>
        {({ copied, copy }) => (
          <ActionIcon
            className="dev-server-logs-copy"
            variant="default"
            size="sm"
            title="Copy logs"
            onClick={copy}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </ActionIcon>
        )}
      </CopyButton>
    </div>
  );
}

/** The environment-setup checklist shown while the dev server isn't up:
 * check/install steps, the Install and Retry actions, failure logs. */
export function SetupFlow(props: {
  steps: SetupStep[];
  awaitingInstall: boolean;
  onInstall: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="pane-placeholder">
      <ol className="setup-steps">
        {props.steps.map((step) => (
          <li key={step.id} className={`setup-step setup-step-${step.status}`}>
            <span className="setup-step-icon">
              {step.status === "active" ? (
                <Loader size={14} />
              ) : step.status === "done" ? (
                <Check size={15} />
              ) : step.status === "error" ? (
                <X size={15} />
              ) : null}
            </span>
            <span className="setup-step-label">{step.label}</span>
            {step.detail && <span className="setup-step-detail">{step.detail}</span>}
          </li>
        ))}
      </ol>
      {props.awaitingInstall && (
        <Button size="xs" onClick={props.onInstall}>
          Install
        </Button>
      )}
      {props.steps.some((s) => s.status === "error") && (
        <Button size="xs" variant="default" onClick={props.onRetry}>
          Retry
        </Button>
      )}
      {/* Logs exist only once the server process was spawned,
          so install-step failures don't offer them. */}
      {props.steps.some((s) => s.id === "server" && s.status === "error") && <DevServerLogs />}
    </div>
  );
}

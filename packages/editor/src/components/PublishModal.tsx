import { useEffect, useState } from "react";
import { ActionIcon, Alert, Badge, Button, Loader, TextInput } from "@mantine/core";
import { Dialog } from "./Dialog";
import { Undo2 } from "lucide-react";
import type { ChangedFile } from "@posto/ipc";

// Must match the backend's fallback commit message in publish().
const DEFAULT_COMMIT_MESSAGE = "Site updates";

function statusBadge(status: string): { label: string; color: string } {
  if (status === "??") return { label: "new", color: "green" };
  switch (status[0]) {
    case "M":
      return { label: "modified", color: "yellow" };
    case "A":
      return { label: "added", color: "green" };
    case "D":
      return { label: "deleted", color: "red" };
    case "R":
      return { label: "renamed", color: "blue" };
    default:
      return { label: status, color: "gray" };
  }
}

/** Undo control for one changed file; deleting a new file confirms first. */
function RevertButton(props: { file: ChangedFile; onRevert: (file: ChangedFile) => void }) {
  const [confirming, setConfirming] = useState(false);
  const isNew = props.file.status === "??";
  if (isNew && confirming) {
    return (
      <Button
        size="compact-xs"
        color="red"
        variant="light"
        onClick={() => props.onRevert(props.file)}
        onBlur={() => setConfirming(false)}
      >
        Delete file?
      </Button>
    );
  }
  const label = isNew ? "Delete new file" : "Revert changes";
  return (
    <ActionIcon
      size="sm"
      variant="subtle"
      color="gray"
      title={label}
      aria-label={label}
      onClick={() => (isNew ? setConfirming(true) : props.onRevert(props.file))}
    >
      <Undo2 size={14} />
    </ActionIcon>
  );
}

/** The publish dialog: change list with revert controls, commit message,
 * publish button. `changes` is null while the list is loading. */
export function PublishModal(props: {
  opened: boolean;
  changes: ChangedFile[] | null;
  error: string | null;
  onClose: () => void;
  onRevert: (file: ChangedFile) => void;
  onPublish: (message: string) => void;
}) {
  const [commitMessage, setCommitMessage] = useState(DEFAULT_COMMIT_MESSAGE);

  // Every open starts from the default message, as before extraction.
  useEffect(() => {
    if (props.opened) setCommitMessage(DEFAULT_COMMIT_MESSAGE);
  }, [props.opened]);

  return (
    <Dialog opened={props.opened} onClose={props.onClose} title="Publish changes">
      {props.error !== null ? (
        <Alert color="red">Could not read changes: {props.error}</Alert>
      ) : props.changes === null ? (
        <div className="publish-loading">
          <Loader size="sm" />
        </div>
      ) : props.changes.length === 0 ? (
        <div className="publish-empty">No changes to publish.</div>
      ) : (
        <div className="publish-list">
          {props.changes.map((file) => {
            const badge = statusBadge(file.status);
            return (
              <div key={file.path} className="publish-item">
                <Badge size="sm" variant="light" color={badge.color}>
                  {badge.label}
                </Badge>
                <span className="publish-path" title={file.path}>
                  {file.path}
                </span>
                <RevertButton file={file} onRevert={props.onRevert} />
              </div>
            );
          })}
        </div>
      )}
      <TextInput
        mt="md"
        size="xs"
        label="Commit message"
        value={commitMessage}
        onChange={(e) => setCommitMessage(e.currentTarget.value)}
      />
      <Button
        fullWidth
        mt="md"
        disabled={
          props.changes === null || props.changes.length === 0 || commitMessage.trim() === ""
        }
        onClick={() => props.onPublish(commitMessage.trim())}
      >
        Publish
      </Button>
    </Dialog>
  );
}

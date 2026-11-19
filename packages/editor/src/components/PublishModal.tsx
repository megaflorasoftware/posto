import { useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Loader,
  PasswordInput,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { Dialog } from "./Dialog";
import { CloudUpload, Undo2 } from "lucide-react";
import type { ChangedFile, MediaCredential } from "@posto/ipc";
import type { CredentialRequest, MediaPublishState, PublishStage } from "../hooks/useGitSync";

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

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function publishStageLabel(stage: PublishStage): string {
  switch (stage.stage) {
    case "planning":
      return "Checking images…";
    case "credentials":
      return "Waiting for storage credentials…";
    case "uploading":
      return `Uploading ${plural(stage.total, "image", "images")} (${stage.completed} done)…`;
    case "applying":
    case "committing":
      return "Saving changes…";
    case "pushing":
      return "Publishing…";
    case "finishing":
      return "Finishing…";
  }
}

/** Undo control for one changed file; deleting a new file confirms first. */
function RevertButton(props: {
  file: ChangedFile;
  disabled?: boolean;
  onRevert: (file: ChangedFile) => void;
}) {
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
      disabled={props.disabled}
      onClick={() => (isNew ? setConfirming(true) : props.onRevert(props.file))}
    >
      <Undo2 size={14} />
    </ActionIcon>
  );
}

/** Asks for the storage password that lets this device upload images. */
function CredentialForm(props: {
  request: CredentialRequest;
  onSubmit: (credential: MediaCredential | null) => void;
}) {
  const { source } = props.request;
  const needsKeyId = source.provider === "s3";
  const [accessKeyId, setAccessKeyId] = useState(needsKeyId ? "" : undefined);
  const [secret, setSecret] = useState("");
  const name = source.label ?? source.name;
  const ready = secret.trim() !== "" && (!needsKeyId || !!accessKeyId?.trim());
  const submit = () =>
    ready &&
    props.onSubmit({
      ...(needsKeyId ? { accessKeyId: accessKeyId!.trim() } : {}),
      secret: secret.trim(),
    });
  return (
    <Stack gap="xs" className="publish-credentials">
      <Text size="sm">
        {source.provider === "bunny"
          ? `Enter the password for the ${source.bucket} storage zone to upload images to ${name}.`
          : `Enter the access key for the ${source.bucket} bucket to upload images to ${name}.`}{" "}
        It's saved in this device's keychain.
      </Text>
      {props.request.error && <Alert color="red">{props.request.error}</Alert>}
      {needsKeyId && (
        <TextInput
          size="xs"
          label="Access key ID"
          autoComplete="off"
          value={accessKeyId}
          onChange={(event) => setAccessKeyId(event.currentTarget.value)}
        />
      )}
      <PasswordInput
        size="xs"
        label={needsKeyId ? "Secret access key" : "Storage zone password"}
        autoComplete="off"
        value={secret}
        data-autofocus
        onChange={(event) => setSecret(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
      />
      <Group justify="flex-end" gap="xs">
        <Button size="xs" variant="default" onClick={() => props.onSubmit(null)}>
          Cancel
        </Button>
        <Button size="xs" disabled={!ready} onClick={submit}>
          Save and continue
        </Button>
      </Group>
    </Stack>
  );
}

/** What publishing will do with CDN media, and anything that blocks it. */
function MediaSummary(props: {
  media: MediaPublishState;
  acknowledged: boolean;
  onAcknowledge: (acknowledged: boolean) => void;
}) {
  const { plan, planning, planError } = props.media;
  if (planning && !plan) {
    return (
      <Group gap="xs" mt="sm" className="publish-media">
        <Loader size="xs" />
        <Text size="sm" c="dimmed">
          Checking images…
        </Text>
      </Group>
    );
  }
  if (planError) {
    return (
      <Alert color="red" mt="sm">
        Could not check images: {planError}
      </Alert>
    );
  }
  if (!plan || (plan.uploads.length === 0 && plan.blockers.length === 0)) return null;
  return (
    <Stack gap="xs" mt="sm" className="publish-media">
      {plan.uploads.length > 0 && (
        <Group gap="xs" wrap="nowrap">
          <CloudUpload size={16} />
          <Text size="sm">
            {plural(plan.uploads.length, "image", "images")} will upload to the CDN.
          </Text>
        </Group>
      )}
      {plan.blockers.map((blocker) => (
        <Alert key={blocker} color="red">
          {blocker}
        </Alert>
      ))}
      {plan.warnings.length > 0 && (
        <Text size="xs" c="dimmed">
          {plural(plan.warnings.length, "local image stays", "local images stay")} on this device
          because something else still uses {plan.warnings.length === 1 ? "it" : "them"}:{" "}
          {plan.warnings.map((warning) => warning.path.split("/").pop()).join(", ")}
        </Text>
      )}
      {plan.firstMigrations.length > 0 && (
        <Checkbox
          size="xs"
          checked={props.acknowledged}
          onChange={(event) => props.onAcknowledge(event.currentTarget.checked)}
          label={`${plan.firstMigrations.join(", ")} will use CDN URLs for the first time. Site templates must pass a width and height to <Image> for these images.`}
        />
      )}
    </Stack>
  );
}

/** The publish dialog: change list with revert controls, commit message,
 * publish button. `changes` is null while the list is loading. It stays open
 * while publishing, so editing waits until the publish finishes. */
export function PublishModal(props: {
  opened: boolean;
  changes: ChangedFile[] | null;
  error: string | null;
  onClose: () => void;
  onRevert: (file: ChangedFile) => void;
  onPublish: (message: string) => void;
  scopeLabel?: string;
  publishing?: boolean;
  media?: MediaPublishState;
}) {
  return <PublishModalContent key={props.opened ? "opened" : "closed"} {...props} />;
}

function PublishModalContent(props: {
  opened: boolean;
  changes: ChangedFile[] | null;
  error: string | null;
  onClose: () => void;
  onRevert: (file: ChangedFile) => void;
  onPublish: (message: string) => void;
  scopeLabel?: string;
  publishing?: boolean;
  media?: MediaPublishState;
}) {
  const [commitMessage, setCommitMessage] = useState(DEFAULT_COMMIT_MESSAGE);
  const [acknowledged, setAcknowledged] = useState(false);
  const media = props.media;
  const plan = media?.plan ?? null;
  const publishing = props.publishing ?? false;
  const credentialRequest = media?.credentialRequest ?? null;
  const pendingUploads = plan?.uploads.length ?? 0;
  const nothingToPublish =
    props.changes === null || (props.changes.length === 0 && pendingUploads === 0);
  const blocked =
    (plan?.blockers.length ?? 0) > 0 ||
    ((plan?.firstMigrations.length ?? 0) > 0 && !acknowledged) ||
    (media?.planning ?? false);

  const close = () => {
    if (credentialRequest) media?.submitCredential(null);
    else if (!publishing) props.onClose();
  };

  return (
    <Dialog opened={props.opened} onClose={close} title="Publish changes">
      {props.scopeLabel && (
        <div className="publish-scope">Showing changes in {props.scopeLabel}</div>
      )}
      {props.error !== null ? (
        <Alert color="red">Could not read changes: {props.error}</Alert>
      ) : props.changes === null ? (
        <div className="publish-loading">
          <Loader size="sm" />
        </div>
      ) : props.changes.length === 0 ? (
        <div className="publish-empty">
          {pendingUploads > 0 ? "No other changes." : "No changes to publish."}
        </div>
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
                <RevertButton file={file} disabled={publishing} onRevert={props.onRevert} />
              </div>
            );
          })}
        </div>
      )}
      {media && (
        <MediaSummary media={media} acknowledged={acknowledged} onAcknowledge={setAcknowledged} />
      )}
      {media?.publishError && (
        <Alert color="red" mt="sm">
          {media.publishError}
        </Alert>
      )}
      {credentialRequest ? (
        <CredentialForm
          key={credentialRequest.source.name + (credentialRequest.error ?? "")}
          request={credentialRequest}
          onSubmit={media!.submitCredential}
        />
      ) : (
        <>
          <TextInput
            mt="md"
            size="xs"
            label="Commit message"
            value={commitMessage}
            disabled={publishing}
            onChange={(e) => setCommitMessage(e.currentTarget.value)}
          />
          {publishing && media?.stage && (
            <Text size="sm" c="dimmed" mt="sm" className="publish-progress">
              {publishStageLabel(media.stage)}
            </Text>
          )}
          <Button
            fullWidth
            mt="md"
            loading={publishing}
            disabled={nothingToPublish || blocked || commitMessage.trim() === ""}
            onClick={() => props.onPublish(commitMessage.trim())}
          >
            Publish
          </Button>
        </>
      )}
    </Dialog>
  );
}

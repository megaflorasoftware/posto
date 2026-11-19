import { useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { Dialog } from "./Dialog";
import { CloudOff, CloudUpload, Info, Undo2 } from "lucide-react";
import type { ChangedFile } from "@posto/ipc";
import type { MediaPublishState, PublishStage } from "../hooks/useGitSync";
import type { CdnPlanWarning } from "../cdnPublish/plan";
import { CdnCredentialForm } from "./CdnCredentialForm";

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

/** Explains, grouped by cause, why some images keep their local copy or
 * don't upload. */
export function keptCopyNotes(warnings: CdnPlanWarning[]): string[] {
  const referenced = new Map<string, number>();
  const unreadable = new Map<string, number>();
  let outside = 0;
  for (const warning of warnings) {
    if (warning.reason === "referenced") {
      referenced.set(warning.by, (referenced.get(warning.by) ?? 0) + 1);
    } else if (warning.reason === "outside-library") outside += 1;
    else unreadable.set(warning.error, (unreadable.get(warning.error) ?? 0) + 1);
  }
  const copies = (count: number) =>
    count === 1 ? "The local copy of 1 image" : `Local copies of ${count} images`;
  return [
    ...[...referenced].map(
      ([by, count]) =>
        `${copies(count)} will stay after uploading, because ${by} still mentions ${count === 1 ? "it" : "them"}.`,
    ),
    ...(outside > 0
      ? [
          `${copies(outside)} will stay after uploading, because ${outside === 1 ? "it's" : "they're"} outside the library's folder.`,
        ]
      : []),
    ...[...unreadable].map(
      ([error, count]) =>
        `${plural(count, "image", "images")} couldn't be read and won't upload: ${error.replace(/\.?$/, ".")}`,
    ),
  ];
}

/** What publishing will do with CDN media, and anything that blocks it. */
function MediaSummary(props: { media: MediaPublishState }) {
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
  if (
    !plan ||
    (plan.uploads.length === 0 && plan.deletes.length === 0 && plan.blockers.length === 0)
  ) {
    return null;
  }
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
      {plan.deletes.length > 0 && (
        <Group gap="xs" wrap="nowrap">
          <CloudOff size={16} />
          <Text size="sm">
            {plural(plan.deletes.length, "deleted image", "deleted images")} will be removed from
            the CDN after publishing.
          </Text>
        </Group>
      )}
      {plan.blockers.map((blocker) => (
        <Alert key={blocker} color="red">
          {blocker}
        </Alert>
      ))}
      {keptCopyNotes(plan.warnings).map((note) => (
        <Group key={note} gap="xs" wrap="nowrap" align="flex-start">
          {/* Stays beside the first line when the note wraps. */}
          <Info size={16} style={{ flexShrink: 0, marginTop: 3 }} />
          <Text size="sm">{note}</Text>
        </Group>
      ))}
      {plan.firstMigrations.length > 0 && (
        <Text size="xs" c="dimmed">
          Astro's &lt;Image&gt; component requires a width and height value for remote images, so
          make sure you've added them.
        </Text>
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
  const media = props.media;
  const plan = media?.plan ?? null;
  const publishing = props.publishing ?? false;
  const credentialRequest = media?.credentialRequest ?? null;
  const pendingUploads = (plan?.uploads.length ?? 0) + (plan?.deletes.length ?? 0);
  const nothingToPublish =
    props.changes === null || (props.changes.length === 0 && pendingUploads === 0);
  const blocked = (plan?.blockers.length ?? 0) > 0 || (media?.planning ?? false);

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
      {media && <MediaSummary media={media} />}
      {media?.publishError && (
        <Alert color="red" mt="sm">
          {media.publishError}
        </Alert>
      )}
      {credentialRequest ? (
        <CdnCredentialForm
          key={credentialRequest.source.name + (credentialRequest.error ?? "")}
          source={credentialRequest.source}
          error={credentialRequest.error}
          purpose="upload"
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

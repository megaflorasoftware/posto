import { useState } from "react";
import { Alert, Button, Group, PasswordInput, Stack, Text, TextInput } from "@mantine/core";
import type { CdnSource } from "@posto/core/media/sources";
import type { MediaCredential } from "@posto/ipc";

/** Asks for the storage secret that lets this device reach a CDN source. It's
 * saved in the device keychain, never in the site's files. */
export function CdnCredentialForm(props: {
  source: CdnSource;
  /** Why the previous attempt was refused, if there was one. */
  error: string | null;
  purpose: "upload" | "browse";
  pending?: boolean;
  onSubmit: (credential: MediaCredential | null) => void;
}) {
  const { source } = props;
  const needsKeyId = source.provider === "s3";
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const name = source.label ?? source.name;
  const action = props.purpose === "upload" ? "upload images to" : "browse images on";
  const ready = secret.trim() !== "" && (!needsKeyId || accessKeyId.trim() !== "");
  const submit = () => {
    if (!ready) return;
    props.onSubmit({
      ...(needsKeyId ? { accessKeyId: accessKeyId.trim() } : {}),
      secret: secret.trim(),
    });
  };
  return (
    <Stack gap="xs" className="cdn-credentials">
      <Text size="sm">
        {source.provider === "bunny"
          ? `Enter the password for the ${source.bucket} storage zone to ${action} ${name}.`
          : `Enter the access key for the ${source.bucket} bucket to ${action} ${name}.`}{" "}
        It's saved in this device's keychain.
      </Text>
      {props.error && <Alert color="red">{props.error}</Alert>}
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
        <Button size="xs" disabled={!ready} loading={props.pending} onClick={submit}>
          {props.purpose === "upload" ? "Save and continue" : "Save and browse"}
        </Button>
      </Group>
    </Stack>
  );
}

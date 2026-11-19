import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Loader, Text } from "@mantine/core";
import { cdnObjectUrl, type CdnSource } from "@posto/core/media/sources";
import {
  invoke,
  listMediaObjects,
  saveMediaCredential,
  type MediaCredential,
  type MediaListing,
} from "@posto/ipc";
import { markdownMediaKind } from "../markdownMedia";
import { CachedImage } from "./CachedImage";
import { CdnCredentialForm } from "./CdnCredentialForm";
import { PickerDirectoryCard } from "./PickerDirectoryCard";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function name(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

/** Browses images already on a CDN source and picks one by its public URL. */
export function CdnObjectBrowser(props: { source: CdnSource; onPick: (url: string) => void }) {
  const root = props.source.prefix ?? "";
  const [prefix, setPrefix] = useState(root);
  const [listing, setListing] = useState<MediaListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsCredential, setNeedsCredential] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const load = useCallback(async () => {
    setListing(null);
    setError(null);
    const saved = await invoke<boolean>("media_credential_exists", { source: props.source });
    if (!saved) {
      setNeedsCredential(true);
      return;
    }
    setNeedsCredential(false);
    try {
      setListing(await listMediaObjects(props.source, prefix));
    } catch (caught) {
      setError(errorText(caught));
    }
  }, [prefix, props.source]);

  useEffect(() => {
    void load().catch((caught) => setError(errorText(caught)));
  }, [load]);

  const saveCredential = async (credential: MediaCredential | null) => {
    if (!credential) {
      setDismissed(true);
      return;
    }
    setSaving(true);
    setCredentialError(null);
    try {
      await saveMediaCredential(props.source, credential, root);
      await load();
    } catch (caught) {
      setCredentialError(errorText(caught));
    } finally {
      setSaving(false);
    }
  };

  if (needsCredential) {
    return dismissed ? (
      <Text size="sm" c="dimmed">
        Images already on {props.source.label ?? props.source.name} appear here once this device has
        its storage password.
      </Text>
    ) : (
      <CdnCredentialForm
        source={props.source}
        error={credentialError}
        purpose="browse"
        pending={saving}
        onSubmit={(credential) => void saveCredential(credential)}
      />
    );
  }
  if (error) {
    return (
      <Alert color="red">
        Could not list CDN images: {error}{" "}
        <Button size="compact-xs" variant="subtle" onClick={() => void load()}>
          Try again
        </Button>
      </Alert>
    );
  }
  if (!listing) return <Loader size="sm" />;
  const images = listing.objects.filter((object) => markdownMediaKind(object.key) === "image");
  const parent = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "";
  if (prefix === root && images.length === 0 && listing.directories.length === 0) {
    return <div className="picker-empty">No images on the CDN yet.</div>;
  }
  return (
    <div className="picker-grid">
      {prefix !== root && (
        <PickerDirectoryCard
          id={`cdn:${props.source.name}:parent:${prefix}`}
          name=".."
          path={parent}
          parent
          onOpen={() => setPrefix(parent.length >= root.length ? parent : root)}
        />
      )}
      {listing.directories.map((directory) => (
        <PickerDirectoryCard
          key={directory}
          id={`cdn:${props.source.name}:${directory}`}
          name={name(directory)}
          path={directory}
          onOpen={() => setPrefix(directory)}
        />
      ))}
      {images.map((object) => {
        const url = cdnObjectUrl(props.source, object.key);
        return (
          <button
            type="button"
            key={object.key}
            className="picker-card"
            onClick={() => props.onPick(url)}
          >
            <span className="picker-card-preview">
              <CachedImage
                path={url}
                alt={name(object.key)}
                loading="lazy"
                fallback={<span className="picker-card-noimg">No preview</span>}
              />
            </span>
            <span className="picker-item-name">{name(object.key)}</span>
          </button>
        );
      })}
    </div>
  );
}

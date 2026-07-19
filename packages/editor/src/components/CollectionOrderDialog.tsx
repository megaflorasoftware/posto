import { useEffect, useState } from "react";
import { ActionIcon, Alert, Button } from "@mantine/core";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Dialog } from "./Dialog";

import { invoke } from "@posto/ipc";
import type { ContentEntry } from "@posto/core/pagescms/config";
import { POSTO_INDEX_PATH, updatePostoIndexSource } from "@posto/core/posto/config";

/**
 * Workspace collection settings: the sidebar order of collections, saved to
 * `.posto/index.json`. The list starts in the current display order, so
 * saving without changes pins the ordering the user already sees.
 */
export function CollectionOrderDialog(props: {
  root: string;
  /** Collections in current display order (unique by name). */
  collections: ContentEntry[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [order, setOrder] = useState(() => props.collections.map((entry) => entry.name));
  // Current file text, for the round-trip: keys this dialog doesn't own
  // (per-collection settings blocks, hand-added keys) must survive.
  const [source, setSource] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const path = `${props.root}/${POSTO_INDEX_PATH}`;
  const labels = new Map(
    props.collections.map((entry) => [entry.name, entry.label ?? entry.name]),
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      let raw: string | null = null;
      try {
        raw = await invoke<string>("read_text_file", { path });
      } catch {
        // No index file yet.
      }
      if (active) setSource(raw);
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  function move(index: number, delta: number) {
    setOrder((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await invoke("write_text_file", {
        path,
        content: updatePostoIndexSource(source ?? null, order),
      });
      props.onSaved();
      props.onClose();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }

  return (
    <Dialog opened onClose={props.onClose} title="Collection order">
      {error !== null && (
        <Alert color="red" mb="sm">
          {error}
        </Alert>
      )}
      <div className="collection-order-list">
        {order.map((name, index) => (
          <div key={name} className="collection-order-row">
            <span className="collection-order-label">{labels.get(name) ?? name}</span>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={`Move ${labels.get(name) ?? name} up`}
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              <ChevronUp size={14} />
            </ActionIcon>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={`Move ${labels.get(name) ?? name} down`}
              disabled={index === order.length - 1}
              onClick={() => move(index, 1)}
            >
              <ChevronDown size={14} />
            </ActionIcon>
          </div>
        ))}
      </div>
      <Button
        fullWidth
        mt="md"
        disabled={saving || source === undefined}
        onClick={() => void save()}
      >
        Save
      </Button>
    </Dialog>
  );
}

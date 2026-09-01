import { Button, Group, List, Text } from "@mantine/core";
import { Dialog } from "./Dialog";
import type { BranchConflict } from "../hooks/useBranches";

/** Warns that switching branches would lose unpublished changes to the listed
 * files, offering cancel or an explicit discard-and-switch. */
export function BranchConflictDialog(props: {
  conflict: BranchConflict | null;
  switching: boolean;
  onCancel: () => void;
  onDiscard: () => void;
}) {
  return (
    <Dialog
      opened={props.conflict !== null}
      onClose={props.onCancel}
      title="Unpublished changes in the way"
    >
      <Text size="sm">
        Switching to <b>{props.conflict?.branch}</b> would overwrite your unpublished changes to
        these files:
      </Text>
      <List size="sm" my="sm">
        {props.conflict?.files.map((file) => (
          <List.Item key={file}>{file}</List.Item>
        ))}
      </List>
      <Text size="sm" c="dimmed">
        Publish first to keep them, or discard them and switch.
      </Text>
      <Group justify="flex-end" mt="lg">
        <Button variant="default" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button color="red" loading={props.switching} onClick={props.onDiscard}>
          Discard changes and switch
        </Button>
      </Group>
    </Dialog>
  );
}

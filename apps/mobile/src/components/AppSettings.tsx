import { Button, Stack, Switch } from "@mantine/core";
import { LogOut } from "lucide-react";
import { Dialog } from "@posto/editor";

export function AppSettings(props: {
  opened: boolean;
  developerMode: boolean;
  signingOut: boolean;
  onClose: () => void;
  onDeveloperModeChange: (enabled: boolean) => void;
  onSignOut: () => void;
}) {
  return (
    <Dialog opened={props.opened} onClose={props.onClose} title="Settings">
      <Stack gap="lg">
        <Switch
          label="Enable developer mode"
          checked={props.developerMode}
          onChange={(event) => props.onDeveloperModeChange(event.currentTarget.checked)}
        />
        <Button
          color="red"
          variant="light"
          leftSection={<LogOut size={18} />}
          loading={props.signingOut}
          onClick={props.onSignOut}
        >
          Sign out
        </Button>
      </Stack>
    </Dialog>
  );
}

import { Button, Stack, Text } from "@mantine/core";
import { ChevronRight, Trash2 } from "lucide-react";

export function RepoSettings(props: {
  hasRepository: boolean;
  mediaEnabled: boolean;
  mediaLibraryCount: number;
  projectDirectory: string;
  canSwitchProject: boolean;
  removing: boolean;
  confirmingRemove: boolean;
  onOpenDeployments: () => void;
  onOpenMedia: () => void;
  onOpenProjects: () => void;
  onRemove: () => void;
}) {
  return (
    <main className="mobile-settings-screen">
      <Stack gap="xs">
        {props.hasRepository && (
          <button
            type="button"
            className="mobile-settings-row mobile-settings-link"
            onClick={props.onOpenDeployments}
          >
            <div>
              <Text fw={600} size="sm">
                Deployments
              </Text>
              <Text c="dimmed" size="xs">
                Live GitHub Actions status
              </Text>
            </div>
            <ChevronRight size={18} />
          </button>
        )}
        {props.mediaEnabled && props.mediaLibraryCount > 0 ? (
          <button
            type="button"
            className="mobile-settings-row mobile-settings-link"
            onClick={props.onOpenMedia}
          >
            <div>
              <Text fw={600} size="sm">
                Media
              </Text>
              <Text c="dimmed" size="xs">
                {`${props.mediaLibraryCount} media ${props.mediaLibraryCount === 1 ? "library" : "libraries"}`}
              </Text>
            </div>
            <ChevronRight size={18} />
          </button>
        ) : (
          <div className="mobile-settings-row mobile-settings-media-row">
            <div>
              <Text fw={600} size="sm">
                Media
              </Text>
              <Text c="dimmed" size="xs">
                No media libraries found
              </Text>
            </div>
          </div>
        )}
        {props.canSwitchProject && (
          <button
            type="button"
            className="mobile-settings-row mobile-settings-link"
            onClick={props.onOpenProjects}
          >
            <div>
              <Text fw={600} size="sm">
                Switch project…
              </Text>
              <Text c="dimmed" size="xs">
                {props.projectDirectory}
              </Text>
            </div>
            <ChevronRight size={18} />
          </button>
        )}
      </Stack>
      <div className="mobile-settings-danger">
        <Text c="dimmed" size="xs">
          Removes this repository's downloaded copy from this device. Unpublished changes will be
          lost. You can download it again anytime.
        </Text>
        <Button
          fullWidth
          color="red"
          variant="light"
          leftSection={<Trash2 size={18} />}
          loading={props.removing}
          onClick={props.onRemove}
        >
          {props.confirmingRemove ? "Tap again to delete from device" : "Delete from device"}
        </Button>
      </div>
    </main>
  );
}

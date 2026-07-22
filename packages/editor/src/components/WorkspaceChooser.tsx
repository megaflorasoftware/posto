import { Badge, Button, Group, Stack, Text } from "@mantine/core";
import type { ProjectCandidate } from "@posto/core/project/workspace";

export function WorkspaceChooser(props: {
  repoRoot: string;
  candidates: ProjectCandidate[];
  onChoose: (candidate: ProjectCandidate) => void;
  onBrowse: () => void;
}) {
  return (
    <Stack className="workspace-chooser" gap="sm">
      <div>
        <Text fw={600}>Choose a site in this repository</Text>
        <Text size="sm" c="dimmed">
          Posto edits and publishes one project directory at a time.
        </Text>
      </div>
      {props.candidates.map((candidate) => (
        <Button
          key={candidate.dir}
          variant="default"
          h="auto"
          py="sm"
          justify="space-between"
          onClick={() => props.onChoose(candidate)}
        >
          <Stack gap={2} align="flex-start">
            <Text size="sm">{candidate.dir.slice(props.repoRoot.length + 1)}</Text>
            <Text size="xs" c="dimmed">
              {candidate.signals.join(", ") || "Schema configuration"}
            </Text>
          </Stack>
          <Group gap={4}>
            <Badge size="xs" variant="light">
              {candidate.type}
            </Badge>
            {candidate.hasPagesYml && (
              <Badge size="xs" variant="outline">
                pages cms
              </Badge>
            )}
          </Group>
        </Button>
      ))}
      {props.candidates.length === 0 && (
        <Text size="sm" c="dimmed">
          No supported project markers were found in the workspace.
        </Text>
      )}
      <Button variant="subtle" onClick={props.onBrowse}>
        Browse for another folder
      </Button>
    </Stack>
  );
}

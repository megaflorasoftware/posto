import { Button, Menu } from "@mantine/core";
import { ChevronDown } from "lucide-react";

/** The top bar: site chooser with recents, status message, and the
 * Publish / Fetch Changes action. */
export function AppHeader(props: {
  root: string | null;
  recentRoots: string[];
  status: string | null;
  behindUpstream: boolean;
  pulling: boolean;
  hasLocalChanges: boolean;
  onChooseDirectory: () => void;
  onSelectRoot: (dir: string) => void;
  onFetchChanges: () => void;
  onOpenPublish: () => void;
}) {
  const rootName = props.root?.split("/").filter(Boolean).pop() ?? "";
  // Dropdown entries for the recent-sites menu; the open site would be a
  // no-op, so it's left out.
  const recentOptions = props.recentRoots.filter((dir) => dir !== props.root).slice(0, 10);
  return (
    <header className="navbar">
      <Button.Group>
        <Button size="xs" variant="default" onClick={props.onChooseDirectory}>
          {props.root ? rootName : "Choose directory"}
        </Button>
        <Menu position="bottom-start" width={220}>
          <Menu.Target>
            <Button
              size="xs"
              variant="default"
              px={6}
              aria-label="Recent sites"
              disabled={recentOptions.length === 0}
            >
              <ChevronDown size={14} />
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>Recent sites</Menu.Label>
            {recentOptions.map((dir) => (
              <Menu.Item key={dir} title={dir} onClick={() => props.onSelectRoot(dir)}>
                {dir.split("/").filter(Boolean).pop()}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      </Button.Group>
      <span className="navbar-status">{props.status}</span>
      {props.behindUpstream ? (
        <Button size="xs" color="teal" loading={props.pulling} onClick={props.onFetchChanges}>
          Fetch Changes
        </Button>
      ) : (
        <Button
          size="xs"
          disabled={!props.root || !props.hasLocalChanges}
          onClick={props.onOpenPublish}
        >
          Publish…
        </Button>
      )}
    </header>
  );
}

import { useMemo, useState } from "react";
import { Popover, Stack, Text } from "@mantine/core";
import { SlidersHorizontal, TriangleAlert } from "lucide-react";
import type { FileEntry, FileGroup } from "@posto/ipc";
import type { ContentEntry, PagesConfig } from "@posto/core/pagescms/config";
import { orderableCollections, sidebarDisplayTree } from "../sidebarTree";
import { CollectionOrderDialog } from "./CollectionOrderDialog";
import { CollectionSettingsDialog } from "./CollectionSettingsDialog";
import { FileTree } from "./FileTree";

export {
  orderableCollections,
  sidebarDisplayGroups,
  sidebarDisplayTree,
  type DisplayGroup,
  type DisplayGroupNode,
} from "../sidebarTree";

export function SchemaDiagnostics({ config }: { config: PagesConfig | null }) {
  const diagnostics = config?.diagnostics ?? [];
  if (diagnostics.length === 0) return null;
  const label = `${diagnostics.length} schema ${diagnostics.length === 1 ? "notice" : "notices"}`;
  return (
    <Popover position="right-end" width={340} shadow="md" withArrow>
      <Popover.Target>
        <button type="button" className="sidebar-footer-action schema-diagnostics-action">
          <TriangleAlert size={14} />
          {label}
        </button>
      </Popover.Target>
      <Popover.Dropdown aria-label={label}>
        <Stack gap="sm">
          {diagnostics.map((diagnostic) => (
            <div key={`${diagnostic.collection}:${diagnostic.code}:${diagnostic.message}`}>
              <Text size="xs" fw={700} c="yellow.7">
                {diagnostic.collection ?? "Project"}
              </Text>
              <Text size="sm">{diagnostic.message}</Text>
            </div>
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

type SidebarProps = {
  root: string;
  groups: FileGroup[];
  config: PagesConfig | null;
  activeKey: string | null;
  onOpen: (file: FileEntry) => void;
  onDelete: (file: FileEntry) => void;
  onNewFile: (group: FileGroup) => void;
  /** Reveals controls that write repository-level Posto configuration. */
  developerMode?: boolean;
  /** `.posto` settings were saved; reload the overlay. */
  onPostoSaved: () => void;
};

export function Sidebar(props: SidebarProps) {
  return <SidebarContent key={String(props.developerMode === true)} {...props} />;
}

function SidebarContent(props: SidebarProps) {
  const { root, groups, config } = props;
  const developerMode = props.developerMode === true;

  // Collection whose settings dialog is open, with its group's files for
  // pinning suggestions.
  const [settingsFor, setSettingsFor] = useState<{
    collection: ContentEntry;
    files: FileEntry[];
  } | null>(null);
  const [orderOpen, setOrderOpen] = useState(false);

  const displayTree = useMemo(
    () => sidebarDisplayTree(groups, config, root),
    [groups, config, root],
  );

  return (
    <aside className="sidebar">
      {developerMode && settingsFor && (
        <CollectionSettingsDialog
          root={root}
          collection={settingsFor.collection}
          files={settingsFor.files}
          onClose={() => setSettingsFor(null)}
          onSaved={props.onPostoSaved}
        />
      )}
      {developerMode && orderOpen && (
        <CollectionOrderDialog
          root={root}
          collections={orderableCollections(config)}
          onClose={() => setOrderOpen(false)}
          onSaved={props.onPostoSaved}
        />
      )}
      <div className="sidebar-groups">
        <FileTree
          root={root}
          nodes={displayTree}
          activeKey={props.activeKey}
          variant="desktop"
          developerMode={developerMode}
          onOpen={props.onOpen}
          onDelete={props.onDelete}
          onNewFile={props.onNewFile}
          onSettings={(collection, files) => setSettingsFor({ collection, files })}
        />
      </div>
      {developerMode && orderableCollections(config).length > 1 && (
        <button type="button" className="sidebar-footer-action" onClick={() => setOrderOpen(true)}>
          <SlidersHorizontal size={14} />
          Collection settings
        </button>
      )}
      {developerMode && <SchemaDiagnostics config={config} />}
    </aside>
  );
}

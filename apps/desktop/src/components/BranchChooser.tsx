import { useState } from "react";
import { Button, Popover, ScrollArea, TextInput, Tooltip } from "@mantine/core";
import { Check, Cloud, GitBranch, Laptop, Plus } from "lucide-react";
import type { BranchInfo } from "@posto/ipc";
import { slugifyBranchName } from "@posto/editor";

/** The header's branch button: shows the active branch and opens a searchable
 * combobox to switch to — or create — a branch. */
export function BranchChooser(props: {
  branch: string;
  branches: BranchInfo[];
  switching: boolean;
  /** Loads/refreshes the branch list; called when the popover opens. */
  onOpen: () => void;
  onSelect: (name: string, create: boolean) => void;
}) {
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState("");

  const needle = query.trim().toLowerCase();
  const filtered = props.branches.filter(
    (branch) => !needle || branch.name.toLowerCase().includes(needle),
  );
  const slug = slugifyBranchName(query);
  const createName =
    slug !== "" && !props.branches.some((branch) => branch.name === slug) ? slug : null;

  function choose(name: string, create: boolean) {
    setOpened(false);
    if (!create && name === props.branch) return;
    props.onSelect(name, create);
  }

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      width={280}
      position="bottom-start"
      trapFocus
      shadow="md"
    >
      <Popover.Target>
        <Tooltip label={props.branch} openDelay={500}>
          <Button
            className="preview-header-action branch-chooser-button"
            size="compact-sm"
            variant="default"
            leftSection={<GitBranch size={12} />}
            loading={props.switching}
            aria-label={`Switch branch (current: ${props.branch})`}
            onClick={() => {
              const next = !opened;
              setOpened(next);
              if (next) {
                setQuery("");
                props.onOpen();
              }
            }}
          >
            <span className="branch-chooser-name">{props.branch}</span>
          </Button>
        </Tooltip>
      </Popover.Target>
      <Popover.Dropdown className="branch-chooser-dropdown">
        <TextInput
          size="xs"
          data-autofocus
          placeholder="Find or create a branch…"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (filtered.length > 0) choose(filtered[0].name, false);
            else if (createName) choose(createName, true);
          }}
        />
        <ScrollArea.Autosize mah={240}>
          <div className="branch-chooser-options" role="listbox">
            {filtered.map((branch) => (
              <button
                type="button"
                role="option"
                aria-selected={branch.current}
                className="branch-chooser-option"
                key={branch.name}
                title={branch.local ? branch.name : `${branch.name} (remote)`}
                onClick={() => choose(branch.name, false)}
              >
                {branch.local ? <Laptop size={13} /> : <Cloud size={13} />}
                <span className="branch-chooser-option-name">{branch.name}</span>
                {branch.current && <Check size={13} />}
              </button>
            ))}
            {createName && (
              <button
                type="button"
                className="branch-chooser-option"
                onClick={() => choose(createName, true)}
              >
                <Plus size={13} />
                <span className="branch-chooser-option-name">Create branch “{createName}”</span>
              </button>
            )}
            {filtered.length === 0 && !createName && (
              <div className="branch-chooser-empty">No branches found</div>
            )}
          </div>
        </ScrollArea.Autosize>
      </Popover.Dropdown>
    </Popover>
  );
}

import { useState } from "react";
import { TextInput } from "@mantine/core";
import { Check, Cloud, Laptop, Plus } from "lucide-react";
import { Dialog, slugifyBranchName } from "@posto/editor";
import type { BranchInfo } from "@posto/ipc";

/** Bottom-sheet branch chooser: search the local/remote list or create a new
 * branch from the typed (slugified) text. */
export function BranchDrawer(props: {
  opened: boolean;
  branches: BranchInfo[];
  onClose: () => void;
  onSelect: (name: string, create: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const filtered = props.branches.filter(
    (branch) => !needle || branch.name.toLowerCase().includes(needle),
  );
  const slug = slugifyBranchName(query);
  const createName =
    slug !== "" && !props.branches.some((branch) => branch.name === slug) ? slug : null;

  function choose(name: string, create: boolean, current: boolean) {
    props.onClose();
    if (!create && current) return;
    props.onSelect(name, create);
  }

  return (
    <Dialog opened={props.opened} onClose={props.onClose} title="Branch" size="sm">
      <div className="mobile-combobox-drawer">
        <div className="mobile-combobox-options" role="listbox">
          {filtered.map((branch) => (
            <button
              type="button"
              role="option"
              aria-selected={branch.current}
              className="mobile-combobox-option"
              key={branch.name}
              onClick={() => choose(branch.name, false, branch.current)}
            >
              <span className="mobile-branch-option">
                {branch.local ? <Laptop size={18} /> : <Cloud size={18} />}
                <span className="mobile-branch-option-name">{branch.name}</span>
              </span>
              {branch.current && <Check size={18} />}
            </button>
          ))}
          {createName && (
            <button
              type="button"
              className="mobile-combobox-option"
              onClick={() => choose(createName, true, false)}
            >
              <span className="mobile-branch-option">
                <Plus size={18} />
                <span className="mobile-branch-option-name">Create branch “{createName}”</span>
              </span>
            </button>
          )}
          {filtered.length === 0 && !createName && (
            <div className="mobile-combobox-empty">No branches found</div>
          )}
        </div>
        <div className="mobile-combobox-search">
          <TextInput
            autoFocus
            aria-label="Search branches"
            placeholder="Find or create a branch"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
      </div>
    </Dialog>
  );
}

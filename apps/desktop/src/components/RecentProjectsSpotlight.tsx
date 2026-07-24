import { useEffect, useMemo, useState } from "react";
import { ThemeIcon } from "@mantine/core";
import { Spotlight, spotlight } from "@mantine/spotlight";
import { assetUrl, invoke } from "@posto/ipc";
import { FolderGit2 } from "lucide-react";

// Keep this order aligned with mobile's repository picker. SVG is the Astro
// default; the image advances through the other common formats on load error.
const FAVICON_CANDIDATES = ["favicon.svg", "favicon.ico", "favicon.png"];

function RecentProjectIcon({ repository }: { repository: string }) {
  const [workDir, setWorkDir] = useState<string | null>(null);
  const [candidate, setCandidate] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setWorkDir(null);
    setCandidate(0);
    void invoke<string | null>("get_work_dir", { root: repository })
      .then((dir) => {
        if (!cancelled) setWorkDir(dir ?? repository);
      })
      .catch(() => {
        if (!cancelled) setWorkDir(repository);
      });
    return () => {
      cancelled = true;
    };
  }, [repository]);

  const fallback = (
    <ThemeIcon size="lg" variant="light" color="gray" radius="sm">
      <FolderGit2 size={17} />
    </ThemeIcon>
  );
  if (!workDir || candidate >= FAVICON_CANDIDATES.length) return fallback;

  const src = assetUrl(`${workDir}/public/${FAVICON_CANDIDATES[candidate]}`);
  if (!src) return fallback;
  return (
    <img
      className="recent-project-favicon"
      src={src}
      alt=""
      onError={() => setCandidate((index) => index + 1)}
    />
  );
}

/** Searchable launcher for repositories opened on this device, newest first. */
export function RecentProjectsSpotlight(props: {
  roots: string[];
  currentRoot: string | null;
  onClose: () => void;
  onOpen: (root: string) => void;
}) {
  useEffect(() => {
    spotlight.open();
  }, []);

  const actions = useMemo(
    () =>
      props.roots
        .filter((root) => root !== props.currentRoot)
        .slice(0, 10)
        .map((root) => {
          const segments = root.split("/").filter(Boolean);
          return {
            id: root,
            label: segments[segments.length - 1] ?? root,
            description: root,
            leftSection: <RecentProjectIcon repository={root} />,
            onClick: () => props.onOpen(root),
          };
        }),
    [props.currentRoot, props.onOpen, props.roots],
  );

  return (
    <Spotlight
      shortcut={null}
      actions={actions}
      highlightQuery
      onSpotlightClose={props.onClose}
      searchProps={{
        placeholder: "Open a recent repository…",
        "aria-label": "Search recent repositories",
      }}
      nothingFound="No recent repositories found"
    />
  );
}

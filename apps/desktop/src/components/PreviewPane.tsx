import { ActionIcon, Alert, Button, Tabs } from "@mantine/core";
import type { MediaEntry } from "@posto/core/pagescms/config";
import { House } from "lucide-react";
import type { ServerStatus, SetupStep } from "../hooks/useDevServer";
import { SetupFlow } from "./SetupFlow";
import { SeoPreview } from "./SeoPreview";

/** The preview pane: dev-server setup/error states, the site iframe, and the
 * SEO preview tab. Desktop-only. */
export function PreviewPane(props: {
  root: string;
  server: ServerStatus;
  previewRoute: string;
  servedRoute: string | null;
  previewFrame: React.RefObject<HTMLIFrameElement | null>;
  /** While the split divider drags, the iframe must ignore pointer events. */
  dragging: boolean;
  media: MediaEntry | null;
  /** Bumped after each successful save so the SEO preview refetches. */
  saveTick: number;
  onRestart: () => void;
  onRetry: () => void;
  onInstall: (steps: SetupStep[]) => void;
  onHome: () => void;
}) {
  const { server } = props;
  return (
    <div className="pane preview-pane">
      <div className="pane-header">
        <ActionIcon
          size={30}
          variant="default"
          disabled={server.state !== "running"}
          title="Return to site root"
          aria-label="Return to site root"
          onClick={props.onHome}
        >
          <House size={14} />
        </ActionIcon>
        <span className="pane-title">{props.servedRoute ?? props.previewRoute}</span>
        <Button
          size="xs"
          variant="default"
          disabled={server.state === "setup"}
          onClick={props.onRestart}
        >
          Restart Preview
        </Button>
      </div>
      <Tabs className="pane-tabs" defaultValue="site">
        <Tabs.List>
          <Tabs.Tab value="site">Preview</Tabs.Tab>
          <Tabs.Tab value="seo">Search/Socials</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="site">
          {server.state === "setup" && (
            <SetupFlow
              steps={server.steps}
              awaitingInstall={server.awaitingInstall}
              onInstall={() => props.onInstall(server.steps)}
              onRetry={props.onRetry}
            />
          )}
          {server.state === "error" && (
            <div className="pane-placeholder">
              <Alert color="red">{server.message}</Alert>
              <Button size="xs" variant="default" onClick={props.onRetry}>
                Retry
              </Button>
            </div>
          )}
          {server.state === "running" && (
            <iframe
              ref={props.previewFrame}
              className={`preview${props.dragging ? " no-pointer" : ""}`}
              title="Site preview"
            />
          )}
        </Tabs.Panel>
        <Tabs.Panel value="seo">
          {server.state === "running" ? (
            <SeoPreview
              route={props.previewRoute}
              root={props.root}
              media={props.media}
              port={server.port}
              refreshKey={props.saveTick}
            />
          ) : (
            <div className="pane-placeholder">
              Search/social previews need the dev server running.
            </div>
          )}
        </Tabs.Panel>
      </Tabs>
    </div>
  );
}

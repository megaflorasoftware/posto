// @vitest-environment jsdom

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CdnSource } from "@posto/core/media/sources";
import type { PagesConfig } from "@posto/core/pagescms/config";
import { invoke, publishMedia, type ChangedFile } from "@posto/ipc";
import { countPendingCdnMedia, planCdnPublish, type CdnPublishPlan } from "../src/cdnPublish/plan";
import { PublishModal } from "../src/components/PublishModal";
import { useGitSync, type MediaPublishState } from "../src/hooks/useGitSync";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

vi.mock("@posto/ipc", () => ({ invoke: vi.fn(), publishMedia: vi.fn() }));
vi.mock("../src/cdnPublish/plan", () => ({
  planCdnPublish: vi.fn(),
  countPendingCdnMedia: vi.fn(),
}));
vi.mock("../src/hooks/useImageLibraryAssets", () => ({ refreshImageLibraryAssets: vi.fn() }));

const source: CdnSource = {
  name: "cdn",
  label: "Media CDN",
  provider: "bunny",
  bucket: "site-media",
  prefix: "images",
  publicUrl: "https://media.example.com",
};
const config: PagesConfig = { media: [], content: [], cdnSources: [source] };
const upload = {
  sourceName: "cdn",
  path: "/site/src/data/photos/harbor.jpg",
  key: "images/harbor-1a2b3c4d.jpg",
  url: "https://media.example.com/images/harbor-1a2b3c4d.jpg",
  sha256: "1a2b3c4d".repeat(8),
  size: 10,
  contentType: "image/jpeg",
};
const plan = (overrides: Partial<CdnPublishPlan> = {}): CdnPublishPlan => ({
  uploads: [upload],
  writes: [{ path: "/site/src/data/photos/harbor.yaml", previous: "a", content: "b" }],
  removals: [upload.path],
  deletes: [],
  warnings: [],
  blockers: [],
  firstMigrations: [],
  ...overrides,
});

let credentialSaved = false;
let changed: ChangedFile[] = [];

function setup(options: { config?: PagesConfig | null } = {}) {
  const afterPull = vi.fn();
  const onStatus = vi.fn();
  const hook = renderHook(() =>
    useGitSync("/site", {
      onStatus,
      afterPull,
      media: {
        config: () => (options.config === undefined ? config : options.config),
        groups: () => [],
      },
    }),
  );
  return { ...hook, afterPull, onStatus };
}

beforeEach(() => {
  credentialSaved = false;
  changed = [{ status: "M", path: "index.md" }];
  vi.mocked(planCdnPublish).mockReset().mockResolvedValue(plan());
  vi.mocked(countPendingCdnMedia).mockReset().mockResolvedValue(0);
  vi.mocked(publishMedia)
    .mockReset()
    .mockImplementation(async (_request, onProgress) => {
      onProgress({ stage: "uploading", completed: 1, total: 1 });
      return { message: "Published.", kept: [], failedDeletes: [] };
    });
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command, args) => {
      switch (command) {
        case "fetch_upstream":
          return false;
        case "changed_files":
          return changed;
        case "media_publish_recover":
          return { state: "clean" };
        case "media_credential_exists":
          return credentialSaved;
        case "media_credential_save": {
          const secret = (args as { credential: { secret: string } }).credential.secret;
          if (secret !== "right") throw new Error("Storage rejected the saved credentials.");
          credentialSaved = true;
          return null;
        }
        case "publish":
          return "Published.";
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    });
});

afterEach(cleanup);

const commands = () => vi.mocked(invoke).mock.calls.map(([command]) => command);

describe("publishing CDN media", () => {
  test("uploads through the transaction and refreshes the editor", async () => {
    credentialSaved = true;
    const { result, afterPull } = setup();

    let published = false;
    await act(async () => {
      published = await result.current.publish("ship it");
    });

    expect(published).toBe(true);
    expect(publishMedia).toHaveBeenCalledWith(
      {
        root: "/site",
        message: "ship it",
        sources: [source],
        uploads: [upload],
        writes: plan().writes,
        removals: [upload.path],
        deletes: [],
      },
      expect.any(Function),
    );
    expect(commands()).not.toContain("publish");
    expect(afterPull).toHaveBeenCalledWith("/site");
  });

  test("asks for a password, retries a rejected one, then continues", async () => {
    const { result } = setup();

    let publishing!: Promise<boolean>;
    act(() => {
      publishing = result.current.publish("ship it");
    });
    await waitFor(() => expect(result.current.mediaPublish.credentialRequest).not.toBeNull());
    expect(result.current.mediaPublish.credentialRequest).toEqual({ source, error: null });

    act(() => result.current.mediaPublish.submitCredential({ secret: "wrong" }));
    await waitFor(() =>
      expect(result.current.mediaPublish.credentialRequest?.error).toContain("rejected"),
    );
    expect(publishMedia).not.toHaveBeenCalled();

    act(() => result.current.mediaPublish.submitCredential({ secret: "right" }));
    await act(async () => {
      expect(await publishing).toBe(true);
    });
    expect(invoke).toHaveBeenCalledWith("media_credential_save", {
      source,
      credential: { secret: "right" },
      prefix: "images",
    });
    expect(publishMedia).toHaveBeenCalledOnce();
  });

  test("cancelling the password prompt uploads and commits nothing", async () => {
    const { result } = setup();

    let publishing!: Promise<boolean>;
    act(() => {
      publishing = result.current.publish("ship it");
    });
    await waitFor(() => expect(result.current.mediaPublish.credentialRequest).not.toBeNull());
    act(() => result.current.mediaPublish.submitCredential(null));

    await act(async () => {
      expect(await publishing).toBe(false);
    });
    expect(publishMedia).not.toHaveBeenCalled();
    expect(commands()).not.toContain("publish");
    expect(result.current.mediaPublish.publishError).toBeNull();
  });

  test("blocking problems stop publishing before any upload", async () => {
    vi.mocked(planCdnPublish).mockResolvedValue(plan({ blockers: ["Commit .astro/collections."] }));
    const { result } = setup();

    await act(async () => {
      expect(await result.current.publish("ship it")).toBe(false);
    });

    expect(result.current.mediaPublish.publishError).toContain("Commit .astro/collections.");
    expect(publishMedia).not.toHaveBeenCalled();
    expect(commands()).not.toContain("publish");
  });

  test("a failed transaction still reloads the restored files", async () => {
    credentialSaved = true;
    vi.mocked(publishMedia).mockRejectedValue(new Error("Push rejected"));
    const { result, afterPull } = setup();

    await act(async () => {
      expect(await result.current.publish("ship it")).toBe(false);
    });

    expect(afterPull).toHaveBeenCalledWith("/site");
    expect(result.current.mediaPublish.publishError).toBe("Publish failed: Push rejected");
  });

  test("deletes alone still publish through the transaction", async () => {
    credentialSaved = true;
    const deleted = { sourceName: "cdn", key: "images/old-1a2b3c4d.jpg", url: "https://x/y" };
    vi.mocked(planCdnPublish).mockResolvedValue(
      plan({ uploads: [], writes: [], removals: [], deletes: [deleted] }),
    );
    vi.mocked(publishMedia).mockResolvedValue({
      message: "Published.",
      kept: [],
      failedDeletes: ["images/old-1a2b3c4d.jpg"],
    });
    const { result, onStatus } = setup();

    await act(async () => {
      expect(await result.current.publish("ship it")).toBe(true);
    });

    expect(vi.mocked(publishMedia).mock.calls[0][0].deletes).toEqual([
      { sourceName: "cdn", key: "images/old-1a2b3c4d.jpg" },
    ]);
    expect(onStatus).toHaveBeenCalledWith(expect.stringContaining("retried next time"), "success");
  });

  test("publishes normally when nothing needs uploading", async () => {
    vi.mocked(planCdnPublish).mockResolvedValue(plan({ uploads: [], writes: [], removals: [] }));
    const { result } = setup();

    await act(async () => {
      await result.current.publish("ship it");
    });

    expect(invoke).toHaveBeenCalledWith("publish", { root: "/site", message: "ship it" });
    expect(publishMedia).not.toHaveBeenCalled();
  });

  test("sites without CDN sources never plan media", async () => {
    const { result } = setup({ config: { media: [], content: [] } });

    await act(async () => {
      await result.current.publish("ship it");
    });

    expect(planCdnPublish).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("publish", { root: "/site", message: "ship it" });
  });

  test("offers Publish when only a migration is pending", async () => {
    changed = [];
    vi.mocked(countPendingCdnMedia).mockResolvedValue(3);
    const { result } = setup();

    await act(async () => {
      await result.current.refreshLocalChanges("/site");
    });

    expect(result.current.hasLocalChanges).toBe(false);
    expect(result.current.pendingMediaCount).toBe(3);
    expect(result.current.canPublish).toBe(true);
  });
});

describe("recovering an interrupted publish", () => {
  test("reports an undone publish and reloads content", async () => {
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "media_publish_recover"
        ? { state: "rolledBack" }
        : command === "changed_files"
          ? []
          : false,
    );
    const { afterPull, onStatus } = setup();

    await waitFor(() => expect(afterPull).toHaveBeenCalledWith("/site"));
    expect(onStatus).toHaveBeenCalledWith(expect.stringContaining("undid it"), "error");
  });

  test("an unreachable server leaves the publish waiting", async () => {
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "media_publish_recover"
        ? { state: "blocked", message: "Posto can't reach the server." }
        : false,
    );
    const { afterPull, onStatus } = setup();

    await waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith("Posto can't reach the server.", "error"),
    );
    expect(afterPull).not.toHaveBeenCalled();
  });
});

describe("the Publish dialog", () => {
  const media = (overrides: Partial<MediaPublishState> = {}): MediaPublishState => ({
    plan: plan(),
    planning: false,
    planError: null,
    stage: null,
    credentialRequest: null,
    submitCredential: vi.fn(),
    publishError: null,
    ...overrides,
  });

  function dialog(props: Partial<React.ComponentProps<typeof PublishModal>> = {}) {
    const onPublish = vi.fn();
    const onClose = vi.fn();
    render(
      <MantineProvider forceColorScheme="light">
        <PublishModal
          opened
          changes={[]}
          error={null}
          onClose={onClose}
          onRevert={vi.fn()}
          onPublish={onPublish}
          media={media()}
          {...props}
        />
      </MantineProvider>,
    );
    return { onPublish, onClose };
  }

  const publishButton = () => screen.getByRole("button", { name: "Publish" });

  test("pending uploads can be published without other changes", () => {
    const { onPublish } = dialog();

    expect(screen.getByText("1 image will upload to the CDN.")).toBeTruthy();
    fireEvent.click(publishButton());
    expect(onPublish).toHaveBeenCalledWith("Site updates");
  });

  test("blocking problems disable Publish", () => {
    dialog({ media: media({ plan: plan({ blockers: ["Commit .astro/collections."] }) }) });

    expect(screen.getByText("Commit .astro/collections.")).toBeTruthy();
    expect(publishButton()).toHaveProperty("disabled", true);
  });

  test("a first migration needs confirmation", () => {
    dialog({ media: media({ plan: plan({ firstMigrations: ["photos"] }) }) });

    expect(publishButton()).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(publishButton()).toHaveProperty("disabled", false);
  });

  test("a Bunny source asks only for the zone password", () => {
    const submitCredential = vi.fn();
    dialog({ media: media({ credentialRequest: { source, error: null }, submitCredential }) });

    expect(screen.queryByLabelText("Access key ID")).toBeNull();
    fireEvent.change(screen.getByLabelText("Storage zone password"), {
      target: { value: " zone-pass " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(submitCredential).toHaveBeenCalledWith({ secret: "zone-pass" });
  });

  test("an S3 source asks for an access key ID too", () => {
    const submitCredential = vi.fn();
    const s3 = { ...source, provider: "s3" as const, endpoint: "https://s3.example.com" };
    dialog({ media: media({ credentialRequest: { source: s3, error: null }, submitCredential }) });

    const save = screen.getByRole("button", { name: "Save and continue" });
    fireEvent.change(screen.getByLabelText("Secret access key"), { target: { value: "secret" } });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Access key ID"), { target: { value: "key" } });
    fireEvent.click(save);
    expect(submitCredential).toHaveBeenCalledWith({ accessKeyId: "key", secret: "secret" });
  });

  test("the dialog can't be dismissed mid-publish", () => {
    const { onClose } = dialog({
      publishing: true,
      media: media({ stage: { stage: "uploading", completed: 2, total: 5 } }),
    });

    expect(screen.getByText("Uploading 5 images (2 done)…")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  test("the dialog closes normally when idle", () => {
    const { onClose } = dialog();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  test("dismissing the password prompt cancels the publish", () => {
    const submitCredential = vi.fn();
    dialog({
      publishing: true,
      media: media({ credentialRequest: { source, error: null }, submitCredential }),
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(submitCredential).toHaveBeenCalledWith(null);
  });
});

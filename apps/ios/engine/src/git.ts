/**
 * Git state for the open project: local changes, upstream polling, pull,
 * the publish flow (including CDN media uploads and their credential
 * prompts), and branches. Headless ports of useGitSync and useBranches.
 */
import type { CdnSource } from "@posto/core/media/sources";
import type { PagesConfig } from "@posto/core/pagescms/config";
import type {
  BranchInfo,
  ChangedFile,
  CheckoutOutcome,
  FileGroup,
  MediaCredential,
  MediaPublishRecovery,
} from "@posto/ipc";
import {
  countPendingCdnMedia,
  planCdnPublish,
  type CdnPublishPlan,
} from "../../../../packages/editor/src/cdnPublish/plan";
import type { PublishStage } from "../../../../packages/editor/src/hooks/useGitSync";
import {
  keptCopyNotes,
  plural,
  publishStageLabel,
  uploadNotes,
} from "../../../../packages/editor/src/publishNotes";
import { slugifyBranchName } from "../../../../packages/editor/src/hooks/useBranches";
import { changedFilesPreview, publishMedia } from "./ipc";
import { errorMessage, invoke } from "./host";

const FETCH_INTERVAL_MS = 30_000;

export interface GitHost {
  root(): string;
  config(): PagesConfig | null;
  groups(): FileGroup[];
  /** Flushes pending edits so git sees them. */
  beforeSync(): Promise<void>;
  /** Runs after a pull, media publish, or recovery rewrote the tree. */
  afterPull(dir: string): Promise<void>;
  refreshMediaLibraries(dir: string): void;
  status(message: string, severity: "progress" | "success" | "error"): void;
  changed(): void;
}

export interface PublishView {
  changes: ChangedFile[] | null;
  /** The list the publish will commit (after media rewrites), when it differs. */
  previewChanges: ChangedFile[] | null;
  changesError: string | null;
  planning: boolean;
  planError: string | null;
  uploadNotes: string[];
  deleteNote: string | null;
  blockers: string[];
  keptNotes: string[];
  publishing: boolean;
  stage: { label: string; progress: number | null } | null;
  credentialRequest: { source: CdnSource; error: string | null } | null;
  publishError: string | null;
  scopeLabel: string | null;
}

export class GitSync {
  behindUpstream = false;
  pulling = false;
  publishing = false;
  hasLocalChanges = false;
  pendingMediaCount = 0;
  changes: ChangedFile[] | null = null;
  changesError: string | null = null;
  private changedFiles: { root: string; files: ChangedFile[] } | null = null;
  mediaPlan: CdnPublishPlan | null = null;
  planning = false;
  planError: string | null = null;
  stage: PublishStage | null = null;
  credentialRequest: { source: CdnSource; error: string | null } | null = null;
  private credentialResolver: ((credential: MediaCredential | null) => void) | null = null;
  publishError: string | null = null;
  previewChanges: ChangedFile[] | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly host: GitHost) {}

  get canPublish(): boolean {
    return this.hasLocalChanges || this.pendingMediaCount > 0;
  }

  start(): void {
    const dir = this.host.root();
    void this.recoverInterruptedPublish(dir);
    void this.checkUpstream();
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.checkUpstream(), FETCH_INTERVAL_MS);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private mediaConfig(): PagesConfig | null {
    const config = this.host.config();
    return config?.cdnSources?.length ? config : null;
  }

  async checkUpstream(): Promise<void> {
    const dir = this.host.root();
    try {
      const behind = await invoke<boolean>("fetch_upstream", { root: dir });
      if (this.host.root() === dir) this.behindUpstream = behind;
    } catch {
      if (this.host.root() === dir) this.behindUpstream = false;
    }
    this.host.changed();
  }

  private async recoverInterruptedPublish(dir: string) {
    let outcome: MediaPublishRecovery;
    try {
      outcome = await invoke<MediaPublishRecovery>("media_publish_recover", { root: dir });
    } catch {
      return;
    }
    if (this.host.root() !== dir || !outcome || typeof outcome !== "object") return;
    if (outcome.state === "blocked") {
      this.host.status(outcome.message, "error");
      return;
    }
    if (outcome.state !== "rolledBack" && outcome.state !== "finalized") return;
    this.host.status(
      outcome.state === "rolledBack"
        ? "Your last publish didn't finish, so Posto undid it. Your changes are ready to publish again."
        : "Your last publish finished.",
      outcome.state === "rolledBack" ? "error" : "success",
    );
    await this.host.afterPull(dir);
    this.host.refreshMediaLibraries(dir);
    await this.refreshLocalChanges(dir);
  }

  private async refreshPendingMedia(dir: string, changed: ChangedFile[]) {
    const config = this.mediaConfig();
    const count =
      config && changed.length === 0 ? await countPendingCdnMedia(dir, config).catch(() => 0) : 0;
    if (this.host.root() === dir) this.pendingMediaCount = count;
  }

  async refreshLocalChanges(dir: string = this.host.root()): Promise<void> {
    try {
      const changed = await invoke<ChangedFile[]>("changed_files", { root: dir });
      if (this.host.root() === dir) {
        this.changedFiles = { root: dir, files: changed };
        this.hasLocalChanges = changed.length > 0;
        if (this.changes !== null) this.changes = changed;
        await this.refreshPendingMedia(dir, changed);
      }
    } catch {
      // Status unavailable — leave Publish enabled so it surfaces the real error.
      if (this.host.root() === dir) this.hasLocalChanges = true;
    }
    this.host.changed();
  }

  async pull(): Promise<void> {
    const dir = this.host.root();
    await this.host.beforeSync();
    this.pulling = true;
    this.host.changed();
    try {
      this.host.status(await invoke<string>("pull_upstream", { root: dir }), "success");
      this.behindUpstream = false;
    } catch (error) {
      this.host.status(`Fetch failed: ${errorMessage(error)}`, "error");
    } finally {
      await this.host.afterPull(dir);
      this.pulling = false;
      this.host.changed();
    }
  }

  private async previewMediaPlan(dir: string) {
    const config = this.mediaConfig();
    this.planError = null;
    if (!config) {
      this.mediaPlan = null;
      this.previewChanges = null;
      return;
    }
    this.planning = true;
    this.host.changed();
    try {
      const plan = await planCdnPublish({ root: dir, config, groups: this.host.groups() });
      const preview =
        plan.writes.length + plan.removals.length > 0
          ? await changedFilesPreview(
              dir,
              plan.writes.map(({ path, content }) => ({ path, content })),
              plan.removals,
            )
          : null;
      if (this.host.root() !== dir) return;
      this.mediaPlan = plan;
      this.previewChanges = preview;
    } catch (error) {
      if (this.host.root() === dir) {
        this.mediaPlan = null;
        this.previewChanges = null;
        this.planError = errorMessage(error);
      }
    } finally {
      this.planning = false;
      this.host.changed();
    }
  }

  /** (Re)loads the publish sheet's change list. */
  async loadChanges(): Promise<void> {
    const dir = this.host.root();
    this.changesError = null;
    this.publishError = null;
    const preview = this.previewMediaPlan(dir);
    const cached = this.changedFiles;
    if (cached?.root === dir) {
      this.changes = cached.files;
    } else {
      this.changes = null;
      this.host.changed();
      try {
        const changed = await invoke<ChangedFile[]>("changed_files", { root: dir });
        this.changedFiles = { root: dir, files: changed };
        this.hasLocalChanges = changed.length > 0;
        this.changes = changed;
      } catch (error) {
        this.changesError = String(error);
      }
    }
    this.host.changed();
    await preview;
  }

  closeChanges(): void {
    this.changes = null;
  }

  async revert(file: ChangedFile): Promise<boolean> {
    const dir = this.host.root();
    try {
      await invoke("revert_file", { root: dir, path: file.path, status: file.status });
    } catch (error) {
      this.changesError = String(error);
      this.host.changed();
      return false;
    }
    const cached = this.changedFiles;
    const next = (cached?.root === dir ? cached.files : (this.changes ?? [])).filter(
      (candidate) => candidate.path !== file.path,
    );
    this.changedFiles = { root: dir, files: next };
    this.changes = next;
    this.hasLocalChanges = next.length > 0;
    void this.previewMediaPlan(dir);
    this.host.changed();
    return true;
  }

  private requestCredential(source: CdnSource, error: string | null) {
    return new Promise<MediaCredential | null>((resolve) => {
      this.credentialResolver = resolve;
      this.stage = { stage: "credentials" };
      this.credentialRequest = { source, error };
      this.host.changed();
    });
  }

  submitCredential(credential: MediaCredential | null): void {
    const resolve = this.credentialResolver;
    this.credentialResolver = null;
    this.credentialRequest = null;
    this.host.changed();
    resolve?.(credential);
  }

  /** Asks for any missing storage passwords. False if the user cancels. */
  async ensureCredentials(sources: CdnSource[]): Promise<boolean> {
    for (const source of sources) {
      if (await invoke<boolean>("media_credential_exists", { source })) continue;
      let refusal: string | null = null;
      for (;;) {
        const credential = await this.requestCredential(source, refusal);
        if (!credential) return false;
        this.stage = { stage: "planning" };
        this.host.changed();
        try {
          await invoke("media_credential_save", {
            source,
            credential,
            prefix: source.prefix ?? "",
          });
          break;
        } catch (error) {
          refusal = errorMessage(error);
        }
      }
    }
    return true;
  }

  private setStage(stage: PublishStage | null) {
    this.stage = stage;
    this.host.changed();
  }

  private async publishOnce(dir: string, message: string): Promise<string | null> {
    const config = this.mediaConfig();
    if (!config) return invoke<string>("publish", { root: dir, message });
    this.setStage({ stage: "planning" });
    const plan = await planCdnPublish({ root: dir, config, groups: this.host.groups() });
    this.mediaPlan = plan;
    if (plan.blockers.length > 0) throw new Error(plan.blockers.join(" "));
    if (plan.uploads.length === 0 && plan.deletes.length === 0) {
      return invoke<string>("publish", { root: dir, message });
    }
    const used = new Set([...plan.uploads, ...plan.deletes].map((item) => item.sourceName));
    const sources = (config.cdnSources ?? []).filter((source) => used.has(source.name));
    if (!(await this.ensureCredentials(sources))) return null;
    try {
      const summary = await publishMedia(
        {
          root: dir,
          message,
          sources,
          uploads: plan.uploads,
          writes: plan.writes,
          removals: plan.removals,
          deletes: plan.deletes.map(({ sourceName, key }) => ({ sourceName, key })),
        },
        (progress) => this.setStage(progress),
      );
      const kept = summary.kept.length;
      const failed = summary.failedDeletes.length;
      return [
        summary.message,
        kept > 0 &&
          `${kept} ${kept === 1 ? "image" : "images"} that git ignores stayed on this device.`,
        failed > 0 &&
          `${failed} ${failed === 1 ? "image" : "images"} couldn't be deleted from the CDN and will be retried next time.`,
      ]
        .filter(Boolean)
        .join(" ");
    } finally {
      await this.host.afterPull(dir);
      this.host.refreshMediaLibraries(dir);
    }
  }

  /** Publishes; true when something was committed. Failures land in
   * `publishError` (shown in the sheet) and the repo status. */
  async publish(message: string): Promise<boolean> {
    const dir = this.host.root();
    if (this.publishing) return false;
    this.publishing = true;
    this.publishError = null;
    this.host.changed();
    let published = false;
    try {
      await this.host.beforeSync();
      try {
        const result = await this.publishOnce(dir, message);
        if (result !== null) {
          published = true;
          if (result !== "Published.") this.host.status(result, "success");
        }
      } catch (error) {
        const failure = `Publish failed: ${errorMessage(error)}`;
        this.publishError = failure;
        this.host.status(failure, "error");
      }
      await this.refreshLocalChanges(dir);
    } finally {
      this.publishing = false;
      this.stage = null;
      this.host.changed();
    }
    return published;
  }

  publishView(scopeLabel: string | null): PublishView {
    const plan = this.mediaPlan;
    const sources = this.mediaConfig()?.cdnSources ?? [];
    const stage = this.stage;
    return {
      changes: this.changes,
      previewChanges: this.previewChanges,
      changesError: this.changesError,
      planning: this.planning,
      planError: this.planError,
      uploadNotes: plan ? uploadNotes(plan, sources) : [],
      deleteNote:
        plan && plan.deletes.length > 0
          ? `${plural(plan.deletes.length, "deleted image", "deleted images")} will be removed from the CDN after publishing.`
          : null,
      blockers: plan?.blockers ?? [],
      keptNotes: plan ? keptCopyNotes(plan.warnings) : [],
      publishing: this.publishing,
      stage: stage
        ? {
            label: publishStageLabel(stage),
            progress:
              stage.stage === "uploading" && stage.total > 0 ? stage.completed / stage.total : null,
          }
        : null,
      credentialRequest: this.credentialRequest,
      publishError: this.publishError,
      scopeLabel,
    };
  }
}

export type BranchConflict = { branch: string; files: string[] };

export class Branches {
  branch: string | null = null;
  branches: BranchInfo[] = [];
  switching = false;
  conflict: BranchConflict | null = null;

  constructor(
    private readonly root: () => string,
    private readonly onSwitched: (dir: string) => Promise<void>,
    private readonly changed: () => void,
  ) {}

  async loadCurrent(): Promise<void> {
    try {
      this.branch = await invoke<string | null>("current_branch", { root: this.root() });
    } catch {
      this.branch = null;
    }
    this.changed();
  }

  /** The local list shows immediately; a background fetch refreshes the
   * remote-only entries. */
  async load(): Promise<void> {
    const dir = this.root();
    try {
      this.branches = await invoke<BranchInfo[]>("list_branches", { root: dir });
    } catch {
      this.branches = [];
      this.changed();
      return;
    }
    this.changed();
    void invoke("fetch_upstream", { root: dir })
      .then(async () => {
        const refreshed = await invoke<BranchInfo[]>("list_branches", { root: dir });
        if (this.root() === dir) {
          this.branches = refreshed;
          this.changed();
        }
      })
      .catch(() => {});
  }

  /** Resolves to an error message, or null when it switched (or stopped at
   * a conflict, which `conflict` then describes). */
  async switchTo(
    name: string,
    options?: { create?: boolean; force?: boolean },
  ): Promise<string | null> {
    const dir = this.root();
    if (this.switching) return null;
    this.switching = true;
    this.changed();
    try {
      const outcome = await invoke<CheckoutOutcome>("checkout_branch", {
        root: dir,
        name,
        create: options?.create === true,
        force: options?.force === true,
      });
      if (!outcome.switched) {
        this.conflict = { branch: name, files: outcome.conflicts };
        return null;
      }
      this.conflict = null;
      if (this.root() === dir) this.branch = name;
      await this.onSwitched(dir);
      return null;
    } catch (error) {
      return `Could not switch branch: ${errorMessage(error)}`;
    } finally {
      this.switching = false;
      this.changed();
    }
  }

  forceSwitch(): Promise<string | null> {
    const pending = this.conflict;
    this.conflict = null;
    return pending ? this.switchTo(pending.branch, { force: true }) : Promise.resolve(null);
  }

  clearConflict(): void {
    this.conflict = null;
    this.changed();
  }
}

export { slugifyBranchName };

import type { CdnSource } from "@posto/core/media/sources";
import type { CdnPlanWarning, CdnPublishPlan } from "./cdnPublish/plan";
import type { PublishStage } from "./hooks/useGitSync";

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function publishStageLabel(stage: PublishStage): string {
  switch (stage.stage) {
    case "planning":
      return "Checking images…";
    case "credentials":
      return "Waiting for storage credentials…";
    case "uploading":
      return `Uploading ${plural(stage.total, "image", "images")} (${stage.completed} done)…`;
    case "applying":
    case "committing":
      return "Saving changes…";
    case "pushing":
      return "Publishing…";
    case "finishing":
      return "Finishing…";
  }
}

/** Explains, grouped by cause, why some images keep their local copy or
 * don't upload. */
export function keptCopyNotes(warnings: CdnPlanWarning[]): string[] {
  const referenced = new Map<string, number>();
  const unreadable = new Map<string, number>();
  let outside = 0;
  for (const warning of warnings) {
    if (warning.reason === "referenced") {
      referenced.set(warning.by, (referenced.get(warning.by) ?? 0) + 1);
    } else if (warning.reason === "outside-library") outside += 1;
    else unreadable.set(warning.error, (unreadable.get(warning.error) ?? 0) + 1);
  }
  const copies = (count: number) =>
    count === 1 ? "The local copy of 1 image" : `Local copies of ${count} images`;
  return [
    ...[...referenced].map(
      ([by, count]) =>
        `${copies(count)} will stay after uploading, because ${by} still mentions ${count === 1 ? "it" : "them"}.`,
    ),
    ...(outside > 0
      ? [
          `${copies(outside)} will stay after uploading, because ${outside === 1 ? "it's" : "they're"} outside the library's folder.`,
        ]
      : []),
    ...[...unreadable].map(
      ([error, count]) =>
        `${plural(count, "image", "images")} couldn't be read and won't upload: ${error.replace(/\.?$/, ".")}`,
    ),
  ];
}

/** How many images go to each CDN source, named by its label. */
export function uploadNotes(plan: CdnPublishPlan, sources: CdnSource[]): string[] {
  const counts = new Map<string, number>();
  for (const upload of plan.uploads) {
    counts.set(upload.sourceName, (counts.get(upload.sourceName) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => {
    const label = sources.find((source) => source.name === name)?.label ?? name;
    return `${plural(count, "image", "images")} will be uploaded to ${label}`;
  });
}

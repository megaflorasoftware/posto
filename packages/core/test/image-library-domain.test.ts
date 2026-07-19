import {
  MediaPlanError,
  discoverImageLibraryAssets,
  planMediaDelete,
  planMediaImport,
} from "../src/astro/imageLibrary";
import type { AstroImageLibrary } from "../src/pagescms/config";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const library: AstroImageLibrary = {
  collection: "images",
  base: "src/data/images",
  patterns: ["**/*.{yml,yaml}"],
  metadataExtensions: ["yml", "yaml"],
  imageFieldPath: ["asset", "image"],
  fields: [
    {
      name: "asset",
      type: "object",
      required: true,
      fields: [
        { name: "image", type: "image", required: true },
        { name: "alt", type: "string", required: true },
      ],
    },
    { name: "credit", type: "string", default: "staff" },
  ],
};

const discovered = discoverImageLibraryAssets(
  library,
  "/site",
  [
    { path: "/site/src/data/images/sunrise.yml", content: "asset:\n  image: ./sunrise.jpg\n  alt: Sunrise\n" },
    { path: "/site/src/data/images/nested/missing.yaml", content: "asset:\n  image: ./missing.webp\n  alt: Missing\n" },
    { path: "/site/src/data/images/external.yml", content: "asset:\n  image: ../../../secret.png\n  alt: No\n" },
    { path: "/site/src/data/images/shared.yml", content: "asset:\n  image: ./sunrise.jpg\n  alt: Shared\n" },
  ],
  ["/site/src/data/images/sunrise.jpg"],
);
assert(discovered[0].entryId === "sunrise", "entry id derived from metadata path");
assert(discovered[0].health.includes("shared-image"), "shared image detected");
assert(discovered[1].health.includes("missing-image"), "missing image detected");
assert(discovered[2].health.includes("external-image"), "external image detected");

const plan = planMediaImport({
  library,
  repositoryRoot: "/site",
  sourceImagePath: "/tmp/Forest Photo.JPG",
  folder: "landscapes",
  filename: "Forest Photo.JPG",
  metadataExtension: "yml",
  metadata: { asset: { alt: "Pines" } },
});
assert(plan.destinationImagePath.endsWith("/landscapes/Forest-Photo.JPG"), "filename normalized");
assert(plan.destinationMetadataPath.endsWith("/landscapes/Forest-Photo.yml"), "matching basename");
assert(plan.entryId === "landscapes/forest-photo", "Astro id planned");
assert((plan.metadata.asset as Record<string, unknown>).image === "./Forest-Photo.JPG", "nested image assigned");
assert(plan.metadata.credit === "staff", "schema default applied");
assert(plan.serializedMetadata.includes("alt: Pines"), "metadata serialized");

for (const input of [
  { folder: "../outside", metadataExtension: "yml" as const },
  { folder: "ok", metadataExtension: "yml" as const, existingPaths: ["/site/src/data/images/ok/photo.jpg"] },
]) {
  let blocked = false;
  try {
    planMediaImport({
      library,
      repositoryRoot: "/site",
      sourceImagePath: "/tmp/photo.jpg",
      metadata: { asset: { alt: "Photo" } },
      ...input,
    });
  } catch (error) {
    blocked = error instanceof MediaPlanError;
  }
  assert(blocked, "unsafe import rejected");
}

const validAsset = discoverImageLibraryAssets(
  library,
  "/site",
  [{ path: "/site/src/data/images/free.yml", content: "asset:\n  image: ./free.jpg\n  alt: Free\n" }],
  ["/site/src/data/images/free.jpg"],
)[0];
assert(planMediaDelete({ library, repositoryRoot: "/site", asset: validAsset, usages: [], coverageComplete: true }).entryId === "free", "unreferenced deletion planned");
let requiredBlocked = false;
try {
  planMediaDelete({
    library,
    repositoryRoot: "/site",
    asset: validAsset,
    coverageComplete: true,
    usages: [{ sourcePath: "/site/src/blog/post.md", valuePath: ["hero"], targetCollection: "images", entryId: "free", required: true }],
  });
} catch (error) {
  requiredBlocked = error instanceof MediaPlanError;
}
assert(requiredBlocked, "required usage blocks deletion");

console.log("image library domain tests passed");

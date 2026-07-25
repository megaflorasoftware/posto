import { test } from "vitest";
import {
  mediaInputPath,
  mediaOutputPath,
  relativeMediaPath,
  resolveRelativeMediaPath,
  resolveMediaForValue,
  type ContentEntry,
  type Field,
  type PagesConfig,
} from "../src/pagescms/config";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const config: PagesConfig = {
  media: [
    { name: "default", input: "public", output: "/" },
    { name: "projects", input: "src/assets/projects", output: "/projects" },
    { name: "avatars", input: "src/assets/avatars", output: "/people/avatars" },
  ],
  content: [],
};
const src: Field = { name: "src", type: "string" };

test("resolves the owning media folder for a value", () => {
  assert(
    resolveMediaForValue(config, src, "/projects/posto.jpg")?.name === "projects",
    "specific output owns value",
  );
  assert(
    resolveMediaForValue(config, src, "/other/photo.jpg")?.name === "default",
    "root output remains fallback owner",
  );
  assert(
    resolveMediaForValue(config, { ...src, options: { media: "avatars" } }, "/projects/posto.jpg")
      ?.name === "avatars",
    "explicit source remains authoritative",
  );
});

test("round-trips Astro image paths relative to the content document", () => {
  const root = "/repo";
  const document = "/repo/src/content/blog/first-post.md";
  const image = "/repo/src/assets/blog-placeholder-3.jpg";
  const media = { name: "src", input: "src", output: "src", relative: true };

  assert(
    relativeMediaPath(document, image) === "../../assets/blog-placeholder-3.jpg",
    "fixture image path is document-relative",
  );
  assert(
    resolveRelativeMediaPath(document, "../../assets/blog-placeholder-3.jpg") === image,
    "relative value resolves to the source image",
  );
  const output = mediaOutputPath(root, media, image, document);
  assert(output === "../../assets/blog-placeholder-3.jpg", "picker stores a relative value");
  assert(
    mediaInputPath(root, media, output, document) === image,
    "relative media source resolves the stored value",
  );
  assert(
    mediaInputPath(
      root,
      { name: "default", input: "public", output: "/" },
      "../../assets/blog-placeholder-3.jpg",
    ) === null,
    "public media cannot claim a relative path that escapes public",
  );
});

test("expands collection-scoped media sources", () => {
  const entry: ContentEntry = {
    name: "blog",
    type: "collection",
    path: "src/blog",
    fields: [],
    media: { name: "post", input: "src/blog/{slug}/images", output: "/blog/{slug}/images" },
  };
  const scoped = resolveMediaForValue(config, src, "/blog/hello/images/hero.jpg", entry, {
    slug: "hello",
  });
  assert(
    scoped?.name === "post" && scoped.input === "src/blog/hello/images",
    "expanded collection source resolved",
  );
});

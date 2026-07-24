import { test } from "vitest";
import { buildAstroConfig, parseLoaderConfig } from "../src/astro/collections";
import type { Field } from "../src/pagescms/config";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const { loaders } = parseLoaderConfig(`
export const imageSchema = ({ image }) => z.object({
  asset: z.object({ source: image(), alt: z.string() }),
});
const images = defineCollection({
  loader: glob({ pattern: ["**/*.{yml,yaml}", "!videos/**/*.{yml,yaml}"], base: "./src/data/images" }),
  schema: imageSchema,
});
const jsonImages = defineCollection({
  loader: glob({ pattern: "**/*.json", base: "./src/data/json-images" }),
  schema: z.object({ image: image(), caption: z.string().optional() }),
});
const gallery = defineCollection({
  loader: glob({ pattern: "**/*.yml", base: "./src/data/gallery" }),
  schema: z.object({ before: image(), after: image() }),
});
const imageList = defineCollection({
  loader: glob({ pattern: "**/*.yml", base: "./src/data/image-list" }),
  schema: z.object({ images: z.array(image()) }),
});
const generatedImages = defineCollection({
  loader: glob({ pattern: "**/*.yml", base: "./src/data/generated", generateId: ({ data }) => data.key }),
  schema: z.object({ image: image() }),
});
const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/blog" }),
  schema: z.object({ hero: reference("images"), cards: z.array(z.object({ art: reference("images") })) }),
});
export const collections = { images, jsonImages, gallery, imageList, generatedImages, blog };
`);

test("parses image schema paths from loader config", () => {
  assert(
    loaders.get("images")?.images?.[0]?.path.join(".") === "asset.source",
    "external nested image schema path",
  );
  assert(loaders.get("gallery")?.images?.length === 2, "multiple images retained");
  assert(
    loaders.get("imageList")?.images?.[0]?.writable === false,
    "image arrays are not writable libraries",
  );
});

const nested: Field = {
  name: "asset",
  type: "object",
  fields: [
    { name: "source", type: "string", required: true },
    { name: "alt", type: "string", required: true },
  ],
};
const config = buildAstroConfig(
  [
    { name: "images", fields: [nested] },
    {
      name: "jsonImages",
      fields: [
        { name: "image", type: "string" },
        { name: "caption", type: "string" },
      ],
    },
    {
      name: "gallery",
      fields: [
        { name: "before", type: "string" },
        { name: "after", type: "string" },
      ],
    },
    { name: "imageList", fields: [{ name: "images", type: "string", list: true }] },
    { name: "generatedImages", fields: [{ name: "image", type: "string" }] },
    {
      name: "blog",
      fields: [
        { name: "hero", type: "reference" },
        { name: "cards", type: "object", list: true, fields: [{ name: "art", type: "reference" }] },
      ],
    },
  ],
  loaders,
);

test("discovers image libraries and their diagnostics", () => {
  assert(config.mediaLibraries?.length === 2, "yaml and json libraries discovered");
  assert(config.mediaLibraries[0].imageFieldPath.join(".") === "asset.source", "path preserved");
  assert(
    config.mediaLibraries[0].fields[0].fields?.[0].type === "image",
    "only nested field upgraded",
  );
  assert(
    config.diagnostics?.some((item) => item.code === "multiple-image-fields"),
    "ambiguity diagnosed",
  );
  assert(
    config.diagnostics?.some((item) => item.code === "unsupported-image-shape"),
    "image arrays diagnosed",
  );
  assert(
    config.diagnostics?.some((item) => item.code === "custom-entry-ids"),
    "custom IDs diagnosed",
  );
  const blog = config.content.find((entry) => entry.name === "blog");
  assert(
    blog?.fields[0].options?.idScheme === "framework",
    "top-level reference keeps Astro ID semantics",
  );
  assert(
    blog?.fields[1].fields?.[0].options?.idScheme === "framework",
    "nested reference keeps Astro ID semantics",
  );
});

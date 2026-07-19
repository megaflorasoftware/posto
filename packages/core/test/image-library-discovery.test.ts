import { buildAstroConfig, markImageLibraryReferences, parseLoaderConfig } from "../src/astro/collections";
import type { Field } from "../src/pagescms/config";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const loaders = parseLoaderConfig(`
export const imageSchema = ({ image }) => z.object({
  asset: z.object({ source: image(), alt: z.string() }),
});
const images = defineCollection({
  loader: glob({ pattern: "**/*.{yml,yaml}", base: "./src/data/images" }),
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
const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/blog" }),
  schema: z.object({ hero: reference("images"), cards: z.array(z.object({ art: reference("images") })) }),
});
export const collections = { images, jsonImages, gallery, blog };
`);

assert(loaders.get("images")?.images?.[0]?.join(".") === "asset.source", "external nested image schema path");
assert(loaders.get("gallery")?.images?.length === 2, "multiple images retained");

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
    { name: "jsonImages", fields: [{ name: "image", type: "string" }, { name: "caption", type: "string" }] },
    { name: "gallery", fields: [{ name: "before", type: "string" }, { name: "after", type: "string" }] },
    { name: "blog", fields: [{ name: "hero", type: "reference" }, { name: "cards", type: "object", list: true, fields: [{ name: "art", type: "reference" }] }] },
  ],
  loaders,
);

assert(config.imageLibraries?.length === 2, "yaml and json libraries discovered");
assert(config.imageLibraries[0].imageFieldPath.join(".") === "asset.source", "path preserved");
assert(config.imageLibraries[0].fields[0].fields?.[0].type === "image", "only nested field upgraded");
assert(config.imageLibraryDiagnostics?.[0]?.code === "multiple-image-fields", "ambiguity diagnosed");
const blog = config.content.find((entry) => entry.name === "blog");
assert(blog?.fields[0].options?.imageLibrary === true, "top-level reference marked");
assert(blog?.fields[1].fields?.[0].options?.imageLibrary === true, "nested reference marked");
const pagesOverride = markImageLibraryReferences(
  [{ name: "hero", type: "reference", options: { collection: "images", label: "{primary}" } }],
  config.imageLibraries ?? [],
);
assert(pagesOverride[0].options?.imageLibrary === true, ".pages reference marked");
assert(pagesOverride[0].options?.label === "{primary}", ".pages options preserved");

console.log("image library discovery tests passed");

import { buildAstroConfig, parseLoaderConfig } from "../src/astro/collections";
import type { Field } from "../src/pagescms/config";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const loaders = parseLoaderConfig(`
const images = defineCollection({
  loader: glob({ pattern: "**/*.{yml,yaml}", base: "./src/data/images" }),
  schema: ({ image }) => z.object({
    details: z.object({ source: image(), alt: z.string() }),
  }),
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

assert(loaders.get("images")?.images?.[0]?.join(".") === "details.source", "nested image path");
assert(loaders.get("gallery")?.images?.length === 2, "multiple images retained");

const nested: Field = {
  name: "details",
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
assert(config.imageLibraries[0].imageFieldPath.join(".") === "details.source", "path preserved");
assert(config.imageLibraries[0].fields[0].fields?.[0].type === "image", "only nested field upgraded");
assert(config.imageLibraryDiagnostics?.[0]?.code === "multiple-image-fields", "ambiguity diagnosed");
const blog = config.content.find((entry) => entry.name === "blog");
assert(blog?.fields[0].options?.imageLibrary === true, "top-level reference marked");
assert(blog?.fields[1].fields?.[0].options?.imageLibrary === true, "nested reference marked");

console.log("image library discovery tests passed");

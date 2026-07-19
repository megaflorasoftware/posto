import {
  indexMdxMediaReferences,
  indexSchemaMediaReferences,
  mergeMediaReferenceIndexes,
} from "../src/astro/mediaReferences";
import type { Field } from "../src/pagescms/config";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const reference: Field = {
  name: "image",
  type: "reference",
  options: { collection: "images", astroId: true, imageLibrary: true },
};
const structured = indexSchemaMediaReferences({
  sourcePath: "/site/src/blog/post.mdx",
  fields: [
    { ...reference, name: "hero", required: true },
    { name: "cards", type: "object", list: true, fields: [{ ...reference, name: "art" }] },
  ],
  values: { hero: "sunrise", cards: [{ art: "forest" }, { art: "ocean" }] },
});
assert(structured.usages.length === 3, "top-level and nested list references indexed");
assert(structured.usages[0].required, "required status retained");
assert(structured.usages[2].valuePath?.join(".") === "cards.1.art", "nested value path retained");

const mdx = indexMdxMediaReferences({
  sourcePath: "/site/src/blog/post.mdx",
  source: '<Picture image="forest" /><Picture image={selected} />',
  components: [{ name: "Picture", fields: [{ ...reference, required: true }] }],
});
assert(mdx.usages[0].entryId === "forest", "literal component id indexed");
assert(!mdx.complete && mdx.errors.length === 1, "dynamic prop makes coverage incomplete");

const merged = mergeMediaReferenceIndexes([structured, mdx]);
assert(merged.usages.length === 4 && !merged.complete, "indexes merged conservatively");

console.log("media reference tests passed");

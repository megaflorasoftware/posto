import { test } from "vitest";
import { generateFilename, renamedFilename, type ContentEntry } from "../src/pagescms/config";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const blog: ContentEntry = {
  name: "blog",
  type: "collection",
  path: "src/blog",
  fields: [
    { name: "title", type: "string" },
    { name: "slug", type: "string" },
  ],
};

const values = { title: "A Different Title", slug: "custom-slug" };

test("generates filenames from explicit and legacy slug tokens", () => {
  assert(
    generateFilename("{fields.slug}.mdx", blog, values) === "custom-slug.mdx",
    "an explicit fields.slug token uses the actual slug field",
  );
  assert(
    generateFilename("{slug}.mdx", blog, values) === "a-different-title.mdx",
    "the legacy bare slug token remains an alias for the primary field",
  );
});

test("produces a rename target when the slug changes", () => {
  assert(
    renamedFilename("{fields.slug}.mdx", blog, values, "a-different-title.mdx") ===
      "custom-slug.mdx",
    "editing the slug produces a rename target",
  );
});

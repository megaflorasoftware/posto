import { parseAstroProps, parseAstroPropsType, type AstroPropDef } from "../src/mdx/mdx";
import { astroPropField } from "../src/mdx/propFields";
import { buildAstroConfig, parseLoaderConfig } from "../src/astro/collections";
import type { ContentEntry, Field } from "../src/pagescms/config";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function prop(defs: AstroPropDef[], name: string): AstroPropDef {
  const found = defs.find((def) => def.name === name);
  assert(found, `missing prop ${name}`);
  return found;
}

function field(defs: AstroPropDef[], name: string, collections: ContentEntry[]): Field | null {
  return astroPropField(prop(defs, name), { collections, editableCollections: collections });
}

const posts: ContentEntry = {
  name: "posts",
  label: "Posts",
  type: "collection",
  path: "src/content/posts",
  fields: [
    { name: "title", type: "string", required: true },
    {
      name: "author",
      type: "object",
      fields: [{ name: "name", type: "string", required: true }],
    },
  ],
};
const authors: ContentEntry = {
  name: "authors",
  type: "collection",
  path: "src/content/authors",
  fields: [{ name: "name", type: "string" }],
};
const collections = [posts, authors];

const defs = parseAstroProps(`---
import type {
  CollectionEntry as Entry,
  CollectionKey as Key,
  SchemaContext as Context,
} from 'astro:content';
import type * as Content from 'astro:content';

type Post = Entry<'posts'>;
type PostData = Post['data'];

interface Props {
  entry: Post;
  data: PostData;
  title: Entry<'posts'>['data']['title'];
  authorName: Content.CollectionEntry<'posts'>['data']['author']['name'];
  id: Entry<'posts'>['id'];
  filePath?: Entry<'posts'>['filePath'];
  collection: Entry<'posts'>['collection'];
  body?: Entry<'posts'>['body'];
  rendered?: Entry<'posts'>['rendered'];
  collectionKey: Key;
  context: Context;
  inlineKey: import('astro:content').CollectionKey;
}
---
<slot />`);

assert(prop(defs, "entry").type === "CollectionEntry<'posts'>", "local entry alias");
assert(prop(defs, "data").type === "CollectionEntry<'posts'>['data']", "nested local alias");
assert(field(defs, "entry", collections) === null, "full entries stay raw expressions");

const data = field(defs, "data", collections);
assert(data?.type === "object", "entry data is an object form");
assert(data.fields?.map((item) => item.name).join(",") === "title,author", "data uses schema fields");
assert(field(defs, "title", collections)?.type === "string", "nested data scalar");
assert(field(defs, "authorName", collections)?.type === "string", "nested object scalar");

const id = field(defs, "id", collections);
assert(id?.type === "reference" && id.options?.astroId === true, "id uses Astro reference values");
const filePath = field(defs, "filePath", collections);
assert(filePath?.type === "reference" && !filePath.options?.astroId, "filePath uses source paths");
assert(field(defs, "collection", collections)?.options?.values?.[0] === "posts", "collection literal");
assert(field(defs, "body", collections)?.type === "text", "body is editable text");
assert(field(defs, "rendered", collections) === null, "rendered content stays raw");

for (const name of ["collectionKey", "inlineKey"]) {
  const key = field(defs, name, collections);
  assert(key?.type === "select", `${name} is a collection selector`);
  const values = key.options?.values;
  assert(Array.isArray(values) && values.join(",") === "posts,authors", `${name} lists collections`);
}
assert(field(defs, "context", collections) === null, "SchemaContext stays raw");

const wholePropsType = parseAstroPropsType(`---
import type { CollectionEntry } from 'astro:content';
type PostData = CollectionEntry<'posts'>['data'];
type Props = PostData;
---`);
assert(wholePropsType === "CollectionEntry<'posts'>['data']", "whole Props data alias resolves");
const wholePropsField = astroPropField(
  { name: "Props", type: wholePropsType ?? "", optional: false },
  { collections, editableCollections: collections },
);
assert(wholePropsField?.fields?.map((item) => item.name).join(",") === "title,author", "whole Props alias expands schema fields");

const loaders = parseLoaderConfig(`
const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/data/posts' }),
  schema: z.object({ author: reference('customIds') }),
});
const customIds = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/data/custom', generateId: ({ data }) => data.key }),
  schema: z.object({ title: z.string() }),
});
const data = defineCollection({
  loader: file('src/data/items.json'),
  schema: z.object({ title: z.string() }),
});
const remote = defineCollection({
  loader: remoteLoader(),
  schema: z.object({ title: z.string() }),
});
export const collections = { posts, customIds, data, remote };
`);
assert(loaders.get("posts")?.kind === "glob", "glob loader detected");
assert(loaders.get("customIds")?.customIds === true, "custom generateId detected");
assert(loaders.get("data")?.kind === "file", "file loader detected");
assert(loaders.get("remote")?.kind === "custom", "custom loader detected");

const astroConfig = buildAstroConfig(
  [
    { name: "posts", fields: [{ name: "author", type: "reference" }] },
    { name: "customIds", fields: [{ name: "title", type: "string" }] },
    { name: "data", fields: [{ name: "title", type: "string" }] },
    { name: "remote", fields: [{ name: "title", type: "string" }] },
  ],
  loaders,
);
assert(astroConfig.content.map((entry) => entry.name).join(",") === "posts,customIds,data", "local editable loaders enter sidebar config");
assert(astroConfig.content[2].dataFile?.path === "src/data/items.json", "file loader exposes backing document");
assert(astroConfig.astroCollections?.map((entry) => entry.name).join(",") === "posts,customIds,data,remote", "all build-time schemas enter type registry");
assert(astroConfig.content[0].fields[0].type === "string", "custom generated reference ids stay manual strings");

const customIdDef: AstroPropDef = {
  name: "customId",
  type: "CollectionEntry<'customIds'>['id']",
  optional: false,
};
const customIdField = astroPropField(customIdDef, {
  collections: astroConfig.astroCollections ?? [],
  editableCollections: astroConfig.content,
});
assert(customIdField?.type === "string", "custom generated entry ids do not use a wrong picker");

const mediaIdField = astroPropField(
  { name: "media", type: "CollectionEntry<'media'>['id']", optional: false },
  {
    collections: [{ name: "media", fields: [{ name: "image", type: "image" }] }],
    editableCollections: [],
    imageLibraries: [{
      collection: "media",
      base: "src/media",
      patterns: ["**/*.{yml,yaml}", "!videos/**/*.{yml,yaml}"],
      metadataExtensions: ["yml", "yaml"],
      imageFieldPath: ["image"],
      fields: [{ name: "image", type: "image" }, { name: "alt", type: "string" }],
    }],
  },
);
assert(mediaIdField?.type === "reference" && mediaIdField.options?.astroId === true, "image-library IDs use the picker without entering sidebar content");

console.log("astro-content component prop tests passed");

import { test } from "vitest";
import {
  parseAstroExportedType,
  parseAstroProps,
  parseAstroPropsType,
  type AstroPropDef,
} from "../src/mdx/mdx";
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

test("resolves aliased collection entry types", () => {
  assert(prop(defs, "entry").type === "CollectionEntry<'posts'>", "local entry alias");
  assert(prop(defs, "data").type === "CollectionEntry<'posts'>['data']", "nested local alias");
  assert(field(defs, "entry", collections) === null, "full entries stay raw expressions");
});

test("expands entry data into its schema fields", () => {
  const data = field(defs, "data", collections);
  assert(data?.type === "object", "entry data is an object form");
  assert(
    data.fields?.map((item) => item.name).join(",") === "title,author",
    "data uses schema fields",
  );
  assert(field(defs, "title", collections)?.type === "string", "nested data scalar");
  assert(field(defs, "authorName", collections)?.type === "string", "nested object scalar");
});

test("maps Astro entry metadata accessors to fields", () => {
  const id = field(defs, "id", collections);
  assert(
    id?.type === "reference" && id.options?.idScheme === "framework",
    "id uses Astro reference values",
  );
  const filePath = field(defs, "filePath", collections);
  assert(
    filePath?.type === "reference" && !filePath.options?.idScheme,
    "filePath uses source paths",
  );
  assert(
    (field(defs, "collection", collections)?.options?.values as unknown[] | undefined)?.[0] ===
      "posts",
    "collection literal",
  );
  assert(field(defs, "body", collections)?.type === "text", "body is editable text");
  assert(field(defs, "rendered", collections) === null, "rendered content stays raw");
});

test("turns collection-key types into selectors", () => {
  for (const name of ["collectionKey", "inlineKey"]) {
    const key = field(defs, name, collections);
    assert(key?.type === "select", `${name} is a collection selector`);
    const values = key.options?.values;
    assert(
      Array.isArray(values) && values.join(",") === "posts,authors",
      `${name} lists collections`,
    );
  }
  assert(field(defs, "context", collections) === null, "SchemaContext stays raw");
});

test("expands a whole-Props data alias", () => {
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
  assert(
    wholePropsField?.fields?.map((item) => item.name).join(",") === "title,author",
    "whole Props alias expands schema fields",
  );
});

const { loaders } = parseLoaderConfig(`
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

test("detects loader kinds from an Astro content config", () => {
  assert(loaders.get("posts")?.kind === "glob", "glob loader detected");
  assert(loaders.get("customIds")?.customIds === true, "custom generateId detected");
  assert(loaders.get("data")?.kind === "file", "file loader detected");
  assert(loaders.get("remote")?.kind === "custom", "custom loader detected");
});

const astroConfig = buildAstroConfig(
  [
    { name: "posts", fields: [{ name: "author", type: "reference" }] },
    { name: "customIds", fields: [{ name: "title", type: "string" }] },
    { name: "data", fields: [{ name: "title", type: "string" }] },
    { name: "remote", fields: [{ name: "title", type: "string" }] },
  ],
  loaders,
);

test("builds sidebar config and a type registry from loaders", () => {
  assert(
    astroConfig.content.map((entry) => entry.name).join(",") === "posts,customIds,data",
    "local editable loaders enter sidebar config",
  );
  assert(
    astroConfig.content[2].dataFile?.path === "src/data/items.json",
    "file loader exposes backing document",
  );
  assert(
    astroConfig.collectionSchemas?.map((entry) => entry.name).join(",") ===
      "posts,customIds,data,remote",
    "all build-time schemas enter type registry",
  );
  assert(
    astroConfig.content[0].fields[0].type === "string",
    "custom generated reference ids stay manual strings",
  );
});

test("keeps custom generated entry ids as manual strings", () => {
  const customIdDef: AstroPropDef = {
    name: "customId",
    type: "CollectionEntry<'customIds'>['id']",
    optional: false,
  };
  const customIdField = astroPropField(customIdDef, {
    collections: astroConfig.collectionSchemas ?? [],
    editableCollections: astroConfig.content,
  });
  assert(customIdField?.type === "string", "custom generated entry ids do not use a wrong picker");
});

test("resolves image-library ids without adding sidebar content", () => {
  const mediaIdField = astroPropField(
    { name: "media", type: "CollectionEntry<'media'>['id']", optional: false },
    {
      collections: [{ name: "media", fields: [{ name: "image", type: "image" }] }],
      editableCollections: [],
      mediaLibraries: [
        {
          collection: "media",
          base: "src/media",
          patterns: ["**/*.{yml,yaml}", "!videos/**/*.{yml,yaml}"],
          metadataExtensions: ["yml", "yaml"],
          imageFieldPath: ["image"],
          fields: [
            { name: "image", type: "image" },
            { name: "alt", type: "string" },
          ],
        },
      ],
    },
  );
  assert(
    mediaIdField?.type === "reference" && mediaIdField.options?.idScheme === "framework",
    "image-library IDs use the picker without entering sidebar content",
  );
});

const mediaContext = {
  collections: [{ name: "media", fields: [{ name: "image", type: "image" }] }],
  editableCollections: [],
  mediaLibraries: [
    {
      collection: "media",
      base: "src/media",
      patterns: ["**/*.{yml,yaml}"],
      metadataExtensions: ["yml", "yaml"] as ("yml" | "yaml")[],
      imageFieldPath: ["image"],
      fields: [
        { name: "image", type: "image" },
        { name: "alt", type: "string" },
      ],
    },
  ],
};

test("resolves media ids inside object and array shapes", () => {
  const mediaShapeDefs = parseAstroProps(`---
import type { CollectionEntry } from 'astro:content';
interface Props {
  mediaObject: { media: CollectionEntry<'media'>['id']; caption: string };
  mediaIds: CollectionEntry<'media'>['id'][];
  mediaItems: { media: CollectionEntry<'media'>['id']; caption: string }[];
}
---`);
  const mediaObject = astroPropField(prop(mediaShapeDefs, "mediaObject"), mediaContext);
  assert(mediaObject?.type === "object", "media IDs resolve inside objects");
  assert(mediaObject.fields?.[0].type === "reference", "object media member uses picker");
  const mediaIds = astroPropField(prop(mediaShapeDefs, "mediaIds"), mediaContext);
  assert(
    mediaIds?.type === "reference" && mediaIds.list === true,
    "media ID arrays use reorderable pickers",
  );
  const mediaItems = astroPropField(prop(mediaShapeDefs, "mediaItems"), mediaContext);
  assert(
    mediaItems?.type === "object" && mediaItems.list === true,
    "media object arrays are reorderable",
  );
  assert(mediaItems.fields?.[0].type === "reference", "object-array media member uses picker");
});

test("resolves media ids through imported component types", () => {
  const exportedMediaItem = parseAstroExportedType(
    `---
import type { CollectionEntry } from 'astro:content';
export interface PolaroidMediaItem {
  media: CollectionEntry<'media'>['id'];
  caption: string;
}
---`,
    "PolaroidMediaItem",
  );
  assert(exportedMediaItem, "exported component type resolves");
  const importedAliasDefs = parseAstroProps(
    `---
import type { PolaroidMediaItem } from './PolaroidStack.astro';
export interface Props { media: PolaroidMediaItem[] }
---`,
    { PolaroidMediaItem: exportedMediaItem },
  );
  const importedMedia = astroPropField(prop(importedAliasDefs, "media"), mediaContext);
  assert(
    importedMedia?.type === "object" && importedMedia.list === true,
    "HomeIntro imported media items are reorderable",
  );
  assert(
    importedMedia.fields?.[0].type === "reference",
    "HomeIntro imported media item uses picker",
  );
});

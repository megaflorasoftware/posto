import { describe, expect, test } from "vitest";
import {
  buildAstroConfig,
  parseCollectionSchema,
  parseLoaderConfig,
} from "../src/astro/collections";
import { fieldDefaultAnnotation } from "../src/posto/annotations";
import {
  cdnObjectForUrl,
  cdnObjectKey,
  cdnObjectUrl,
  mediaSourceAnnotation,
  parseCdnSources,
} from "../src/media/sources";
import { mediaInputPath, type MediaLibrary, type PagesConfig } from "../src/pagescms/config";
import {
  discoverImageLibraryAssets,
  imageDimensionFields,
  withImageDimensions,
} from "../src/project/mediaLibrary";
import {
  mergePostoConfig,
  parsePostoIndex,
  updatePostoIndexSource,
  type PostoConfig,
} from "../src/posto/config";

const bunny = {
  name: "cdn",
  label: "CDN",
  provider: "bunny",
  bucket: "my-site-media",
  region: "ny",
  prefix: "/images/",
  publicUrl: "https://media.example.com/",
};

describe("mediaSourceAnnotation", () => {
  test.each([
    ['image().describe("posto:media=cdn")', "cdn"],
    ["image().describe('posto:media=photo_cdn-2')", "photo_cdn-2"],
    ["image().optional().describe(`Hero art posto:media=cdn`)", "cdn"],
    ['z.optional(image().describe("posto:media=cdn\tfor heroes"))', "cdn"],
  ])("reads %s", (expression, source) => {
    expect(mediaSourceAnnotation(expression)).toBe(source);
  });

  test.each([
    "image()",
    'image().describe("Stored locally")',
    'image().describe("xposto:media=cdn")',
    'image().describe("posto:media=")',
    '/* .describe("posto:media") */ image()',
  ])("ignores %s", (expression) => {
    expect(mediaSourceAnnotation(expression)).toBeUndefined();
  });
});

describe("parseCdnSources", () => {
  test("normalizes a Bunny source", () => {
    expect(parseCdnSources([bunny])).toEqual([
      { ...bunny, prefix: "images", publicUrl: "https://media.example.com" },
    ]);
  });

  test("keeps S3 connection settings", () => {
    const [source] = parseCdnSources([
      {
        name: "r2",
        provider: "s3",
        bucket: "media",
        region: "auto",
        endpoint: "https://account.r2.cloudflarestorage.com/",
        pathStyle: true,
        publicUrl: "https://cdn.example.com/site",
      },
    ])!;
    expect(source.endpoint).toBe("https://account.r2.cloudflarestorage.com");
    expect(source.pathStyle).toBe(true);
    expect(source.publicUrl).toBe("https://cdn.example.com/site");
  });

  test.each([
    ["an unknown provider", { provider: "ftp" }],
    ["a name schemas cannot reference", { name: "my cdn" }],
    ["a missing bucket", { bucket: " " }],
    ["an insecure public URL", { publicUrl: "http://media.example.com" }],
    ["credentials in the public URL", { publicUrl: "https://user:secret@media.example.com" }],
    ["a query in the public URL", { publicUrl: "https://media.example.com?token=secret" }],
    ["a prefix that escapes its folder", { prefix: "images/../private" }],
    ["a Windows-style prefix", { prefix: "images\\private" }],
  ])("drops %s", (_label, change) => {
    expect(parseCdnSources([{ ...bunny, ...change }])).toBeUndefined();
  });

  test("requires an https endpoint for S3", () => {
    const source = { ...bunny, provider: "s3" };
    expect(parseCdnSources([source])).toBeUndefined();
    expect(parseCdnSources([{ ...source, endpoint: "http://s3.example.com" }])).toBeUndefined();
  });

  test("keeps valid entries and the first definition of a name", () => {
    const sources = parseCdnSources([
      "invalid",
      bunny,
      { ...bunny, bucket: "ignored-duplicate" },
      { ...bunny, name: "archive", bucket: "archive-media" },
    ]);
    expect(sources?.map((source) => source.bucket)).toEqual(["my-site-media", "archive-media"]);
  });

  test("ignores a value that is not a list", () => {
    expect(parseCdnSources(bunny)).toBeUndefined();
  });
});

describe(".posto/index.json media sources", () => {
  test("parses sources alongside existing settings", () => {
    const index = parsePostoIndex(
      JSON.stringify({ collections: { order: ["posts"] }, media: { sources: [bunny] } }),
    );
    expect(index.collectionOrder).toEqual(["posts"]);
    expect(index.mediaSources?.[0].name).toBe("cdn");
  });

  test("collection order updates preserve sources", () => {
    const source = JSON.stringify({ version: 0, media: { sources: [bunny] } });
    const updated = updatePostoIndexSource(source, ["posts"]);
    expect(parsePostoIndex(updated).mediaSources?.[0].bucket).toBe("my-site-media");
  });
});

describe("Astro schema bindings", () => {
  const { loaders } = parseLoaderConfig(`
const photos = defineCollection({
  loader: glob({ pattern: "**/*.yaml", base: "./src/data/photos" }),
  schema: ({ image }) => z.object({
    src: image().describe("posto:media=cdn"),
    alt: z.string(),
  }),
});
const local = defineCollection({
  loader: glob({ pattern: "**/*.yaml", base: "./src/data/local" }),
  schema: ({ image }) => z.object({ src: image() }),
});
const posts = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/posts" }),
  schema: ({ image }) => z.object({
    meta: z.object({ hero: image().optional().describe("posto:media=cdn") }),
  }),
});
export const collections = { photos, local, posts };
`);
  const config = buildAstroConfig(
    [
      {
        name: "photos",
        fields: [
          { name: "src", type: "string" },
          { name: "alt", type: "string" },
        ],
      },
      { name: "local", fields: [{ name: "src", type: "string" }] },
      {
        name: "posts",
        fields: [{ name: "meta", type: "object", fields: [{ name: "hero", type: "string" }] }],
      },
    ],
    loaders,
  );

  test("carries the source onto libraries", () => {
    const libraries = new Map(config.mediaLibraries?.map((item) => [item.collection, item]));
    expect(libraries.get("photos")?.mediaSource).toBe("cdn");
    expect(libraries.get("local")?.mediaSource).toBeUndefined();
  });

  test("carries the source onto nested image fields", () => {
    const hero = config.content.find((entry) => entry.name === "posts")?.fields[0].fields?.[0];
    expect(hero?.type).toBe("image");
    expect(hero?.options?.mediaSource).toBe("cdn");
    expect(hero?.options?.media).toBeUndefined();
  });

  test("reports each collection bound to an undefined source", () => {
    const merged = mergePostoConfig(config, null);
    const unknown = merged.diagnostics?.filter((item) => item.code === "unknown-media-source");
    expect(unknown?.map((item) => item.collection).sort()).toEqual(["photos", "posts"]);
    expect(merged.cdnSources).toBeUndefined();
  });

  test("attaches a defined source without diagnostics", () => {
    const posto: PostoConfig = { collections: {}, mediaSources: parseCdnSources([bunny]) };
    const merged = mergePostoConfig(config, posto);
    expect(merged.cdnSources?.[0].name).toBe("cdn");
    expect(merged.diagnostics?.some((item) => item.feature === "cdn-media")).toBe(false);
  });
});

describe("CDN object keys", () => {
  const sha256 = "1a2b3c4d".repeat(8);

  test.each([
    ["images", "trips", "harbor.jpg", "images/trips/harbor-1a2b3c4d.jpg"],
    [undefined, "", "harbor.JPG", "harbor-1a2b3c4d.jpg"],
    [
      "images",
      "My Trips/2026",
      "Sunset at Sea (1).jpeg",
      "images/My-Trips/2026/Sunset-at-Sea-1-1a2b3c4d.jpeg",
    ],
    ["images", "../secret/./", "..hidden.png", "images/secret/hidden-1a2b3c4d.png"],
    ["images", "", "日本語.webp", "images/image-1a2b3c4d.webp"],
    ["images", "", "no-extension", "images/no-extension-1a2b3c4d"],
  ])("prefix %s, folder %s, file %s", (prefix, folder, filename, key) => {
    expect(cdnObjectKey({ prefix }, folder, filename, sha256)).toBe(key);
  });

  test("builds public URLs from keys", () => {
    const source = { publicUrl: "https://media.example.com/site" };
    expect(cdnObjectUrl(source, "images/a-1a2b3c4d.jpg")).toBe(
      "https://media.example.com/site/images/a-1a2b3c4d.jpg",
    );
  });
});

describe("CDN URLs", () => {
  const sources = parseCdnSources([
    { ...bunny, name: "a", prefix: "images" },
    { ...bunny, name: "b", publicUrl: "https://other.example.com", prefix: undefined },
  ])!;

  test("finds the source and key behind a URL", () => {
    expect(cdnObjectForUrl(sources, "https://media.example.com/images/a%20b-1a2b3c4d.jpg")).toEqual(
      { source: sources[0], key: "images/a b-1a2b3c4d.jpg" },
    );
    expect(cdnObjectForUrl(sources, "https://other.example.com/x.jpg")?.source.name).toBe("b");
  });

  test.each([
    "https://elsewhere.example.com/images/a.jpg",
    "https://media.example.com/private/a.jpg",
    "https://media.example.com/images/../secret.jpg",
    "https://media.example.com/images/%E0%A4%A.jpg",
    "https://media.example.com/images/",
  ])("rejects %s", (url) => {
    expect(cdnObjectForUrl(sources, url)).toBeNull();
  });
});

describe("library image dimensions", () => {
  const from = (value: string) => ({ defaultFrom: { field: ["asset", "src"], value } });
  const width = { name: "width", type: "number", options: from("width") };
  const height = { name: "height", type: "number", options: from("height") };
  const nested: MediaLibrary = {
    collection: "photos",
    base: "src/data/photos",
    patterns: ["**/*.yaml"],
    metadataExtensions: ["yaml"],
    imageFieldPath: ["asset", "src"],
    fields: [
      {
        name: "asset",
        type: "object",
        fields: [{ name: "src", type: "image" }, width, height],
      },
    ],
  };

  test("finds annotated dimension fields anywhere in the entry", () => {
    expect(imageDimensionFields(nested)).toEqual({
      width: [["asset", "width"]],
      height: [["asset", "height"]],
    });
  });

  test("ignores fields that are only named width and height", () => {
    const plain = {
      ...nested,
      fields: [
        {
          ...nested.fields[0],
          fields: [
            { name: "src", type: "image" },
            { name: "width", type: "number" },
            { name: "height", type: "number" },
          ],
        },
      ],
    };
    expect(imageDimensionFields(plain)).toBeNull();
    expect(withImageDimensions(plain, {}, { width: 40, height: 20 })).toEqual({});
  });

  test("fills empty fields without changing the original metadata", () => {
    const metadata = { asset: { alt: "Harbor" } };
    expect(withImageDimensions(nested, metadata, { width: 40, height: 20 })).toEqual({
      asset: { alt: "Harbor", width: 40, height: 20 },
    });
    expect(metadata).toEqual({ asset: { alt: "Harbor" } });
  });

  test("keeps dimensions that are already set", () => {
    expect(
      withImageDimensions(nested, { asset: { width: 1200 } }, { width: 40, height: 20 }),
    ).toEqual({ asset: { width: 1200, height: 20 } });
  });

  test("parses the annotations from generated schemas", () => {
    const fields = parseCollectionSchema(
      "photos",
      JSON.stringify({
        type: "object",
        properties: {
          width: { type: "number", description: "image:default=width" },
          height: { type: "number", description: "image:default=height" },
        },
      }),
    )!;
    expect(fields.map((field) => field.options?.defaultFrom)).toEqual([
      { field: ["image"], value: "width" },
      { field: ["image"], value: "height" },
    ]);
  });
});

describe("published image values", () => {
  const library: MediaLibrary = {
    collection: "photos",
    base: "src/data/photos",
    patterns: ["**/*.yaml"],
    metadataExtensions: ["yaml"],
    imageFieldPath: ["src"],
    fields: [],
  };
  const url = "https://media.example.com/images/harbor-1a2b3c4d.jpg";
  const entry = (name: string, src: string) => ({
    path: `/site/src/data/photos/${name}.yaml`,
    content: `src: ${src}\nalt: Harbor\n`,
  });

  test("a CDN URL is a valid library image with no local path", () => {
    const [asset] = discoverImageLibraryAssets(library, "/site", [entry("harbor", url)], []);
    expect(asset.imagePath).toBeNull();
    expect(asset.imageUrl).toBe(url);
    expect(asset.health).toEqual(["valid"]);
  });

  test("entries may share one CDN URL", () => {
    const assets = discoverImageLibraryAssets(
      library,
      "/site",
      [entry("one", url), entry("two", url)],
      [],
    );
    expect(assets.map((asset) => asset.health)).toEqual([["valid"], ["valid"]]);
  });

  test("local images in the same library keep their local path", () => {
    const [asset] = discoverImageLibraryAssets(
      library,
      "/site",
      [entry("local", "./local.jpg")],
      ["/site/src/data/photos/local.jpg"],
    );
    expect(asset.imagePath).toBe("/site/src/data/photos/local.jpg");
    expect(asset.imageUrl).toBeUndefined();
  });

  test("a CDN URL never resolves to a local media path", () => {
    expect(mediaInputPath("/site", { name: "public", input: "public", output: "/" }, url)).toBe(
      null,
    );
  });
});

test("configs without CDN media pass through unchanged", () => {
  const config: PagesConfig = { media: [], content: [] };
  expect(mergePostoConfig(config, null)).toBe(config);
  expect(mergePostoConfig(config, { collections: {} })).toBe(config);
});

describe("field default annotations", () => {
  test.each([
    ["image:default=capture-date", { field: ["image"], value: "capture-date" }],
    ["When it was taken. src:default=capture-date", { field: ["src"], value: "capture-date" }],
    ["asset.src:default=width", { field: ["asset", "src"], value: "width" }],
    ["posto:media=cdn image:default=height", { field: ["image"], value: "height" }],
    ["posto:default=capture-date", undefined],
    ["image:default=camera", undefined],
    ["image:default=", undefined],
    ["image.:default=width", undefined],
    [undefined, undefined],
  ])("reads %s", (description, expected) => {
    expect(fieldDefaultAnnotation(description)).toEqual(expected);
  });

  test("schema fields carry the annotation, including nested and optional ones", () => {
    const fields = parseCollectionSchema(
      "photos",
      JSON.stringify({
        type: "object",
        properties: {
          taken_at: {
            type: "string",
            format: "date-time",
            description: "image:default=capture-date",
          },
          meta: {
            type: "object",
            properties: {
              shot: {
                anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
                description: "image:default=capture-date",
              },
            },
          },
          alt: { type: "string", description: "Shown to screen readers" },
        },
        required: ["alt"],
      }),
    )!;
    const byName = new Map(fields.map((field) => [field.name, field]));
    const source = { field: ["image"], value: "capture-date" };
    expect(byName.get("taken_at")).toMatchObject({
      type: "date",
      options: { defaultFrom: source },
    });
    expect(byName.get("meta")?.fields?.[0].options?.defaultFrom).toEqual(source);
    expect(byName.get("alt")?.options?.defaultFrom).toBeUndefined();
  });

  test("only annotations naming the library's image field are used", () => {
    const { loaders } = parseLoaderConfig(`
const photos = defineCollection({
  loader: glob({ pattern: "**/*.yaml", base: "./src/data/photos" }),
  schema: ({ image }) => z.object({ src: image(), width: z.number(), height: z.number() }),
});
export const collections = { photos };
`);
    const config = buildAstroConfig(
      [
        {
          name: "photos",
          fields: parseCollectionSchema(
            "photos",
            JSON.stringify({
              type: "object",
              properties: {
                src: { type: "string" },
                width: { type: "number", description: "src:default=width" },
                height: { type: "number", description: "image:default=height" },
              },
            }),
          )!,
        },
      ],
      loaders,
    );
    const library = config.mediaLibraries![0];

    expect(imageDimensionFields(library)).toEqual({ width: [["width"]], height: [] });
    const warning = config.diagnostics?.find((item) => item.code === "unmatched-default-source");
    expect(warning?.message).toContain('field height takes its default from "image"');
  });
});

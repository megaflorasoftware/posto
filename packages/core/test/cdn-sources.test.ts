import { describe, expect, test } from "vitest";
import { buildAstroConfig, parseLoaderConfig } from "../src/astro/collections";
import { mediaSourceAnnotation, parseCdnSources } from "../src/media/sources";
import { mediaInputPath, type MediaLibrary, type PagesConfig } from "../src/pagescms/config";
import { discoverImageLibraryAssets } from "../src/project/mediaLibrary";
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

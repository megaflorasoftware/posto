import { describe, expect, test } from "vitest";
import { buildAstroConfig, parseLoaderConfig } from "../src/astro/collections";

describe("Astro schema diagnostics", () => {
  test("reports guessed exports and unclassified loaders", () => {
    const parsed = parseLoaderConfig(`
      const posts = defineCollection({
        loader: makeLoader(),
        schema: z.object({ title: z.string() }),
      });
    `);

    expect(parsed.loaders.get("posts")?.kind).toBe("custom");
    expect(parsed.diagnostics.map(({ code }) => code)).toEqual([
      "custom-loader",
      "missing-collections-export",
    ]);
  });

  test("uses exported names in custom-loader notices", () => {
    const parsed = parseLoaderConfig(`
      const postEntries = defineCollection({ loader: makeLoader() });
      export const collections = { posts: postEntries };
    `);

    expect(parsed.diagnostics[0]).toMatchObject({
      collection: "posts",
      code: "custom-loader",
    });
  });

  test("reports schemas with no matching content config entry", () => {
    const config = buildAstroConfig(
      [{ name: "orphaned", fields: [{ name: "title", type: "string" }] }],
      new Map(),
    );

    expect(config.content[0]?.path).toBe("src/content/orphaned");
    expect(config.schemaDiagnostics).toEqual([
      expect.objectContaining({
        collection: "orphaned",
        code: "missing-collection-config",
      }),
    ]);
  });
});

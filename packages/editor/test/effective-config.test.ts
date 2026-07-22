// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import type { PagesConfig } from "@posto/core/pagescms/config";
import { resolveEffectiveConfig } from "../src/hooks/useSchemas";

const pages: PagesConfig = {
  media: [{ name: "pages", input: "static/uploads", output: "/uploads" }],
  content: [
    {
      name: "posts",
      label: "Pages posts",
      type: "collection",
      path: "src/content/posts",
      fields: [{ name: "title", type: "string", label: "Title" }],
    },
  ],
};

const derived: PagesConfig = {
  media: [{ name: "framework", input: "public", output: "/" }],
  content: [
    {
      name: "posts",
      label: "Derived posts",
      type: "collection",
      path: "src/content/posts",
      fields: [{ name: "title", type: "string" }],
    },
    {
      name: "authors",
      type: "collection",
      path: "src/content/authors",
      fields: [{ name: "name", type: "string" }],
    },
  ],
  collectionSchemas: [{ name: "remote", fields: [{ name: "id", type: "string" }] }],
  diagnostics: [{ feature: "derived-config", code: "fixture", message: "Fixture diagnostic" }],
};

describe("effective config snapshots", () => {
  test("pages config wins while derived collections remain fallback entries", () => {
    expect(
      resolveEffectiveConfig(
        pages,
        derived,
        {
          collectionOrder: ["authors", "posts"],
          collections: { authors: { displayName: "People" } },
        },
        [{ name: "default", input: "public", output: "/" }],
      ),
    ).toMatchInlineSnapshot(`
      {
        "collectionSchemas": [
          {
            "fields": [
              {
                "name": "id",
                "type": "string",
              },
            ],
            "name": "remote",
          },
        ],
        "content": [
          {
            "fields": [
              {
                "label": "Title",
                "name": "title",
                "type": "string",
              },
            ],
            "label": "Pages posts",
            "name": "posts",
            "order": 1,
            "path": "src/content/posts",
            "type": "collection",
          },
          {
            "fields": [
              {
                "name": "title",
                "type": "string",
              },
            ],
            "label": "Derived posts",
            "name": "posts",
            "order": 1,
            "path": "src/content/posts",
            "type": "collection",
          },
          {
            "fields": [
              {
                "name": "name",
                "type": "string",
              },
            ],
            "label": "People",
            "name": "authors",
            "order": 0,
            "path": "src/content/authors",
            "type": "collection",
          },
        ],
        "diagnostics": [
          {
            "code": "fixture",
            "feature": "derived-config",
            "message": "Fixture diagnostic",
          },
        ],
        "media": [
          {
            "input": "static/uploads",
            "name": "pages",
            "output": "/uploads",
          },
        ],
        "mediaLibraries": undefined,
      }
    `);
  });

  test("derived media wins when Pages CMS declares none", () => {
    expect(resolveEffectiveConfig({ ...pages, media: [] }, derived, null, [])).toMatchObject({
      media: derived.media,
      content: [pages.content[0], ...derived.content],
    });
  });

  test("the adapter fallback survives when both schema layers are absent", () => {
    const fallback = [{ name: "default", input: "public", output: "/" }];
    expect(resolveEffectiveConfig(null, null, null, fallback)).toEqual({
      media: fallback,
      content: [],
      collectionSchemas: undefined,
      mediaLibraries: undefined,
      diagnostics: undefined,
    });
  });
});

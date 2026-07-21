---
title: Typed collections
description: How Posto maps Astro content collections and Zod schemas to editing forms, including what is not supported.
---

Each [content collection](https://docs.astro.build/en/guides/content-collections/) becomes an editable group in Posto, and each field in the collection's Zod schema becomes a form control. This page describes the mapping.

## Loaders → collections

A collection's [loader](https://docs.astro.build/en/guides/content-collections/#loading-data-with-loaders) determines how Posto presents it:

- **`glob()`** — a folder-backed collection. The loader's `base` sets the folder; its `pattern` sets the file type (`**/*.md` → Markdown) and whether subfolders are used. Each entry is one Markdown or MDX file.
- **`file()`** — a single-file data collection. One JSON, YAML, or TOML file holds many entries, edited one at a time.
- **Custom loaders** are not editable and do not appear as a collection.

Entry IDs follow Astro's default `generateId` (the frontmatter `slug`, otherwise the base-relative path slugified), so the filenames Posto manages match the site's URLs.

## Zod schema → form fields

Posto reads Astro's generated JSON Schema, so what matters is how each Zod type is represented there. The common cases:

| Zod schema                         | Posto field                                        |
| ---------------------------------- | -------------------------------------------------- |
| `z.string()`                       | Text input (honors `.min()`, `.max()`, `.regex()`) |
| `z.number()` / `z.number().int()`  | Number input (honors `.min()`, `.max()`)           |
| `z.boolean()`                      | Toggle switch                                      |
| `z.enum([...])` / `z.literal("x")` | Select dropdown                                    |
| `z.coerce.date()`                  | Date picker                                        |
| `z.array(...)`                     | Repeatable list (honors `.min()`, `.max()`)        |
| `z.object({...})`                  | Nested group of fields                             |
| `image()`                          | Image picker                                       |
| `reference("collection")`          | Dropdown of that collection's entries              |
| `.optional()` / `.nullable()`      | Same control, not required                         |

### `image()` and `reference()`

Astro compiles [`image()`](https://docs.astro.build/en/guides/images/#images-in-content-collections) and [`reference()`](https://docs.astro.build/en/guides/content-collections/#defining-collection-references) fields to plain strings in the generated schema, so Posto recovers them by scanning `content.config.ts`. It handles the common shapes: a bare `image()`, `z.array(image())`, `image()` nested inside a `z.object(...)`, and `reference("...")` optionally wrapped in `z.array(...)`.

```ts
// src/content.config.ts
const blog = defineCollection({
  loader: glob({ base: "./src/content/blog", pattern: "**/*.md" }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      cover: image(), // → image picker
      author: reference("authors"), // → dropdown of `authors` entries
    }),
});
```

If a schema is built dynamically or in a way the scanner cannot follow, these fields fall back to plain string inputs. Validation is unaffected; only the specialized control is lost.

## Not supported

These edit and validate correctly, but render as a plain **text** field rather than a specific control:

- **Unions of different types**, e.g. `z.union([z.string(), z.number()])`.
- **`z.custom()`, `z.any()`, `z.unknown()`**, and other schemas with no concrete shape.
- **Nested arrays** (an array of arrays) with no simple item shape.

Two further limits:

- **Non-Markdown `glob()` collections** (pure data files, Markdoc, etc.) are not shown as editable collections, because the form pipeline reads Markdown frontmatter. They are still read for resolving `reference()` targets.
- **Zod carries no editor metadata.** An Astro-only project has no field labels, media directories, or dropdown option labels. A [Pages CMS `.pages.yml`](/frameworks/pages-cms/getting-started/) alongside the Astro config can supply those.

:::note[Custom entry IDs] If a `glob()` loader uses a custom `generateId`, Posto cannot predict entry IDs. `reference()` fields to that collection become plain strings, and the collection cannot be managed as an image library. :::

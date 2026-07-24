---
title: Media libraries
description: Define an Astro image collection that Posto can import, organize, and reuse with its metadata.
---

A Posto media library is an Astro content collection that pairs each image with reusable metadata. When a collection matches the shape below, Posto imports, moves, renames, and deletes each image together with its metadata record. Selecting the image elsewhere carries that metadata with it. See [Managing site media](/features/managing-site-media/).

## What Posto recognizes

A collection is treated as a media library when all of these hold:

1. It uses a **`glob()` loader** with a static string `base`.
2. Its schema has **exactly one** [`image()`](https://docs.astro.build/en/guides/images/#images-in-content-collections) field, and that field is a scalar (nested only through objects, never inside a list).
3. The loader's `pattern` matches **YAML or JSON** metadata files.

Recognized image formats are `avif`, `gif`, `jpeg`, `jpg`, `png`, `svg`, `tif`, `tiff`, and `webp`.

## Example

This example defines a photo library in which each YAML entry describes one image:

```ts
// src/content.config.ts
import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const photos = defineCollection({
  loader: glob({ base: "./src/data/photos", pattern: "**/*.yaml" }),
  schema: ({ image }) =>
    z.object({
      src: image(), // the single image field
      alt: z.string(),
      credit: z.string().optional(),
    }),
});

export const collections = { photos };
```

```yaml
# src/data/photos/harbor-at-dawn.yaml
src: ./harbor-at-dawn.jpg
alt: Fishing boats moored in a harbor at first light
credit: Jane Rivera
```

JSON metadata works the same way: use `**/*.json` as the pattern and store each entry as JSON. The image field may be nested inside an object, such as `z.object({ image: image(), focalPoint: z.string() })`, but it cannot be inside a list.

## When a collection is skipped

If a collection resembles a media library but does not meet these requirements, Posto shows a diagnostic with the relevant resolution:

| Reason                               | Resolution                                                    |
| ------------------------------------ | ------------------------------------------------------------- |
| More than one `image()` field        | Split into separate collections, or keep a single image field |
| `glob()` loader has no static `base` | Use a plain string `base` path                                |
| Uses a custom `generateId`           | Remove it so Posto can manage entry IDs                       |
| The `image()` field is inside a list | Move it to a scalar (nested only through objects)             |
| Metadata is not YAML or JSON         | Use a `**/*.yaml`, `**/*.yml`, or `**/*.json` pattern         |

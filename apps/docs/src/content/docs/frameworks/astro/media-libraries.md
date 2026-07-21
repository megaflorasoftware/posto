---
title: Media libraries
description: The Astro collection shape Posto recognizes as a media library, with examples and the rules it applies.
---

A media library in Posto is an Astro content collection that pairs images with metadata. When a
collection matches the shape below, Posto manages its images and metadata together: metadata is
entered once on import, and referencing the image elsewhere carries the metadata with it (see
[Managing site media](/features/managing-site-media/)).

## What Posto recognizes

A collection is treated as a media library when all of these hold:

1. It uses a **`glob()` loader** with a static string `base`.
2. Its schema has **exactly one** [`image()`](https://docs.astro.build/en/guides/images/#images-in-content-collections)
   field, and that field is a scalar (nested only through objects, never inside a list).
3. The loader's `pattern` matches **YAML or JSON** metadata files.

Recognized image formats: `avif`, `gif`, `jpeg`, `jpg`, `png`, `svg`, `tif`, `tiff`, `webp`.

## Example

A photo library where each entry is a YAML file describing one image:

```ts
// src/content.config.ts
import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const photos = defineCollection({
  loader: glob({ base: "./src/data/photos", pattern: "**/*.yaml" }),
  schema: ({ image }) =>
    z.object({
      src: image(),                  // the single image field
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

JSON metadata works the same way; point the pattern at `**/*.json` and write the entry as JSON.
The image field may also be nested inside an object (for example
`z.object({ image: image(), focalPoint: z.string() })`), as long as it is not inside a list.

## When a collection is skipped

If a collection resembles a media library but breaks one of the rules, Posto shows a diagnostic
in the editor explaining why:

| Reason | Resolution |
| --- | --- |
| More than one `image()` field | Split into separate collections, or keep a single image field |
| `glob()` loader has no static `base` | Use a plain string `base` path |
| Uses a custom `generateId` | Remove it so Posto can manage entry IDs |
| The `image()` field is inside a list | Move it to a scalar (nested only through objects) |
| Metadata is not YAML or JSON | Use a `**/*.yaml`, `**/*.yml`, or `**/*.json` pattern |

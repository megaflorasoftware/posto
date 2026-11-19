---
title: CDN media
description: Store a site's images on Bunny Storage or an S3-compatible service instead of in the repository.
---

:::caution[Work in progress]
CDN media is new and still changing. Test it on a branch before relying on it for a production site.
:::

A media library or image field can keep its images on a CDN instead of in Git. Editors import images the usual way. Each image stays on their device until they publish, when Posto uploads it, points the content at its CDN URL, and removes the local copy in the same commit. Images that are already in the repository move to the CDN the next time someone publishes.

Posto supports [Bunny Storage](https://bunny.net/storage/) and services with an S3-compatible API, such as Cloudflare R2 and Amazon S3.

## Define a source

Describe each storage location in `.posto/index.json`. Commit this file so every editor uploads to the same place. Never put a password in it; editors enter that once per device.

```json
{
  "version": 0,
  "media": {
    "sources": [
      {
        "name": "cdn",
        "label": "Media CDN",
        "provider": "bunny",
        "bucket": "my-site-media",
        "region": "ny",
        "prefix": "images",
        "publicUrl": "https://media.example.com"
      }
    ]
  }
}
```

| Key         | Meaning                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`      | How schemas refer to the source. Letters, numbers, `-`, and `_`.                                                                              |
| `label`     | Optional name shown to editors.                                                                                                               |
| `provider`  | `bunny` or `s3`.                                                                                                                              |
| `bucket`    | The Bunny storage zone name or S3 bucket.                                                                                                     |
| `region`    | For Bunny, the zone's primary region code, such as `ny` or `uk`; Frankfurt is the default. For S3, the signing region; `auto` is the default. |
| `prefix`    | Optional folder inside the bucket for this site's images.                                                                                     |
| `publicUrl` | The HTTPS address that serves the bucket, such as a Bunny pull zone hostname. Content stores URLs that start with it.                         |
| `endpoint`  | S3 only. The service's HTTPS API endpoint.                                                                                                    |
| `pathStyle` | S3 only. Set to `false` for services that need the bucket in the hostname. Defaults to `true`.                                                |
| `images`    | Optional smaller sizes to make of each image. See [serve smaller sizes](#serve-smaller-sizes).                                                |

For Bunny, Posto uses the storage API that works on every zone, so a zone doesn't need S3 compatibility. Connect a pull zone to the storage zone and use its hostname as `publicUrl`.

## Assign images to the source

### Astro

Add `value=posto.media.<name>` to the image field's description, where `<name>` is the source's `name` from `.posto/index.json`, not its bucket. On a [media library](/frameworks/astro/media-libraries/), this moves every image in the library:

```ts
const photos = defineCollection({
  loader: glob({ base: "./src/data/photos", pattern: "**/*.yaml" }),
  schema: ({ image }) =>
    z.object({
      src: image().describe("value=posto.media.cdn"),
      alt: z.string(),
      width: z.number().optional().describe("value=schema.src.width"),
      height: z.number().optional().describe("value=schema.src.height"),
    }),
});
```

The same annotation works on an image field in any collection. The description can include other text, as long as `value=posto.media.cdn` is a separate word.

Commit the generated `.astro/collections` folder if editors use Posto on iOS. Phones can't run Astro to generate it, and Posto won't publish CDN images when it can't read the schema.

### Pages CMS

Name a media source in `.pages.yml` after the CDN source. Image fields that use that media source upload to the CDN:

```yaml
media:
  - name: cdn
    input: public/uploads
    output: /uploads
```

The `input` folder holds images until they're published. Every image in it uploads, including ones no page uses yet, so they stay available in the image picker.

## Update templates

`image()` accepts both local paths and URLs, so one library can hold local and CDN images while it migrates. In a template, a local image arrives as image metadata, and a CDN image arrives as a URL string.

Astro can't measure remote images, so `<Image>` needs a width and height for them. Without those, the site build fails with `MissingImageDimension`. Mark the library's `width` and `height` fields with `value=schema.src.width` and `value=schema.src.height`, naming the image field as in the schema above. Posto then sets them at import and, for images already in the repository, when it uploads them. Use `initial=` instead if editors should be able to change them. See [filling fields from the photo](/frameworks/astro/media-libraries/#filling-fields-from-the-photo):

```astro
---
import { Image } from "astro:assets";
const { src, alt, width, height } = photo.data;
---

{typeof src === "string" ? (
  <Image src={src} alt={alt} width={width} height={height} />
) : (
  <Image src={src} alt={alt} />
)}
```

To let Astro optimize CDN images, authorize the host in `astro.config.mjs` with `image: { domains: ["media.example.com"] }`.

## Serve smaller sizes

Astro can only resize a CDN image by downloading the original, which is slow for large photos in builds and in `astro dev`. Instead, Posto can make smaller sizes when it uploads each image, and record them in the entry for templates to use directly.

List the widths the site needs on the source:

```jsonc
{
  "name": "cdn",
  // …connection settings
  "images": {
    "widths": [480, 800, 1200, 1600, 2400, 3200],
    "format": "webp", // or "jpeg". Defaults to "webp".
    "quality": 80, // 1 to 100. Defaults to 80.
  },
}
```

Publish then uploads a copy of each image at every width, next to the original, which still uploads too. Widths wider than the image are skipped, so nothing is enlarged, and an image narrower than every width gets one copy at its own size. Copies are turned the way the camera recorded, keep transparency in WebP, and are named after their original, such as `harbor-1a2b3c4d-1600w-q80.webp`. Changing a setting gives new names, so CDN caches never serve an old copy.

Two values record them in the entry, alongside `width` and `height`:

```ts
srcset: z.string().optional().describe("value=schema.src.srcset"),
placeholder: z.string().optional().describe("value=schema.src.placeholder"),
```

- `srcset` lists every size, ready for an `<img srcset>` attribute.
- `placeholder` is a 24px copy as a `data:` URI, a few hundred bytes, to show blurred while the image loads. Any library can use it, including one that keeps images in the repository.

```astro
---
const { src, alt, width, height, srcset, placeholder } = photo.data;
---

<img
  src={src}
  srcset={srcset}
  sizes="(min-width: 640px) 50vw, 100vw"
  alt={alt}
  width={width}
  height={height}
  style={placeholder ? `background: url("${placeholder}") center / cover` : undefined}
/>
```

Until an entry is published, its image is still local and `srcset` is empty, so templates should fall back to Astro's image handling for local images. For images that were published before `images` was set, select their entries in the media library and choose **Validate items**. Posto downloads each original once, makes and uploads its sizes, and fills in both values.

Sizes are made from JPEG, PNG, WebP, TIFF, and BMP images. Colors are kept as stored, without converting wide-gamut photos to sRGB.

## How publishing works

Publishing uploads images first, then commits and pushes the updated content. If any step fails, Posto restores the site exactly as it was, and the next publish reuses uploads that already finished. If the app quits partway through, Posto finishes or undoes the publish the next time the project opens.

Each object is named `<prefix>/<folder>/<name>-<hash>.<extension>`. The hash comes from the file's content, so a replaced image gets a new URL and CDN caches never serve an old copy.

Posto keeps the local copy when a file it doesn't rewrite still mentions the image's name, such as a component import or a stylesheet. The publish review names that file. Files Git ignores, such as Astro's build cache, don't count, because they never reach the site.

## Deleting images

Deleting an image from a media library removes its entry right away and deletes its CDN object, and any sizes made from it, after the next successful publish. Reverting the deletion before publishing cancels it. Removing an image from a page never deletes it from the CDN.

## Current limitations

- Published images can't be renamed or moved, because that would change their URLs.
- For Pages CMS sources, the image picker can browse and choose CDN images, but Posto can't delete them from the CDN yet.
- Bunny's S3 API is in public preview and only works on storage zones created with S3 compatibility enabled.

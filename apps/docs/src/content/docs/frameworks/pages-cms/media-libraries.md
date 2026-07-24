---
title: Media libraries
description: Configure public media sources in .pages.yml and connect them to image fields.
---

In Pages CMS, a `media` source maps a repository directory to the public path served by the site. Posto uses these sources for image fields. Media stored under `public/` also appears in the **Public** media browser.

## Media sources

A media source has an `input`, the directory in the repository, and an `output`, the path stored in content and served by the site. If `output` is omitted, Posto derives it from `input` and removes a leading `public/` because that folder is served from the site root.

```yaml
# .pages.yml
media:
  input: public/images
  output: /images
```

Multiple sources can be defined as a list, each with a `name` and optional `label`:

```yaml
media:
  - name: photos
    label: Photography
    input: public/photos
    output: /photos
  - name: docs
    input: public/files
    output: /files
```

A collection can define its own `media` source. That source takes precedence over the global list for image fields in the collection.

## Image fields

An `image` field opens the relevant media source and stores the selected file's `output` path in the content.

```yaml
fields:
  - name: cover
    type: image
```

## Reusable image metadata

Pages CMS media sources provide public directories and image pickers, but they do not pair an image with reusable metadata. That model is detected from specially shaped Astro collections; see [Astro media libraries](/frameworks/astro/media-libraries/).

Use the general [media guide](/features/managing-site-media/) to learn how to import, create folders, move or rename files, update recognized references, and drag media into content.

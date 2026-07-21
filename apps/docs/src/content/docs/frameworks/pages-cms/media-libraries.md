---
title: Media libraries
description: Media sources in .pages.yml and how image fields use them.
---

In Pages CMS, media is configured with a `media` source that maps a directory in the repository
to the path the site serves it from. Image fields draw from these sources.

## Media sources

A `media` source has an `input` (the directory in the repository) and an `output` (the path
stored in content and served by the site). If `output` is omitted, Posto derives it from
`input`, stripping a leading `public/` (since a site's `public` folder is served from the root).

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

A collection can also set its own `media` source, which takes precedence over the global list
for that collection's image fields.

## Image fields

An `image` field presents an image picker that browses the relevant media source and stores the
selected file's `output` path in the content.

```yaml
fields:
  - name: cover
    type: image
```

## Reusable image metadata

The reusable-metadata media libraries described in
[Managing site media](/features/managing-site-media/) — where an image is paired with its alt
text and other metadata — are an Astro-specific feature, derived from a content collection's
shape. See [Astro — Media libraries](/frameworks/astro/media-libraries/). Pages CMS `media`
sources provide the image directories and pickers, but not the paired-metadata model.

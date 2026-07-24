---
title: Getting started with Pages CMS
description: Add a Pages CMS configuration for typed content and media controls in any static-site project.
---

[Pages CMS](https://pagescms.org) describes editable content in a `.pages.yml` file at the project root. Posto reads this file directly to build its content groups, typed fields, and media sources.

Because `.pages.yml` is framework-independent, it can add typed forms to Hugo, Jekyll, Eleventy, or a custom static site. It can also complement Astro content collections; see [Precedence with framework schemas](#precedence-with-framework-schemas).

## How Posto reads the config

Posto supports `media` sources, `collection` and `file` content entries, and their field definitions from the [Pages CMS configuration](https://pagescms.org/docs/configuration). Invalid or incorrectly shaped values are ignored, allowing the rest of the configuration to keep working.

## Precedence with framework schemas

When a project has both `.pages.yml` and framework schemas such as Astro content collections, `.pages.yml` is the primary source. Astro fills in folders that `.pages.yml` does not cover and becomes the full fallback when `.pages.yml` is absent or invalid.

This lets an Astro project add labels, media directories, and option labels that its generated schemas do not carry.

Developer mode can add a `.posto/` overlay for Posto-specific presentation settings such as collection order, pinned entries, sorting, and field templates. The overlay does not replace `.pages.yml`; it adjusts how the derived configuration appears in Posto.

## A minimal example

```yaml
# .pages.yml
media:
  input: public/images
  output: /images

content:
  - name: posts
    label: Blog posts
    type: collection
    path: src/content/blog
    filename: "{year}-{month}-{day}-{primary}.md"
    fields:
      - name: title
        type: string
      - name: date
        type: date
      - name: draft
        type: boolean
```

## Next

- [Typed collections](/frameworks/pages-cms/typed-collections/) — content entries and field types.
- [Media libraries](/frameworks/pages-cms/media-libraries/) — media sources and image fields.

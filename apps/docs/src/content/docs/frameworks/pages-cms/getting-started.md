---
title: Getting started with Pages CMS
description: How Posto reads a Pages CMS .pages.yml file and how it relates to framework schemas.
---

[Pages CMS](https://pagescms.org) is a configuration format for editing Git-based sites, defined
in a `.pages.yml` file at the repository root. Posto reads `.pages.yml` directly and builds its
file list and typed forms from it.

`.pages.yml` is framework-independent, so this works for any static site — it's how Hugo,
Jekyll, Eleventy, or hand-rolled sites get typed forms in Posto. It also complements an Astro
site rather than competing with it: see [Precedence with framework
schemas](#precedence-with-framework-schemas) below.

## How Posto reads the config

Posto parses the subset of the
[Pages CMS configuration](https://pagescms.org/docs/configuration) it supports: `media` sources,
content entries (`collection` and `file`), and field definitions. Parsing is tolerant —
malformed or wrong-shaped values are dropped rather than raised as errors, so a hand-edited
mistake degrades to defaults instead of breaking the editor.

## Precedence with framework schemas

When a repository has both a `.pages.yml` and framework schemas (such as Astro content
collections), `.pages.yml` is the primary source. Astro collections are used as a fallback for
any folder `.pages.yml` does not cover, and entirely when `.pages.yml` is absent or invalid.

Because Astro's generated schemas carry no labels, media directories, or option labels, a
`.pages.yml` is one way to add those to an Astro project. The two can coexist.

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

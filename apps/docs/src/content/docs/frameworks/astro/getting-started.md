---
title: Getting started with Astro
description: A setup checklist for editing an Astro site with Posto, and how Posto reads the project.
---

[Astro](https://docs.astro.build/en/getting-started/) is a framework for content-driven
websites, and it's the framework Posto supports most deeply: Posto reads an Astro project's
[content collections](https://docs.astro.build/en/guides/content-collections/) and builds typed
editing forms from them, with no Posto-specific configuration.

## Setup checklist

To get the most out of Posto, set the repository up like this. Only the first two steps are
required for typed forms; the rest each unlock a feature.

1. **Define content collections** in `src/content.config.ts`, with Zod schemas for their
   frontmatter. [Typed collections](/frameworks/astro/typed-collections/) shows how each Zod
   type maps to a form control, and which shapes to avoid.
2. **Commit the generated schemas** so typed forms also work where no dev server runs (mobile,
   and fresh clones). See [Recommended `.gitignore`](#recommended-gitignore) below.
3. **Optionally add a `.pages.yml`.** Zod carries no editor metadata — field labels, media
   directories, dropdown option labels. A
   [Pages CMS config](/frameworks/pages-cms/getting-started/) alongside the Astro config
   supplies those; where both describe the same content, `.pages.yml` wins and Astro fills the
   gaps.
4. **Shape image collections as media libraries** — a collection pairing each image with its
   alt text and other metadata, entered once and reused everywhere the image appears. The rules
   are in [Media libraries](/frameworks/astro/media-libraries/).
5. **Keep content components in `src/components`** so they show up in the MDX component
   palette with their props as form fields. See
   [Components and MDX](/frameworks/astro/components-and-mdx/).
6. **Deploy through GitHub Actions** if you want the in-app
   [deployment indicator](/deployment/github/tracking-deployment-status/) to show when a
   publish is live.

## How Posto reads the project

Posto does not execute Zod schemas or `content.config.ts`. It reads two things:

1. **The generated collection schemas.** Astro writes a JSON Schema for each collection to
   `.astro/collections/<name>.schema.json` when it runs `astro sync`, `astro dev`, or
   `astro build`. This is the source of the fields Posto renders.
2. **A static scan of `content.config.ts`.** Some information is dropped from the generated
   schema — which fields are `image()` or `reference()`, and each collection's loader — so Posto
   reads the config source to recover it.

The desktop app runs the dev server, so these schema files stay current as you edit. The mobile
app does not run a dev server, so it reads whatever schema files are committed to the repository.

## Recommended `.gitignore`

Astro's default `.gitignore` excludes the whole `.astro/` directory. On mobile this leaves Posto
with no schemas to read, and typed forms fall back to plain text fields.

To make typed forms work on mobile as well, commit the generated collection schemas:

```gitignore
# Astro's generated cache — ignored, except the collection schemas, which Posto
# reads to build typed forms. The mobile app has no dev server to regenerate them.
.astro/*
!.astro/collections/
```

Generate and commit them once:

```sh
astro sync
git add .astro/collections
git commit -m "Commit generated collection schemas for Posto"
```

Re-run `astro sync` (or start the dev server) after changing a collection's schema so the
committed JSON stays in step. On desktop this happens automatically; the commit matters for
mobile editing and for anyone opening the repository without first running the site.

## Next

- [Typed collections](/frameworks/astro/typed-collections/) — how Zod schemas map to form fields,
  and what degrades.
- [Media libraries](/frameworks/astro/media-libraries/) — the requirements for a managed image
  library.
- [Components and MDX](/frameworks/astro/components-and-mdx/) — editing component props as fields.

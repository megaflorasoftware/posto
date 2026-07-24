---
title: Getting started with Astro
description: Configure an Astro site for typed fields, media libraries, MDX components, and mobile editing in Posto.
prev: false
---

[Astro](https://docs.astro.build/en/getting-started/) is the framework Posto supports most deeply. Posto reads an Astro project's [content collections](https://docs.astro.build/en/guides/content-collections/) and turns their schemas into typed editing forms without requiring a duplicate Posto schema.

## Setup checklist

Use this checklist to enable the parts of Posto your site needs. The collection definition is enough for typed forms on desktop; committing generated schemas also enables them on mobile and before a fresh clone has run Astro.

1. **Define content collections** in `src/content.config.ts`, with Zod schemas for their frontmatter. [Typed collections](/frameworks/astro/typed-collections/) shows how each Zod type maps to a form control, and which shapes to avoid.
2. **Commit the generated schemas** so typed forms work where no development server is running, including mobile and fresh clones. See [Recommended `.gitignore`](#recommended-gitignore).
3. **Optionally add `.pages.yml`.** Zod does not carry editor details such as field labels, media directories, or labels for dropdown options. A [Pages CMS config](/frameworks/pages-cms/getting-started/) can supply them. Where both configurations describe the same content, `.pages.yml` takes precedence and Astro fills the gaps.
4. **Shape image collections as media libraries** — a collection pairing each image with its alt text and other metadata, entered once and reused everywhere the image appears. The rules are in [Media libraries](/frameworks/astro/media-libraries/).
5. **Keep content components in `src/components`** so they appear in the MDX component palette with recognized props as form fields. See [Components and MDX](/frameworks/astro/components-and-mdx/).
6. **Optionally commit Posto presentation settings.** Developer mode can create a `.posto/` overlay for collection order, entry labels, sorting, pinned entries, and field templates. It changes how Posto presents the derived collections without replacing the Astro schemas.
7. **Deploy through GitHub Actions** if you want the in-app [deployment indicator](/deployment/github/tracking-deployment-status/) to show when a publish is live.

## How Posto reads the project

Posto does not execute `content.config.ts` or its Zod schemas. It combines two static sources:

1. **Generated collection schemas.** Astro writes a JSON Schema for each collection to `.astro/collections/<name>.schema.json` when it runs `astro sync`, `astro dev`, or `astro build`. Posto uses these files for field shapes and validation.
2. **A static scan of `content.config.ts`.** Generated schemas do not preserve which fields use `image()` or `reference()`, or how each collection is loaded. Posto scans the source to recover that information.

The desktop app runs the development server, which keeps generated schemas current. The mobile app reads the schema files committed to the repository.

## Recommended `.gitignore`

Astro's default `.gitignore` excludes the entire `.astro/` directory. On mobile, that leaves Posto without generated schemas and typed fields fall back to plain text controls.

To make typed forms work on mobile as well, commit the generated collection schemas:

```text
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

Run `astro sync` again after changing a collection schema, then commit the updated JSON. Starting the development server also regenerates it, but does not commit it for mobile users.

## Next

- [Typed collections](/frameworks/astro/typed-collections/) — how Zod schemas map to form fields, and what degrades.
- [Media libraries](/frameworks/astro/media-libraries/) — the requirements for a managed image library.
- [Components and MDX](/frameworks/astro/components-and-mdx/) — editing component props as fields.

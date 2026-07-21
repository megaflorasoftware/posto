---
title: Environment setup
description: How the desktop app installs a site's toolchain and runs its dev server automatically.
---

The desktop app gets a site running the way a developer would, without asking you to use a
terminal. This is what powers the [live preview](/features/previewing-a-site/).

## What happens when a site opens

When you open a site, Posto:

1. **Detects the toolchain** the site needs — Node and the site's package manager.
2. **Installs what's missing.** Installations are managed by Posto and don't touch a
   system-wide Node setup you may already have.
3. **Installs the site's dependencies**, as a developer would with `npm install` or
   equivalent.
4. **Starts the dev server** and connects the preview pane to it.

Progress is shown while this runs; a typical site is ready in a couple of minutes the first
time and much faster after that, since the toolchain and dependencies are reused.

If the site changes — new dependencies pulled in with an update, for example — Posto brings the
environment up to date the next time it opens the site. **Restart Preview** restarts the dev
server without redoing the full setup.

## Mobile

The mobile app doesn't run a dev server, so none of this applies there: mobile edits files
directly and relies on schema files committed to the repository for typed forms (see
[Getting started with Astro](/frameworks/astro/getting-started/#recommended-gitignore)).

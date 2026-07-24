---
title: Environment setup
description: How the desktop app prepares a site's toolchain, installs dependencies, and starts its development server.
---

The desktop app prepares and runs a site without requiring a terminal. That local environment powers the [live preview](/features/previewing-a-site/).

## What happens when a site opens

When you open a site, Posto:

1. **Detects the toolchain** required by the selected project, including Node and its package manager.
2. **Installs missing tools** in Posto's managed environment without changing a system-wide Node installation.
3. **Installs the project's dependencies** with its detected package manager.
4. **Starts the development server** and connects the preview pane to it.

Posto shows each setup step as it runs. The first setup takes the longest; later sessions reuse the installed toolchain and dependencies.

If the site changes—for example, after pulling new dependencies—Posto updates the environment the next time it opens the project. **Restart Preview** restarts the development server without repeating the full setup.

## Mobile

The mobile app does not run a development server. It edits repository files directly and relies on committed schema files for typed forms. For Astro sites, see the [recommended `.gitignore`](/frameworks/astro/getting-started/#recommended-gitignore).

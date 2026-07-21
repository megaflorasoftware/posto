---
title: Previewing a site
description: The live preview pane and the search/social preview.
---

The desktop app runs the site locally and renders it in the preview pane next to the editor. Posto starts the dev server itself when the site opens — see [Environment setup](/features/environment-setup/).

## Live preview

The preview pane shows the running site:

- Selecting a file moves the preview to that file's page, and saving updates it.
- Clicking a link inside the preview opens the file behind that page.
- **Home** returns to the site's root, and **Restart Preview** restarts the local dev server.

The live preview is desktop only; it depends on the local dev server, which the mobile app does not run.

## Search & social preview

Alongside the editor's Fields, Body, and Raw tabs, a file that renders as a page also gets a **Search/Socials** tab. It shows how the page appears as a search result and as a shared link on social media. The cards are built from the rendered page's `<head>` — the title, description, and preview image the site actually produces — fetched from the dev server. It requires the dev server to be running.

---
title: Previewing a site
description: Use the desktop live preview and inspect search and social metadata before publishing.
---

The desktop app runs the selected site locally and displays it beside the editor. Posto starts the development server when the project opens; see [Environment setup](/features/environment-setup/).

## Live preview

The preview pane shows the running site:

- Selecting a file moves the preview to that file's route when Posto can resolve one.
- Clicking a link in the preview opens the source file behind that page when Posto can map it.
- Saving refreshes the running site through its development server.
- **Home** returns to the site root, and **Restart Preview** restarts the development server.

The live preview is desktop only; it depends on the local development server, which the mobile app does not run.

## Search and social preview

Select **Search/Socials** above the preview to see how the current page may appear in search results and shared links. Posto builds these cards from the rendered page's `<head>`, including the title, description, and preview image produced by the site itself.

This view requires the development server to be running. Treat it as a metadata check, not a guarantee: search engines and social platforms can crop images or rewrite text differently.

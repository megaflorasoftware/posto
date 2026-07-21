---
title: Editing a site
description: The editor layout, the Fields/Body/Raw tabs, typed frontmatter, and typed components.
---

Posto edits the Markdown and content files in a website's repository. The form controls it
shows are generated from the site's own content schema — where that schema comes from depends
on the site: [Astro content collections](/frameworks/astro/getting-started/), a
[Pages CMS `.pages.yml`](/frameworks/pages-cms/getting-started/), or both.

## The editor layout

On the desktop app the window has two panes:

- **Left — the editor.** The current file, with a sidebar listing the site's editable files
  grouped by collection or folder.
- **Right — the preview.** The site running locally. Selecting a file moves the preview to its
  page; clicking a link in the preview opens the corresponding file. The divider between the
  panes can be dragged to resize them.

The mobile app has no preview pane. The editor fills the screen, and you switch between the
file list and the editor.

Edits save automatically as you type; there is no save action.

## The Fields, Body, and Raw tabs

A file shows up to three tabs, depending on its type:

- **Fields** — a form for the file's frontmatter (the metadata block at the top of a Markdown
  file). Each field is a control chosen from the site's schema: text input, number input,
  switch, date picker, dropdown, image picker, and so on.
- **Body** — a rich-text editor for the main content of a Markdown file. It supports bold,
  italic, strikethrough, headings, lists, links, blockquotes, code, horizontal rules, and
  inline images.
- **Raw** — the file's stored source, edited as plain text.

Posto selects a starting tab based on the file's contents and keeps your selection as you move
between files. Files with no schema and no frontmatter (for example a stylesheet) show only the
Raw view.

## Typed frontmatter

The Fields tab is generated from the site's content schema. If the schema defines a post with a
title, a publish date, an optional cover image, and a draft flag, the form shows a text input, a
date picker, an image picker, and a switch. Constraints in the schema — required fields, length
limits, allowed values — are enforced as you edit.

For Astro sites this comes from
[content collections](https://docs.astro.build/en/guides/content-collections/). Posto reads the
existing definitions; there is nothing to configure separately.

## Typed components

In `.mdx` files, you can insert the site's components into the body from a component palette.
Posto inserts the component's tag and adds the matching `import` statement. A component's props
are rendered as form fields, using the same controls as frontmatter, so they can be set without
editing JSX.

This uses Astro's [components](https://docs.astro.build/en/basics/astro-components/) and
[MDX](https://docs.astro.build/en/guides/integrations-guide/mdx/) support. See
[Components and MDX](/frameworks/astro/components-and-mdx/) for how components and their props
are detected.

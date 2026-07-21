---
title: Managing site media
description: The media pane, importing images, and reusable image metadata.
---

Posto browses and imports images through a media pane, and can reuse image metadata across the site when the site is structured for it.

## The media pane

The **Media** view lists the site's image libraries — their folders and the assets inside, shown as a grid of thumbnails. New images are added with the **Import** action. On the desktop app, an image can also be dragged onto the window to import it.

Posto generates thumbnails for browsing and converts formats that browsers can't display (such as HEIC/HEIF) on import.

## Reusable image metadata

When the site models images as a collection that pairs an image with metadata — alt text, caption, credit — Posto treats that collection as a **media library**. The metadata is entered once when the image is imported. When you then reference that image (in a frontmatter field or in the body), Posto selects it from the library, and its metadata is carried with it.

## Setting this up

What qualifies as a media library, and how to structure one, depends on the framework:

- [Astro — Media libraries](/frameworks/astro/media-libraries/)
- [Pages CMS — Media libraries](/frameworks/pages-cms/media-libraries/)

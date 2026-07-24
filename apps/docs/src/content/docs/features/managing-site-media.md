---
title: Managing site media
description: Browse, import, organize, edit, and reuse public media and metadata-backed image libraries.
---

The **Media** sidebar brings the site's media sources into one place. It always includes files under `public/` and adds a tab for each detected metadata-backed image library.

## Public media and image libraries

Posto distinguishes between two kinds of media:

- **Public media** includes images, audio, video, and other downloadable files under `public/`. Content stores the site's public URL, such as `/images/harbor.jpg`.
- **Image libraries** pair each image with a YAML or JSON record containing reusable metadata such as alt text, caption, or credit. They are detected from supported Astro content collections.

Pages CMS media sources can point image fields at public directories or other repository folders, but they do not create paired-metadata image libraries. Files under `public/` also appear in the public-media workflow. See the setup guides for [Astro](/frameworks/astro/media-libraries/) and [Pages CMS](/frameworks/pages-cms/media-libraries/).

## Importing media

Use **Import files** on the **Public** tab to add public media. Use **Import images** in an image-library tab to choose images, their destination folder, and required metadata.

On desktop, you can also drag image files from your computer:

- Drop them onto an open media folder to import them there.
- Drop them into the rich-text body to choose a library and insert them at that position after import.

Posto generates thumbnails for browsing. HEIC and HEIF images are converted to a browser-compatible format during import when necessary.

## Organizing files and folders

Each tab supports folders. Create a folder with **New folder**, or drag media and folders onto another folder to move them. Select several items with their selection controls or by holding Shift while clicking, then move or delete the group from the footer. Press Escape to clear the selection.

Open an individual item to rename it or, for an image-library asset, edit its metadata. When recognized references point to a file that is moved or renamed, Posto updates those references in schema-backed fields and Markdown or MDX content. Updating library alt text also updates direct Markdown image references to that asset.

Check where an item is used before deleting it. Deletion removes the selected files and folders but does not repair references that now point to a missing item.

## Using media in content

Drag one or more media items from the sidebar into the rich-text body. Images become Markdown images, audio and video become HTML media elements, and other files become links. Drag an image onto an image field to replace its value, or use the field's clear action to remove an optional image.

Images already in the body can be dragged to a new position, edited, or removed from the document without deleting the underlying media file.

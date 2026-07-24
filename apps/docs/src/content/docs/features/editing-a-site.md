---
title: Editing a site
description: Navigate the desktop workspace, edit structured content, use rich-text tools, and open the raw source when needed.
---

Posto edits files in the site's repository and saves changes automatically. For Markdown and MDX files, frontmatter fields and body content appear in one continuous editor. The controls come from the site's [Astro content collections](/frameworks/astro/getting-started/), [Pages CMS `.pages.yml`](/frameworks/pages-cms/getting-started/), or both.

## The desktop workspace

The desktop app has three resizable panes:

- **Files and media** — switch between the site's editable files and its media libraries. The sidebar can be hidden with **View → Toggle Sidebar** or `Cmd/Ctrl + \`.
- **Editor** — edit the selected file's structured fields and body. Changes save automatically as you type.
- **Preview** — use the running site or inspect its search and social metadata. See [Previewing a site](/features/previewing-a-site/).

The mobile app fills the screen with one view at a time. Switch between the file list, editor, media, and repository controls from the app's navigation.

On desktop, **File → Open File** (`Cmd/Ctrl + O`) opens a searchable list of the files currently shown in the sidebar. **File → Open Recent** (`Cmd/Ctrl + Shift + O`) switches repositories.

## The content editor

For a Markdown or MDX file, the visual editor places frontmatter controls above the body:

- **Frontmatter fields** use the site's schema to choose the right control: text or number input, toggle, date picker, dropdown, image picker, nested field group, or repeatable list.
- **Body content** uses a rich-text editor with headings, emphasis, lists, links, blockquotes, code, horizontal rules, images, and supported embedded media.

Posto chooses the starting view from the file type. Files without a visual editor open as raw text. If Markdown frontmatter has a YAML syntax error, Posto also opens the raw source so you can repair it.

## Working with rich content

Use the body toolbar to insert images and, in MDX files, components discovered from the site. Images, components, and supported HTML blocks can be dragged to a new position. Components can also be reordered within a component slot or moved into a compatible nested slot.

Media can be dragged from the sidebar into the body. Dropping several items inserts them in order. You can also drop image files from your computer at a specific position; Posto imports them into the site before inserting them. See [Managing site media](/features/managing-site-media/) for the available libraries and file actions.

## Typed frontmatter

The site's schema supplies both the controls and their validation. For example, a post with a title, publish date, optional cover image, and draft flag gets a text input, date picker, image picker, and toggle. Required fields, length limits, and allowed values are checked as you edit.

For Astro sites, these controls come from [content collections](https://docs.astro.build/en/guides/content-collections/). Posto reads the existing definitions; no duplicate schema is required.

## Typed components

In `.mdx` files, the component palette lists supported site components. Selecting one inserts its tag and matching `import` statement. Posto renders recognized component props as form fields, so content editors do not need to edit JSX.

See [Components and MDX](/frameworks/astro/components-and-mdx/) for component discovery, supported prop types, and drag behavior.

## Fullscreen editing

Select the expand control in the editor header, or use **View → Toggle Fullscreen Editor** (`Cmd/Ctrl + Shift + F`), to focus on the editor. In fullscreen mode, the sidebar control (`Cmd/Ctrl + \`) opens the file and media sidebars around the editor.

## Developer mode and raw source

Enable developer mode in **Settings** (`Cmd/Ctrl + ,`) to reveal the raw-source control and project-level Posto configuration tools. These tools can change collection labels and ordering, pin or sort entries, and add field or filename templates. Posto stores those presentation preferences in the project's `.posto/` directory so collaborators share them.

Raw editing is an escape hatch: it changes the stored file directly and does not provide schema controls or rich-text safeguards. It remains available automatically when a file cannot be edited visually.

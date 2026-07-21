---
title: Typed collections
description: Pages CMS content entries and field types, and how Posto renders them.
---

Content in `.pages.yml` is defined as a list of entries under `content`. Each entry becomes a group in Posto, and each field becomes a form control.

## Content entries

- **`collection`** — a folder of files, each edited as one entry. `path` sets the folder; `filename` optionally sets a template for new entries (for example `{year}-{month}-{day}-{primary}.md`).
- **`file`** — a single file edited as one form.

```yaml
content:
  - name: posts
    label: Blog posts
    type: collection
    path: src/content/blog
    fields:
      - name: title
        type: string
  - name: settings
    label: Site settings
    type: file
    path: src/data/settings.yaml
    fields:
      - name: siteName
        type: string
```

## Field types

Posto renders these field types with dedicated controls:

| `type`      | Control                                                                      |
| ----------- | ---------------------------------------------------------------------------- |
| `string`    | Single-line text input                                                       |
| `text`      | Multi-line text input                                                        |
| `number`    | Number input                                                                 |
| `boolean`   | Toggle switch                                                                |
| `date`      | Date picker                                                                  |
| `select`    | Dropdown                                                                     |
| `image`     | Image picker (see [Media libraries](/frameworks/pages-cms/media-libraries/)) |
| `reference` | Dropdown of another collection's entries                                     |
| `object`    | Nested group of fields                                                       |

Any other `type` is rendered as a plain multi-line text field.

## Field options

Field definitions support the common Pages CMS keys:

- `label` — the field's display name (`false` hides the label).
- `description` — help text shown with the field.
- `required` — marks the field as required.
- `default` — the value used for new entries.
- `list` — makes the field repeatable; `list: { min, max }` constrains the count.
- `pattern` — a validation regex, optionally `{ regex, message }`.
- `options` — type-specific settings, such as the `values` for a `select`.

```yaml
fields:
  - name: status
    type: select
    default: draft
    options:
      values: [draft, published]
  - name: tags
    type: string
    list: true
```

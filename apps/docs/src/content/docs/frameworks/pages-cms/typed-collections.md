---
title: Typed collections
description: Map Pages CMS content entries, field types, and options to Posto's editing controls.
---

The `content` list in `.pages.yml` defines what Posto can edit. Each entry becomes a group, and each supported field becomes an appropriate form control.

## Content entries

- **`collection`** — a folder of files, each edited as one entry. `path` sets the folder, and `filename` can define a template for new entries, such as `{year}-{month}-{day}-{primary}.md`.
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

Any other `type` falls back to a plain multi-line text field.

## Field options

Posto supports these common field options:

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

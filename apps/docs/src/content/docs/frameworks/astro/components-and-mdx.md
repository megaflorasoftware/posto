---
title: Components and MDX
description: Discover and insert Astro components, edit recognized props, and reorder component blocks in MDX.
---

In `.mdx` files, Posto can insert site components and render recognized props as form fields. The underlying file remains standard Astro [MDX](https://docs.astro.build/en/guides/integrations-guide/mdx/) using the site's own [components](https://docs.astro.build/en/basics/astro-components/).

## How it works

- **Discovery.** Posto looks in `src/components` and then `components` for `.astro`, `.tsx`, `.jsx`, `.vue`, and `.svelte` files.
- **Insertion.** Choosing a component from the palette inserts its tag into the body and adds the matching `import` statement. Imports for inserted components are managed by Posto.
- **Props.** Posto reads declared props and renders recognized types with the same controls used for collection fields.
- **Reordering.** Drag a component card to move it in the body. Components in slots can be reordered within the slot, and compatible blocks can be moved into nested slots.

## Supported prop types

Props map to controls the same way collection fields do:

- **Strings** → text input. A string-literal union such as `"sm" | "md" | "lg"` becomes a select dropdown.
- **Numbers** → number input.
- **Booleans** → toggle switch.
- **Objects** → nested field group.
- **References** to a collection → entry dropdown.

For an Astro component these come from its `Props` interface:

```astro
---
// src/components/Callout.astro
interface Props {
  title: string;
  variant?: "note" | "tip" | "warning";  // → select dropdown
  dismissible?: boolean;                  // → toggle
}
const { title, variant = "note", dismissible = false } = Astro.props;
---
```

## Not supported

Some prop types do not have a dedicated form control. Posto keeps them editable as raw expressions:

- **Generics** and type parameters
- **Imported or externally-defined types** not visible inline
- **Arbitrary object shapes** and complex or mapped types
- **Functions** and other non-data props

Component and prop parsing is a static scan, not a full TypeScript type-check. Unusual declarations can fall back to a raw input instead of a typed control without preventing the component from being edited.

---
title: Components and MDX
description: How Posto inserts components into MDX and maps their props to fields, including unsupported prop types.
---

In `.mdx` files, Posto can insert the site's components into the body and render their props as
form fields. This uses Astro's [components](https://docs.astro.build/en/basics/astro-components/)
and [MDX](https://docs.astro.build/en/guides/integrations-guide/mdx/) support.

## How it works

- **Discovery.** Posto lists components from `src/components`, then `components`, with the
  extensions `.astro`, `.tsx`, `.jsx`, `.vue`, and `.svelte`.
- **Insertion.** Choosing a component from the palette inserts its tag into the body and adds the
  matching `import` statement. Imports for inserted components are managed by Posto.
- **Props.** Posto reads the component's declared props and renders them as form fields, using
  the same controls as collection fields.

## Supported prop types

Props map to controls the same way collection fields do:

- **Strings** → text input. A string-literal union such as `"sm" | "md" | "lg"` becomes a select
  dropdown.
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

Some prop types have no form control. For these, Posto renders a raw expression input, so the
prop is still editable as code:

- **Generics** and type parameters
- **Imported or externally-defined types** not visible inline
- **Arbitrary object shapes** and complex or mapped types
- **Functions** and other non-data props

Component and prop parsing is a static scan tuned for typical content components, not a full
TypeScript type-checker. Unusual formatting can cause a prop to fall back to the raw input rather
than a typed control; it does not fail otherwise.

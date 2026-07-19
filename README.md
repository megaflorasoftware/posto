> [!WARNING]
> **This is pre-alpha software**. Expect bugs and incomplete features. Use at your own risk.
>
> In order to use this software currently, you'll have to ignore Apple's warnings as it is not signed. After downloading and installing, open a terminal and run the following:
>
> `xattr -d com.apple.quarantine /Applications/Posto.app/`

# Posto

## Astro image libraries

Posto recognizes a local Astro `glob()` collection as an image library when its metadata uses YAML or JSON and its schema contains exactly one `image()` field. The loader base is both the metadata root and image destination. New assets use colocated files with matching basenames:

```text
src/data/images/
├── sunrise.jpg
├── sunrise.yml
└── landscapes/
    ├── mountains.webp
    └── mountains.yml
```

The metadata entry owns the image path and global metadata:

```yaml
image: ./sunrise.jpg
alt: The sun rising over a misty valley
credit: Jane Example
```

Other collections should use Astro `reference("images")` fields, and Astro component props can use `CollectionEntry<"images">["id"]`. Posto stores only the entry ID in those locations. Imports validate all schema-derived metadata before writing and create the image and metadata as one rollback-safe operation.

Managed deletion resolves the image path from metadata, scans supported frontmatter and MDX component references, and blocks deletion when a required reference, shared image, external path, or incomplete scan remains. Optional references must be explicitly approved for removal. Missing images, malformed metadata values, duplicate IDs, shared files, and paths outside the library are shown as diagnostics; Posto never guesses ownership from matching basenames or automatically removes orphan images.

A fast and simple desktop editor for static, markdown-based personal websites. Posto lives a level up from a traditional IDE or code editor, enabling non-programmers to easily update a site built for them or serving as a more pleasant way for developers to make frequent updates to their static sites.

![](/screenshot.png)

## Key features

- Rich text editor and site preview side-by-side
- "Done for you" local environment setup
  - Allows non-programmers to get a website running just as a developer would, removing limitations on what can be built while still allowing for CMS-style content updating
- Native [Astro](https://astro.build/) support, which allows for unique features like:
  - Rich text `.mdx` editing, enabling non-technical users to drop in custom components alongside traditional markdown in an easy-to-use interface
  - Markdown schemas based on content collections, intelligently rendering specific field inputs or option dropdowns based on the actual site schema (for both markdown frontmatter and custom component props)
- Easy site publish flow, making site updates simple for everyone
- SEO and social previews

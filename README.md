> [!WARNING]
> **This is pre-alpha software**. Expect bugs and incomplete features. Use at your own risk.
>
> In order to use this software currently, you'll have to ignore Apple's warnings as it is not signed. After downloading and installing, open a terminal and run the following:
>
> `xattr -d com.apple.quarantine /Applications/Posto.app/`

# Posto

A fast and simple desktop editor for static, markdown-based personal websites. Posto lives a level up from a traditional IDE or code editor, enabling non-programmers to easily update a site built for them and serving as a more pleasant way for developers to make frequent updates to their static sites.

![](/public/screenshot.png)

## Key features

- Rich text editor and site preview side-by-side
- "Done for you" local environment setup
  - Allows non-programmers to get a website running just as a developer would, removing limitations on what can be built while still allowing for CMS-style content updating
- Native [Astro](https://astro.build/) support, which allows for unique features like:
  - Rich text `.mdx` editing, enabling non-technical users to drop in custom components alongside traditional markdown in an easy-to-use interface
  - Markdown schemas based on content collections, intelligently rendering specific field inputs or option dropdowns based on the actual site schema (for both markdown frontmatter and custom component props)
- Easy site publish flow, making site updates simple for everyone
- SEO and social previews

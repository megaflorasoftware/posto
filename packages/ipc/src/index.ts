import { convertFileSrc, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as tauriOpen } from "@tauri-apps/plugin-dialog";
import { openPath as tauriOpenPath } from "@tauri-apps/plugin-opener";

const inTauri = "__TAURI_INTERNALS__" in window;

export interface FileEntry {
  name: string;
  path: string;
  /** Frontmatter `title:` (else `name:`) for display; filename when absent. */
  title?: string | null;
}

export interface FileGroup {
  label: string;
  path: string;
  /** Synthetic-group marker ("styles" for the tree-wide CSS section). */
  kind?: string | null;
  files: FileEntry[];
}

export interface ChangedFile {
  /** Git porcelain status collapsed to one code: "M", "A", "D", "R", "??", … */
  status: string;
  path: string;
}

export interface ManagedRepo {
  owner: string;
  name: string;
  root: string;
  url: string;
}

export interface CloneProgress {
  received_objects: number;
  total_objects: number;
  indexed_objects: number;
  received_bytes: number;
}

// Browser-only mock so the UI can be developed and tested outside the Tauri
// shell (invoke/dialog are unavailable there).
const mockFiles: Record<string, string> = {
  "/mock/site/.pages.yml": [
    "media: public/images",
    "content:",
    "  - name: blog",
    "    label: Blog",
    "    type: collection",
    "    path: src/blog",
    "    fields:",
    "      - { name: title, label: Title, type: string, required: true }",
    "      - { name: slug, label: Slug, type: string, pattern: '^[a-z0-9-]+$' }",
    "      - { name: publish_date, label: Publish Date, type: date }",
    "      - { name: draft, label: Draft, type: boolean }",
    "      - { name: tags, label: Tags, type: string, list: true }",
    "      - { name: cover, label: Cover, type: image }",
    "      - name: images",
    "        label: Images",
    "        type: object",
    "        list: true",
    "        fields:",
    "          - { name: src, label: Image, type: image }",
    "          - { name: alt, label: Description, type: string }",
    "      - { name: related, label: Related post, type: reference, options: { collection: blog } }",
    "      - { name: see_also, label: See also, type: reference, list: true, options: { collection: blog } }",
    "      - name: works",
    "        label: Works (in descending order)",
    "        type: object",
    "        list: true",
    "        fields:",
    "          - { name: src, label: Work, type: reference, options: { collection: blog } }",
    "      - { name: body, label: Body, type: rich-text }",
    "  - name: pages",
    "    label: Pages",
    "    type: collection",
    "    path: src/pages",
    "    filename: '{title}.mdx'",
    "    fields:",
    "      - name: layout",
    "        label: Layout",
    "        type: reference",
    "        required: true",
    "        options:",
    "          collection: layouts",
    "          value: '../layouts/{name}'",
    "          label: '{filename}'",
    "      - { name: title, label: Title, type: string, required: true }",
    "  - name: layouts",
    "    label: Layouts",
    "    type: collection",
    "    path: src/layouts",
    "    filename: '{primary}.astro'",
    "",
  ].join("\n"),
  // Astro content-collection fixtures: `posts` has no `.pages.yml` entry, so
  // its form schema comes from the generated JSON Schema (fallback path).
  "/mock/site/src/content.config.ts": [
    'import { defineCollection, z } from "astro:content";',
    'import { glob } from "astro/loaders";',
    "",
    "const posts = defineCollection({",
    '  loader: glob({ pattern: "**/*.md", base: "./posts" }),',
    "  schema: z.object({}),",
    "});",
    "",
    "export const collections = { posts };",
    "",
  ].join("\n"),
  "/mock/site/.astro/collections/posts.schema.json": JSON.stringify({
    $ref: "#/definitions/posts",
    definitions: {
      posts: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 3 },
          published: { type: "boolean", default: false },
          count: { type: "number", minimum: 0, maximum: 10 },
          tags: { type: "array", items: { type: "string" }, minItems: 1 },
          status: { type: "string", enum: ["draft", "review", "published"] },
          pubDate: {
            anyOf: [
              { type: "string", format: "date-time" },
              { type: "string", format: "date" },
              { type: "integer", format: "unix-time" },
            ],
          },
          author: {
            type: "object",
            properties: {
              name: { type: "string" },
              email: { type: "string", format: "email" },
            },
            required: ["name"],
            additionalProperties: false,
          },
          links: {
            type: "array",
            items: {
              type: "object",
              properties: { label: { type: "string" }, url: { type: "string" } },
              required: ["label", "url"],
              additionalProperties: false,
            },
          },
          relatedAuthor: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: { id: { type: "string" }, collection: { type: "string" } },
                required: ["id", "collection"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: { slug: { type: "string" }, collection: { type: "string" } },
                required: ["slug", "collection"],
                additionalProperties: false,
              },
            ],
          },
          misc: {},
          $schema: { type: "string" },
        },
        required: ["title", "tags", "author"],
        additionalProperties: false,
      },
    },
    $schema: "http://json-schema.org/draft-07/schema#",
  }),
  "/mock/site/src/layouts/BaseLayout.astro": "<html><slot /></html>",
  "/mock/site/src/layouts/PostLayout.astro": "<article><slot /></article>",
  "/mock/site/src/layouts/notes.txt": "not a layout",
  "/mock/site/index.md": "# Home\n\nWelcome.\n",
  "/mock/site/posts/first.md":
    "---\ntitle: First post\npublished: true\ncount: 3\ntags:\n  - alpha\n  - beta\nauthor:\n  name: Henry\n  email: h@example.com\nlinks:\n  - label: Home\n    url: /\n  - label: About\n    url: /about\n---\n\nHello world.\n",
  "/mock/site/notes.txt": "Some notes.\n",
  "/mock/site/src/styles/global.css": "body {\n  margin: 0;\n}\n",
  "/mock/site/public/theme.css": ":root {\n  --accent: rebeccapurple;\n}\n",
  "/mock/site/src/blog/with-slug.mdx":
    "---\ntitle: X\nslug: custom-slug\nrelated: src/blog/no-slug.mdx\nsee_also:\n  - src/blog/no-slug.mdx\nworks:\n  - src: src/blog/no-slug.mdx\n  - src: src/blog/with-slug.mdx\nimages:\n  - src: /images/photo.jpg\n    alt: A photo\n  - src: /images/nested/logo.png\n    alt: The logo\n---\n\nBody.\n",
  "/mock/site/src/blog/no-slug.mdx": "---\ntitle: Y\n---\n\nBody.\n",
  "/mock/site/src/blog/mdx-demo.mdx": [
    "---",
    "title: MDX demo",
    "---",
    "",
    "import CaptionedImage from '../components/CaptionedImage.astro';",
    "import Callout from '../components/Callout.astro';",
    "",
    "# A post with components",
    "",
    "Some **markdown** ahead of a component, with inline <Callout kind=\"tip\" /> JSX.",
    "",
    "<CaptionedImage src=\"/images/photo.jpg\" width={640}>",
    "  A caption with *emphasis*.",
    "</CaptionedImage>",
    "",
    "export const updated = '2026-07-03';",
    "",
    "Regular paragraph after.",
    "",
  ].join("\n"),
  "/mock/site/src/components/CaptionedImage.astro": [
    "---",
    "interface Props {",
    "  src: string;",
    "  alt?: string;",
    "  width?: number;",
    "  caption?: string;",
    "}",
    "const { src, alt = '', width, caption } = Astro.props;",
    "---",
    "<figure><img src={src} alt={alt} width={width} /><figcaption>{caption}</figcaption></figure>",
  ].join("\n"),
  "/mock/site/src/components/pull-quote.astro": [
    "---",
    "interface Props {",
    "  author: string;",
    "  source?: string;",
    "}",
    "---",
    "<blockquote><slot /><cite>{Astro.props.author}</cite></blockquote>",
  ].join("\n"),
  "/mock/site/src/components/Callout.astro": [
    "---",
    "interface Props {",
    "  kind: 'tip' | 'warning';",
    "}",
    "---",
    "<aside class={Astro.props.kind}><slot /></aside>",
  ].join("\n"),
};

// Files removed via delete_file; list_files' static groups filter these out
// so deletion is observable in the mock, mirroring the real backend.
const mockDeleted = new Set<string>();
const mockRepos: ManagedRepo[] = [
  {
    owner: "megaflorasoftware",
    name: "posto",
    root: "/mock/repos/megaflorasoftware/posto",
    url: "https://github.com/megaflorasoftware/posto.git",
  },
];

function mockTitle(path: string): string | null {
  if (!/\.(md|mdx|markdown)$/i.test(path)) return null;
  const content = mockFiles[path];
  const fm = content?.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const lines = fm[1].split(/\r?\n/);
  const line =
    lines.find((l) => l.startsWith("title:")) ?? lines.find((l) => l.startsWith("name:"));
  if (!line) return null;
  const value = line
    .slice(line.indexOf(":") + 1)
    .trim()
    .replace(/^["']|["']$/g, "");
  return value || null;
}

async function mockInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case "list_files": {
      const groups: FileGroup[] = [
        {
          label: "",
          path: "/mock/site",
          files: [
            { name: ".pages.yml", path: "/mock/site/.pages.yml" },
            { name: "index.md", path: "/mock/site/index.md" },
            { name: "notes.txt", path: "/mock/site/notes.txt" },
          ],
        },
        {
          label: "src/content/posts",
          path: "/mock/site/posts",
          files: [{ name: "first.md", path: "/mock/site/posts/first.md" }],
        },
        {
          label: "src/pages",
          path: "/mock/site/src/pages",
          files: [
            { name: "about.mdx", path: "/mock/site/src/pages/about.mdx" },
            { name: "index.mdx", path: "/mock/site/src/pages/index.mdx" },
          ],
        },
        {
          label: "src/pages/blog",
          path: "/mock/site/src/pages/blog",
          files: [{ name: "index.mdx", path: "/mock/site/src/pages/blog/index.mdx" }],
        },
        {
          label: "src/blog",
          path: "/mock/site/src/blog",
          files: [
            { name: "no-slug.mdx", path: "/mock/site/src/blog/no-slug.mdx" },
            { name: "with-slug.mdx", path: "/mock/site/src/blog/with-slug.mdx" },
            { name: "mdx-demo.mdx", path: "/mock/site/src/blog/mdx-demo.mdx" },
          ],
        },
      ].map((group) => {
        // Files created through the mock (create_text_file) appear alongside
        // the static entries, like a real directory re-listing would show.
        const created = Object.keys(mockFiles)
          .filter(
            (path) =>
              path.startsWith(group.path + "/") &&
              !path.slice(group.path.length + 1).includes("/") &&
              /\.(md|mdx|markdown|txt)$/i.test(path) &&
              !group.files.some((file) => file.path === path),
          )
          .map((path) => ({ name: path.split("/").pop() as string, path }));
        return {
          ...group,
          files: [...group.files, ...created]
            .filter((file) => !mockDeleted.has(file.path))
            .map((file) => ({ ...file, title: mockTitle(file.path) })),
        };
      });
      const styles = Object.keys(mockFiles)
        .filter((path) => path.endsWith(".css") && !mockDeleted.has(path))
        .sort()
        .map((path) => ({ name: path.split("/").pop() as string, path }));
      if (styles.length > 0) {
        groups.push({ label: "Styles", path: "/mock/site", kind: "styles", files: styles });
      }
      return groups;
    }
    case "list_dir_files": {
      const dir = args?.dir as string;
      const extensions = (args?.extensions as string[]) ?? [];
      const matches = Object.keys(mockFiles)
        .filter((path) => path.startsWith(dir + "/") && !mockDeleted.has(path))
        .filter(
          (path) =>
            extensions.length === 0 || extensions.includes(path.split(".").pop() as string),
        )
        .sort()
        .map((path) => ({ name: path.split("/").pop() as string, path }));
      if (matches.length > 0) return matches;
      if (dir.endsWith("/components")) throw new Error(`Not a directory: ${dir}`);
      // Media dirs have no mock file entries; serve the fixed image fixtures.
      return [
        { name: "photo.jpg", path: `${dir}/photo.jpg` },
        { name: "logo.png", path: `${dir}/nested/logo.png` },
      ];
    }
    case "read_text_file": {
      const path = args?.path as string;
      // Missing dotfile reads must fail like the real backend so ".pages.yml
      // absent" is distinguishable from an empty config.
      if (!(path in mockFiles) && path.endsWith(".pages.yml")) {
        throw new Error(`Failed to read ${path}`);
      }
      return mockFiles[path] ?? "";
    }
    case "write_text_file":
      mockFiles[args?.path as string] = args?.content as string;
      return null;
    case "create_text_file": {
      const path = args?.path as string;
      if (path in mockFiles) throw new Error(`File already exists: ${path}`);
      mockFiles[path] = args?.content as string;
      mockDeleted.delete(path);
      return null;
    }
    case "delete_file": {
      const path = args?.path as string;
      delete mockFiles[path];
      mockDeleted.add(path);
      return null;
    }
    case "revert_file":
      return null;
    case "clone_repo": {
      const url = args?.url as string;
      const match = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!match) throw new Error("Only GitHub repository URLs are supported");
      const [, owner, name] = match;
      const root = `/mock/repos/${owner}/${name}`;
      if (mockRepos.some((repo) => repo.root === root)) {
        throw new Error(`${owner}/${name} is already cloned`);
      }
      mockRepos.push({ owner, name, root, url });
      return root;
    }
    case "list_repos":
      return mockRepos.map((repo) => ({ ...repo }));
    case "remove_repo": {
      const root = args?.root as string;
      const index = mockRepos.findIndex((repo) => repo.root === root);
      if (index < 0) throw new Error("Path is not a managed git repository");
      mockRepos.splice(index, 1);
      return null;
    }
    case "fetch_upstream":
      return (window as { __mockBehindUpstream?: boolean }).__mockBehindUpstream ?? false;
    case "pull_upstream":
      (window as { __mockBehindUpstream?: boolean }).__mockBehindUpstream = false;
      return "Updated from server.";
    case "watch_root":
      return null;
    case "needs_install":
      return false;
    case "check_environment":
      return {
        node_version: "v22.14.0",
        package_manager: "pnpm",
        package_manager_version: "10.4.0",
        needs_node_modules: false,
      };
    case "install_node":
      return "v22.14.0";
    case "install_package_manager":
      return "10.4.0";
    case "install_dependencies":
      return null;
    case "start_dev_server":
      return 1420;
    case "ping_dev_server":
      return true;
    case "get_dev_server_logs":
      return [
        "> astro dev --port 4321",
        "12:00:01 [types] Generated 1ms",
        "[ERROR] [config] Unable to load astro.config.mjs",
        "  Error: mock failure for the developer-info panel",
      ];
    case "fetch_page":
      // Simulate a route with no page, for testing preview-navigation checks.
      if (((args?.route as string) ?? "").startsWith("/blog/no-slug")) {
        throw new Error("Dev server returned 404 for /blog/no-slug");
      }
      return [
        "<html><head>",
        "<title>Mock Page Title That Is Somewhat Long For Testing Truncation In Google</title>",
        '<meta name="description" content="A mock description used to exercise the SEO preview cards. It is deliberately written to be long enough that Google-style truncation kicks in somewhere around one hundred and sixty characters of text.">',
        '<meta property="og:title" content="Mock OG Title">',
        '<meta property="og:description" content="Mock OG description for social cards.">',
        '<meta property="og:image" content="https://example.com/og.png">',
        '<meta property="og:url" content="https://example.com' +
          ((args?.route as string) ?? "/") +
          '">',
        '<meta property="og:site_name" content="Mock Site">',
        '<meta name="twitter:card" content="summary_large_image">',
        '<link rel="icon" href="/favicon.svg">',
        "</head><body></body></html>",
      ].join("");
    case "stop_dev_server":
      return null;
    case "changed_files":
      return [
        { status: "M", path: "src/blog/with-slug.mdx" },
        { status: "??", path: "src/blog/new-post.mdx" },
        { status: "D", path: "src/blog/retired.mdx" },
      ];
    case "publish":
      return "Published (mock).";
    case "get_last_route":
      return (window as { __mockLastRoute?: string }).__mockLastRoute ?? null;
    case "get_last_root":
      return localStorage.getItem("posto-last-root");
    case "get_recent_roots": {
      const raw = localStorage.getItem("posto-recent-roots");
      return raw ? (JSON.parse(raw) as string[]) : [];
    }
    case "set_last_root": {
      const root = args?.root as string;
      localStorage.setItem("posto-last-root", root);
      const raw = localStorage.getItem("posto-recent-roots");
      const recents = raw ? (JSON.parse(raw) as string[]) : [];
      const next = [root, ...recents.filter((r) => r !== root)].slice(0, 10);
      localStorage.setItem("posto-recent-roots", JSON.stringify(next));
      return null;
    }
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

export const invoke: typeof tauriInvoke = inTauri
  ? tauriInvoke
  : (mockInvoke as typeof tauriInvoke);

export const openDirectory: () => Promise<string | null> = inTauri
  ? () => tauriOpen({ directory: true })
  : async () => "/mock/site";

/** URL that loads a local file in the webview, or null outside Tauri. */
export function assetUrl(absolutePath: string): string | null {
  return inTauri ? convertFileSrc(absolutePath) : null;
}

/** Open a path in the OS file manager; no-op outside Tauri. */
export const openPath: (absolutePath: string) => Promise<void> = inTauri
  ? tauriOpenPath
  : async () => {};

/**
 * Subscribes to the backend's debounced `fs-changed` events (absolute paths
 * touched outside or inside the app). Returns an unsubscribe function; no-op
 * outside Tauri, where there is no real filesystem to watch.
 */
export function onFsChanged(handler: (paths: string[]) => void): () => void {
  if (!inTauri) return () => {};
  const unlisten = listen<string[]>("fs-changed", (event) => handler(event.payload));
  return () => {
    void unlisten.then((fn) => fn());
  };
}

/** Subscribes to progress updates for the active managed-repository clone. */
export function onCloneProgress(handler: (progress: CloneProgress) => void): () => void {
  if (!inTauri) return () => {};
  const unlisten = listen<CloneProgress>("clone-progress", (event) => handler(event.payload));
  return () => {
    void unlisten.then((fn) => fn());
  };
}

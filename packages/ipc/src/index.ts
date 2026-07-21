import { convertFileSrc, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as tauriOpen } from "@tauri-apps/plugin-dialog";
import { openPath as tauriOpenPath, openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener";

const inTauri = "__TAURI_INTERNALS__" in window;

export interface FileEntry {
  name: string;
  path: string;
  /** Frontmatter `title:` (else `name:`) for display; filename when absent. */
  title?: string | null;
  /** Top-level scalar frontmatter pairs, for `.posto` collection settings
   * (entry-name templates, sorting). Absent for non-markdown files. */
  frontmatter?: Record<string, string> | null;
  /** Stable UI identity when several logical entries share one physical file. */
  key?: string;
  /** Logical entry inside an Astro file-loader data document. */
  dataEntry?: {
    collection: string;
    id: string;
    path: (string | number)[];
    format: "json" | "yaml" | "toml";
  };
}

export interface FileGroup {
  label: string;
  path: string;
  /** Synthetic-group marker ("styles" for the tree-wide CSS section). */
  kind?: string | null;
  files: FileEntry[];
  /** Astro collection represented by a synthetic data-document group. */
  dataCollection?: string;
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
  checkout_completed: number;
  checkout_total: number;
  phase: "downloading" | "checking_out";
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string;
  avatar_url: string;
  commit_email: string;
}

export interface AuthStatus {
  signed_in: boolean;
  user: GitHubUser | null;
}

export interface DeviceAuthorization {
  user_code: string;
  verification_uri: string;
  expires_in: number;
}

export interface GitHubRepo {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  private: boolean;
  clone_url: string;
  default_branch: string;
  updated_at: string;
}

/** `owner/name` parsed from a local repository's GitHub remote. */
export interface GitHubSlug {
  owner: string;
  name: string;
}

/** A GitHub Actions run, trimmed to what the deployment ring needs. */
export interface WorkflowRun {
  id: number;
  name: string;
  /** Groups runs "of that type" for duration averaging. */
  workflow_id: number;
  /** "queued" | "in_progress" | "completed" (other values pass through). */
  status: string;
  /** "success" | "failure" | "cancelled" | …; null while still running. */
  conclusion: string | null;
  run_started_at: string | null;
  updated_at: string;
  created_at: string;
  html_url: string;
}

export interface ImageLibraryImportRequest {
  libraryRoot: string;
  sourceImagePath: string;
  destinationImagePath: string;
  destinationMetadataPath: string;
  serializedMetadata: string;
  entryId: string;
}

export interface ImageLibraryImportResult {
  entryId: string;
  imagePath: string;
  metadataPath: string;
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
  // `.posto` overlay fixtures: pages before blog, blog sorted by date with a
  // templated entry label — exercising the collection-preferences path.
  "/mock/site/.posto/index.json": JSON.stringify(
    { version: 0, collections: { order: ["pages", "blog"] } },
    null,
    2,
  ),
  "/mock/site/.posto/collections/pages.json": JSON.stringify({ pinned: ["index.mdx"] }, null, 2),
  "/mock/site/.posto/collections/blog.json": JSON.stringify(
    {
      displayName: "Writing",
      entryName: "{fields.title}",
      filename: "{fields.title}.mdx",
      sort: { by: "fields.publish_date", direction: "desc" },
    },
    null,
    2,
  ),
  // Astro content-collection fixtures: `posts` has no `.pages.yml` entry, so
  // its form schema comes from the generated JSON Schema (fallback path).
  "/mock/site/src/content.config.ts": [
    'import { defineCollection, reference, z } from "astro:content";',
    'import { glob } from "astro/loaders";',
    "",
    "const posts = defineCollection({",
    '  loader: glob({ pattern: "**/*.md", base: "./posts" }),',
    '  schema: z.object({ hero: reference("media") }),',
    "});",
    "",
    "const media = defineCollection({",
    '  loader: glob({ pattern: "**/*.{yaml,yml,json}", base: "./media" }),',
    "  schema: ({ image }) => z.object({ image: image(), alt: z.string() }),",
    "});",
    "",
    "export const collections = { posts, media };",
    "",
  ].join("\n"),
  "/mock/site/.astro/collections/posts.schema.json": JSON.stringify({
    $ref: "#/definitions/posts",
    definitions: {
      posts: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 3 },
          hero: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: { id: { type: "string" }, collection: { type: "string" } },
                required: ["id", "collection"],
              },
            ],
          },
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
  "/mock/site/.astro/collections/media.schema.json": JSON.stringify({
    type: "object",
    properties: {
      image: { type: "string" },
      alt: { type: "string" },
    },
    required: ["image", "alt"],
  }),
  "/mock/site/media/portraits/person.yaml": "image: ./person.jpg\nalt: Portrait\n",
  "/mock/site/media/portraits/person.jpg": "[mock image]",
  "/mock/site/src/layouts/BaseLayout.astro": "<html><slot /></html>",
  "/mock/site/src/layouts/PostLayout.astro": "<article><slot /></article>",
  "/mock/site/src/layouts/notes.txt": "not a layout",
  "/mock/site/index.md": "# Home\n\nWelcome.\n",
  "/mock/site/posts/first.md":
    "---\ntitle: First post\nhero: portraits/person\npublished: true\ncount: 3\ntags:\n  - alpha\n  - beta\nauthor:\n  name: Henry\n  email: h@example.com\nlinks:\n  - label: Home\n    url: /\n  - label: About\n    url: /about\n---\n\nHello world.\n",
  "/mock/site/notes.txt": "Some notes.\n",
  // Gives the desktop/mobile "Open Site" affordance a URL to resolve in dev.
  "/mock/site/astro.config.mjs":
    "import { defineConfig } from 'astro/config';\n\nexport default defineConfig({\n  site: 'https://example.com',\n});\n",
  "/mock/repos/megaflorasoftware/posto/astro.config.mjs":
    "import { defineConfig } from 'astro/config';\n\nexport default defineConfig({\n  site: 'https://example.com',\n});\n",
  "/mock/site/src/styles/global.css": "body {\n  margin: 0;\n}\n",
  "/mock/site/public/theme.css": ":root {\n  --accent: rebeccapurple;\n}\n",
  "/mock/site/src/blog/with-slug.mdx":
    "---\ntitle: X\nslug: custom-slug\npublish_date: 2026-02-06\nrelated: src/blog/no-slug.mdx\nsee_also:\n  - src/blog/no-slug.mdx\nworks:\n  - src: src/blog/no-slug.mdx\n  - src: src/blog/with-slug.mdx\nimages:\n  - src: /images/photo.jpg\n    alt: A photo\n  - src: /images/nested/logo.png\n    alt: The logo\n---\n\nBody.\n",
  "/mock/site/src/blog/no-slug.mdx": "---\ntitle: Y\npublish_date: 2026-01-03\n---\n\nBody.\n",
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
    'Some **markdown** ahead of a component, with inline <Callout kind="tip" /> JSX.',
    "",
    '<CaptionedImage src="/images/photo.jpg" width={640}>',
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
const mockUser: GitHubUser = {
  id: 48483883,
  login: "hfellerhoff",
  name: "Henry Fellerhoff",
  avatar_url: "https://github.com/hfellerhoff.png",
  commit_email: "48483883+hfellerhoff@users.noreply.github.com",
};
let mockSignedIn = false;
const mockDeviceCodeHandlers = new Set<(authorization: DeviceAuthorization) => void>();
const mockCloneProgressHandlers = new Set<(progress: CloneProgress) => void>();
const mockGitHubRepos: GitHubRepo[] = [
  {
    id: 1,
    owner: "megaflorasoftware",
    name: "posto",
    full_name: "megaflorasoftware/posto",
    private: false,
    clone_url: "https://github.com/megaflorasoftware/posto.git",
    default_branch: "main",
    updated_at: "2026-07-17T12:00:00Z",
  },
  {
    id: 2,
    owner: "megaflorasoftware",
    name: "site-starter",
    full_name: "megaflorasoftware/site-starter",
    private: true,
    clone_url: "https://github.com/megaflorasoftware/site-starter.git",
    default_branch: "main",
    updated_at: "2026-07-16T18:30:00Z",
  },
];

// Deployment-ring fixtures: a run still in progress, preceded by three
// completed runs of the same workflow (~90s each) so the browser dev build
// shows a filling ring that averages to a realistic estimate.
function mockWorkflowRuns(): WorkflowRun[] {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const completed = (id: number, startedAgo: number, durationMs: number): WorkflowRun => ({
    id,
    name: "Deploy",
    workflow_id: 42,
    status: "completed",
    conclusion: "success",
    run_started_at: iso(startedAgo),
    updated_at: iso(startedAgo - durationMs),
    created_at: iso(startedAgo),
    html_url: "https://github.com/megaflorasoftware/posto/actions/runs/1000",
  });
  return [
    {
      id: 1004,
      name: "Deploy",
      workflow_id: 42,
      status: "in_progress",
      conclusion: null,
      run_started_at: iso(40_000),
      updated_at: iso(0),
      created_at: iso(42_000),
      html_url: "https://github.com/megaflorasoftware/posto/actions/runs/1004",
    },
    completed(1003, 600_000, 92_000),
    completed(1002, 1_200_000, 88_000),
    completed(1001, 1_800_000, 96_000),
  ];
}

function mockFrontmatter(path: string): Record<string, string> | null {
  if (!/\.(md|mdx|markdown)$/i.test(path)) return null;
  const content = mockFiles[path];
  const fm = content?.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const pairs: Record<string, string> = {};
  for (const line of fm[1].split(/\r?\n/)) {
    if (/^[\s-]/.test(line)) continue; // nested values and sequence items
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line
      .slice(sep + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key !== "" && !key.includes(" ") && value !== "") pairs[key] = value;
  }
  return Object.keys(pairs).length > 0 ? pairs : null;
}

function mockTitle(frontmatter: Record<string, string> | null): string | null {
  return frontmatter?.title ?? frontmatter?.name ?? null;
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
            .map((file) => {
              const frontmatter = mockFrontmatter(file.path);
              return { ...file, title: mockTitle(frontmatter), frontmatter };
            }),
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
          (path) => extensions.length === 0 || extensions.includes(path.split(".").pop() as string),
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
    case "image_thumbnail":
      return args?.path as string;
    case "list_directories": {
      const dir = args?.dir as string;
      const directories = new Set<string>([`${dir}/nested`]);
      for (const path of Object.keys(mockFiles)) {
        if (!path.startsWith(`${dir}/`) || mockDeleted.has(path)) continue;
        let parent = path.slice(0, path.lastIndexOf("/"));
        while (parent.startsWith(`${dir}/`)) {
          directories.add(parent);
          parent = parent.slice(0, parent.lastIndexOf("/"));
        }
      }
      return [...directories].sort();
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
      if ((path.split("/").pop() ?? "").startsWith(".")) {
        throw new Error(`Refusing to create a hidden file: ${path}`);
      }
      if (path in mockFiles) throw new Error(`File already exists: ${path}`);
      mockFiles[path] = args?.content as string;
      mockDeleted.delete(path);
      return null;
    }
    case "rename_file": {
      const from = args?.from as string;
      const to = args?.to as string;
      if ((to.split("/").pop() ?? "").startsWith(".")) {
        throw new Error(`Refusing to create a hidden file: ${to}`);
      }
      if (to in mockFiles) throw new Error(`File already exists: ${to}`);
      mockFiles[to] = mockFiles[from] ?? "";
      delete mockFiles[from];
      mockDeleted.add(from);
      mockDeleted.delete(to);
      return null;
    }
    case "delete_file": {
      const path = args?.path as string;
      delete mockFiles[path];
      mockDeleted.add(path);
      return null;
    }
    case "import_image_library_asset": {
      const plan = args?.plan as ImageLibraryImportRequest;
      if (plan.destinationImagePath in mockFiles || plan.destinationMetadataPath in mockFiles) {
        throw new Error("An image-library destination already exists");
      }
      mockFiles[plan.destinationImagePath] = "[mock image]";
      mockFiles[plan.destinationMetadataPath] = plan.serializedMetadata;
      mockDeleted.delete(plan.destinationImagePath);
      mockDeleted.delete(plan.destinationMetadataPath);
      return {
        entryId: plan.entryId,
        imagePath: plan.destinationImagePath,
        metadataPath: plan.destinationMetadataPath,
      };
    }
    case "revert_file":
      return null;
    case "open_in_app_browser":
      window.open(args?.url as string, "_blank", "noopener,noreferrer");
      return null;
    case "close_in_app_browser":
      return null;
    case "auth_status":
      return { signed_in: mockSignedIn, user: mockSignedIn ? { ...mockUser } : null };
    case "sign_in":
      mockDeviceCodeHandlers.forEach((handler) =>
        handler({
          user_code: "POST-O123",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
        }),
      );
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      mockSignedIn = true;
      return { ...mockUser };
    case "sign_out":
      mockSignedIn = false;
      return null;
    case "list_user_repos":
      if (!mockSignedIn) throw new Error("Not signed in to GitHub");
      return mockGitHubRepos.map((repo) => ({ ...repo }));
    case "clone_repo": {
      const url = args?.url as string;
      const match = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!match) throw new Error("Only GitHub repository URLs are supported");
      const [, owner, name] = match;
      const root = `/mock/repos/${owner}/${name}`;
      if (mockRepos.some((repo) => repo.root === root)) {
        throw new Error(`${owner}/${name} is already cloned`);
      }
      for (const received of [8, 31, 68, 100]) {
        mockCloneProgressHandlers.forEach((handler) =>
          handler({
            received_objects: received,
            total_objects: 100,
            indexed_objects: Math.max(0, received - 8),
            received_bytes: received * 18_000,
            checkout_completed: 0,
            checkout_total: 0,
            phase: "downloading",
          }),
        );
        await new Promise((resolve) => window.setTimeout(resolve, 120));
      }
      for (const completed of [0, 24, 72, 112]) {
        mockCloneProgressHandlers.forEach((handler) =>
          handler({
            received_objects: 100,
            total_objects: 100,
            indexed_objects: 100,
            received_bytes: 1_800_000,
            checkout_completed: completed,
            checkout_total: 112,
            phase: "checking_out",
          }),
        );
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
      if (new URLSearchParams(window.location.search).has("mockCloneError")) {
        throw new Error(
          `Could not download ${owner}/${name}. Check your internet connection and available device storage, keep Posto open, then try again. Any partial download was removed. Details: connection interrupted`,
        );
      }
      mockRepos.push({ owner, name, root, url });
      return root;
    }
    case "list_repos":
      return mockRepos.map((repo) => ({ ...repo }));
    case "github_remote": {
      // The desktop deployment ring resolves the open folder to a slug; the
      // mock site maps to the sample repo, anything else to "no repo".
      const root = args?.root as string;
      if (new URLSearchParams(window.location.search).has("mockNoRepo")) return null;
      return root.includes("/mock/") ? { owner: "megaflorasoftware", name: "posto" } : null;
    }
    case "list_workflow_runs": {
      if (!mockSignedIn) throw new Error("Not signed in to GitHub");
      const params = new URLSearchParams(window.location.search);
      if (params.has("mockNoRuns")) return [];
      const runs = mockWorkflowRuns();
      // `?mockDeployed` finishes the latest run, for checking the done/check UI.
      if (params.has("mockDeployed")) {
        runs[0] = { ...runs[0], status: "completed", conclusion: "success" };
      }
      return runs;
    }
    case "doctor_repo":
      if (new URLSearchParams(window.location.search).has("mockRepoBroken")) {
        throw new Error(
          "The local Git repository could not be opened: repository data is incomplete",
        );
      }
      return "Repository checked.";
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

export function importImageLibraryAsset(
  plan: ImageLibraryImportRequest,
): Promise<ImageLibraryImportResult> {
  return invoke("import_image_library_asset", { plan });
}

export const openDirectory: () => Promise<string | null> = inTauri
  ? () => tauriOpen({ directory: true })
  : async () => "/mock/site";

const IMAGE_FILE_FILTERS = [
  {
    name: "Images",
    extensions: ["avif", "gif", "heic", "heif", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp"],
  },
];

async function decodeBitmap(blob: Blob): Promise<ImageBitmap> {
  // EXIF orientation is baked in so portrait photos aren't rotated; retry
  // without the option for engines that reject it.
  try {
    return await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    return createImageBitmap(blob);
  }
}

/** Transcodes already-read image bytes to a JPEG temp file and returns its
 * absolute path. Decoding from an in-memory Blob keeps the canvas same-origin
 * (no asset-protocol taint blocking the export); WKWebView supplies the HEIC
 * decoder. */
async function convertBytesToJpeg(bytes: Uint8Array): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await decodeBitmap(new Blob([bytes]));
  } catch {
    throw new Error("Could not decode the selected image.");
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare the image for import.");
    context.drawImage(bitmap, 0, 0);
    const output = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) =>
          result ? resolve(result) : reject(new Error("Could not convert the image to JPEG.")),
        "image/jpeg",
        0.92,
      );
    });
    const out = Array.from(new Uint8Array(await output.arrayBuffer()));
    return invoke<string>("write_temp_image", { bytes: out, extension: "jpg" });
  } finally {
    bitmap.close();
  }
}

async function prepareImageSource(path: string): Promise<string> {
  // The picker's extension can't be trusted — iOS hands HEIFs back named
  // ".jpeg" — so sniff the file's actual content server-side and only re-encode
  // true HEIFs, which the site (and most browsers) can't render.
  if (!(await invoke<boolean>("probe_image_is_heif", { path }))) return path;
  const bytes = new Uint8Array(await invoke<number[]>("read_image_bytes", { path }));
  return convertBytesToJpeg(bytes);
}

/** Normalizes chosen or dropped source images so the importer always receives a
 * format the app can preview and the published site can render — HEIC/HEIF are
 * transcoded to JPEG, everything else passes through untouched. */
export async function prepareImageSources(paths: string[]): Promise<string[]> {
  if (!inTauri) return paths;
  return Promise.all(paths.map(prepareImageSource));
}

/** The iOS picker returns `file://` URLs, but every filesystem consumer (the
 * native importer, the byte reader, the format probe) expects a plain path, so
 * strip the scheme and percent-decode. Plain paths (desktop) pass through. */
function toFilesystemPath(path: string): string {
  if (!path.startsWith("file://")) return path;
  try {
    return decodeURIComponent(new URL(path).pathname);
  } catch {
    return decodeURIComponent(path.slice("file://".length));
  }
}

export const openImageFile: () => Promise<string | null> = inTauri
  ? async () => {
      const selected = await tauriOpen({ multiple: false, filters: IMAGE_FILE_FILTERS });
      return typeof selected === "string" ? toFilesystemPath(selected) : null;
    }
  : async () => "/mock/uploads/photo.jpg";

export const openImageFiles: () => Promise<string[]> = inTauri
  ? async () => {
      const selected = await tauriOpen({ multiple: true, filters: IMAGE_FILE_FILTERS });
      const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
      return paths.map(toFilesystemPath);
    }
  : async () => ["/mock/uploads/photo.jpg"];

type FileDropHandler = (paths: string[]) => void;
const fileDropHandlers: FileDropHandler[] = [];
let fileDropListenerStarted = false;

/** Routes native desktop file drops through one shared integration point.
 * The newest mounted surface owns the event, so a modal dropzone takes
 * precedence over the app-wide drop importer behind it. */
export function onFileDrop(handler: FileDropHandler): () => void {
  fileDropHandlers.push(handler);
  if (inTauri && !fileDropListenerStarted) {
    fileDropListenerStarted = true;
    void getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        fileDropHandlers[fileDropHandlers.length - 1]?.(event.payload.paths);
      }
    });
  }
  return () => {
    const index = fileDropHandlers.lastIndexOf(handler);
    if (index >= 0) fileDropHandlers.splice(index, 1);
  };
}

/** URL that loads a local file in the webview, or null outside Tauri. */
export function assetUrl(absolutePath: string): string | null {
  return inTauri ? convertFileSrc(absolutePath) : null;
}

const thumbnailRequests = new Map<string, Promise<string | null>>();

/** Returns a cached, bounded preview URL and falls back to the source when its
 * format cannot be decoded by the native thumbnailer. Requests are only
 * deduplicated while in flight so filesystem edits get a fresh cache key. */
export function thumbnailUrl(
  absolutePath: string,
  maxWidth = 320,
  maxHeight = 240,
): Promise<string | null> {
  const original = assetUrl(absolutePath);
  if (!original) return Promise.resolve(null);
  const key = `${absolutePath}:${maxWidth}:${maxHeight}`;
  const pending = thumbnailRequests.get(key);
  if (pending) return pending;
  const request = invoke<string>("image_thumbnail", {
    path: absolutePath,
    maxWidth,
    maxHeight,
  })
    .then((path) => assetUrl(path) ?? original)
    .catch(() => original)
    .finally(() => thumbnailRequests.delete(key));
  thumbnailRequests.set(key, request);
  return request;
}

/** Open a path in the OS file manager; no-op outside Tauri. */
export const openPath: (absolutePath: string) => Promise<void> = inTauri
  ? tauriOpenPath
  : async () => {};

/** Open an external URL in the system browser. */
export const openUrl: (url: string) => Promise<void> = inTauri
  ? tauriOpenUrl
  : async (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    };

/** Open a URL in an in-app browser tab over the app (mobile; falls back to
 * the system browser where no in-app tab exists). */
export function openUrlInApp(url: string): Promise<void> {
  return invoke("open_in_app_browser", { url });
}

/** Dismiss the in-app browser tab if one is presented. */
export function closeInAppBrowser(): Promise<void> {
  return invoke("close_in_app_browser");
}

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
  if (!inTauri) {
    mockCloneProgressHandlers.add(handler);
    return () => mockCloneProgressHandlers.delete(handler);
  }
  const unlisten = listen<CloneProgress>("clone-progress", (event) => handler(event.payload));
  return () => {
    void unlisten.then((fn) => fn());
  };
}

/** Subscribes to the public code emitted while GitHub sign-in is pending. */
export function onAuthDeviceCode(
  handler: (authorization: DeviceAuthorization) => void,
): () => void {
  if (!inTauri) {
    mockDeviceCodeHandlers.add(handler);
    return () => mockDeviceCodeHandlers.delete(handler);
  }
  const unlisten = listen<DeviceAuthorization>("auth-device-code", (event) =>
    handler(event.payload),
  );
  return () => {
    void unlisten.then((fn) => fn());
  };
}

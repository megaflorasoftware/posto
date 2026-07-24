import {
  setBrowserBackend,
  type CloneProgress,
  type DeviceAuthorization,
  type FileGroup,
  type GitHubRepo,
  type GitHubUser,
  type ImageLibraryImportRequest,
  type ManagedRepo,
  type WorkflowRun,
} from "./index";
import { scalarFrontmatter } from "@posto/core/pagescms/frontmatterScalars";

/**
 * Browser development backend.
 *
 * Keep command success, failure, and missing-path behavior aligned with the
 * Rust commands. Fixtures belong here, must use obviously fake identities,
 * and may only be installed explicitly by a browser app entrypoint.
 */

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
  "/mock/site/public/images/photo.jpg": "[mock image]",
  "/mock/site/public/images/nested/logo.png": "[mock image]",
  "/mock/site/public/downloads/guide.pdf": "[mock pdf]",
  "/mock/site/public/media/theme.mp3": "[mock audio]",
  "/mock/site/public/media/trailer.mp4": "[mock video]",
  "/mock/site/.hidden.txt": "hidden fixture",
  "/mock/site/dist/generated.txt": "build fixture",
  "/mock/site/node_modules/example/readme.txt": "dependency fixture",
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
  "/mock/repos/example-org/posto/astro.config.mjs":
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
const mockDirectories = new Set<string>();

function rememberMockPath(path: string) {
  let directory = path.slice(0, path.lastIndexOf("/"));
  while (directory) {
    mockDirectories.add(directory);
    directory = directory.slice(0, directory.lastIndexOf("/"));
  }
}

Object.keys(mockFiles).forEach(rememberMockPath);
const mockRepos: ManagedRepo[] = [
  {
    owner: "example-org",
    name: "posto",
    // The complete browser fixture lives at /mock/site. Point the pre-cloned
    // mobile repository there so its media libraries and content references
    // can be exercised end to end instead of opening the sparse clone stub.
    root: "/mock/site",
    url: "https://github.com/example-org/posto.git",
  },
];
const mockUser: GitHubUser = {
  id: 123456,
  login: "example-user",
  name: "Example User",
  avatar_url: "https://example.com/avatar.png",
  commit_email: "123456+example-user@users.noreply.github.com",
};
let mockSignedIn = false;
let mockCredentialDenied = new URLSearchParams(window.location.search).has("mockCredentialDenied");
const mockDeviceCodeHandlers = new Set<(authorization: DeviceAuthorization) => void>();
const mockCloneProgressHandlers = new Set<(progress: CloneProgress) => void>();
const mockGitHubRepos: GitHubRepo[] = [
  {
    id: 1,
    owner: "example-org",
    name: "posto",
    full_name: "example-org/posto",
    private: false,
    clone_url: "https://github.com/example-org/posto.git",
    default_branch: "main",
    updated_at: "2026-07-17T12:00:00Z",
  },
  {
    id: 2,
    owner: "example-org",
    name: "site-starter",
    full_name: "example-org/site-starter",
    private: true,
    clone_url: "https://github.com/example-org/site-starter.git",
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
    html_url: "https://github.com/example-org/posto/actions/runs/1000",
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
      html_url: "https://github.com/example-org/posto/actions/runs/1004",
    },
    completed(1003, 600_000, 92_000),
    completed(1002, 1_200_000, 88_000),
    completed(1001, 1_800_000, 96_000),
  ];
}

function mockFrontmatter(path: string): Record<string, string> | null {
  if (!/\.(md|mdx|markdown)$/i.test(path)) return null;
  return scalarFrontmatter(mockFiles[path] ?? "");
}

function mockTitle(frontmatter: Record<string, string> | null): string | null {
  return frontmatter?.title ?? frontmatter?.name ?? null;
}

const skippedMockDirectories = new Set(["node_modules", "_site", "dist", "build", "out", "target"]);

function listMockDirFiles(dir: string, extensions: string[]) {
  if (!mockDirectories.has(dir)) throw new Error(`Not a directory: ${dir}`);
  return Object.keys(mockFiles)
    .filter((path) => path.startsWith(dir + "/") && !mockDeleted.has(path))
    .filter((path) => {
      const segments = path.slice(dir.length + 1).split("/");
      return (
        segments.every((segment) => !segment.startsWith(".")) &&
        segments.slice(0, -1).every((segment) => !skippedMockDirectories.has(segment))
      );
    })
    .filter(
      (path) => extensions.length === 0 || extensions.includes(path.split(".").pop() as string),
    )
    .sort()
    .map((path) => ({ name: path.split("/").pop() as string, path }));
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
      return listMockDirFiles(dir, extensions);
    }
    case "list_dir_files_optional": {
      const dir = args?.dir as string;
      const extensions = (args?.extensions as string[]) ?? [];
      if (!mockDirectories.has(dir)) return null;
      return listMockDirFiles(dir, extensions);
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
    case "import_file_media_item":
    case "import_public_media_file": {
      const request = args?.request as {
        repositoryRoot: string;
        mediaRoot?: string;
        sourceFilePath: string;
        directory: string;
      };
      const name = request.sourceFilePath.split("/").pop() as string;
      const mediaRoot = request.mediaRoot ?? `${request.repositoryRoot}/public`;
      const target = [mediaRoot, request.directory, name].filter(Boolean).join("/");
      if (target in mockFiles && !mockDeleted.has(target)) {
        throw new Error(`File already exists: ${target}`);
      }
      mockFiles[target] = "mock binary file";
      mockDirectories.add(target.slice(0, target.lastIndexOf("/")));
      mockDeleted.delete(target);
      return target;
    }
    case "create_file_media_directory":
    case "create_public_media_directory": {
      const mediaRoot =
        (args?.mediaRoot as string | undefined) ?? `${args?.repositoryRoot as string}/public`;
      const directoryPath = [mediaRoot, args?.directory as string].filter(Boolean).join("/");
      if (mockDirectories.has(directoryPath)) {
        throw new Error(`Folder already exists: ${directoryPath}`);
      }
      mockDirectories.add(directoryPath);
      return null;
    }
    case "list_child_directories": {
      const dir = args?.dir as string;
      const children = new Set<string>();
      for (const path of mockDirectories) {
        if (!path.startsWith(`${dir}/`)) continue;
        const child = path.slice(dir.length + 1).split("/")[0];
        if (child) children.add(`${dir}/${child}`);
      }
      return [...children].sort();
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
    case "read_text_file_optional": {
      const path = args?.path as string;
      if (
        new URLSearchParams(window.location.search).has("mockNoLocalSiteUrl") &&
        (path.includes("/astro.config.") ||
          path.endsWith("/public/CNAME") ||
          path.endsWith("/package.json"))
      ) {
        return null;
      }
      return path in mockFiles && !mockDeleted.has(path) ? mockFiles[path] : null;
    }
    case "path_exists": {
      const path = args?.path as string;
      const kind = args?.kind;
      const isFile = path in mockFiles && !mockDeleted.has(path);
      const isDirectory = mockDirectories.has(path);
      if (kind === "file") return isFile;
      if (kind === "directory") return isDirectory;
      if (kind !== undefined) {
        const label = typeof kind === "string" ? kind : JSON.stringify(kind);
        throw new Error(`Unknown path kind: ${label}`);
      }
      return isFile || isDirectory;
    }
    case "write_text_file":
      mockFiles[args?.path as string] = args?.content as string;
      rememberMockPath(args?.path as string);
      return null;
    case "create_text_file": {
      const path = args?.path as string;
      if ((path.split("/").pop() ?? "").startsWith(".")) {
        throw new Error(`Refusing to create a hidden file: ${path}`);
      }
      if (path in mockFiles) throw new Error(`File already exists: ${path}`);
      mockFiles[path] = args?.content as string;
      rememberMockPath(path);
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
      rememberMockPath(to);
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
    case "delete_media_file": {
      const mediaRoot = args?.mediaRoot as string;
      const path = args?.filePath as string;
      if (!path.startsWith(`${mediaRoot}/`)) throw new Error("Media file is outside its root");
      delete mockFiles[path];
      mockDeleted.add(path);
      return null;
    }
    case "rename_media_file": {
      const mediaRoot = args?.mediaRoot as string;
      const path = args?.filePath as string;
      const target = args?.targetFilePath as string;
      if (!path.startsWith(`${mediaRoot}/`) || !target.startsWith(`${mediaRoot}/`)) {
        throw new Error("Media rename is outside its root");
      }
      if (target in mockFiles || mockDirectories.has(target)) {
        throw new Error(`A file or folder already exists at ${target}`);
      }
      mockFiles[target] = mockFiles[path] ?? "";
      rememberMockPath(target);
      delete mockFiles[path];
      mockDeleted.add(path);
      mockDeleted.delete(target);
      return null;
    }
    case "move_media_file": {
      const mediaRoot = args?.mediaRoot as string;
      const path = args?.filePath as string;
      const destination = args?.destinationDirectory as string;
      if (
        !path.startsWith(`${mediaRoot}/`) ||
        (destination !== mediaRoot && !destination.startsWith(`${mediaRoot}/`))
      ) {
        throw new Error("Media move is outside its root");
      }
      const target = `${destination}/${path.split("/").pop()}`;
      if (target in mockFiles || mockDirectories.has(target)) {
        throw new Error(`A file or folder with that name already exists in ${destination}`);
      }
      mockFiles[target] = mockFiles[path] ?? "";
      rememberMockPath(target);
      delete mockFiles[path];
      mockDeleted.add(path);
      mockDeleted.delete(target);
      return null;
    }
    case "create_image_library_directory": {
      const path = args?.directoryPath as string;
      if ((path.split("/").pop() ?? "").startsWith(".")) {
        throw new Error(`Refusing to create a hidden folder: ${path}`);
      }
      if (mockDirectories.has(path)) throw new Error(`Folder already exists: ${path}`);
      mockDirectories.add(path);
      return null;
    }
    case "delete_image_library_asset": {
      const imagePath = args?.imagePath as string;
      const metadataPath = args?.metadataPath as string;
      delete mockFiles[imagePath];
      delete mockFiles[metadataPath];
      mockDeleted.add(imagePath);
      mockDeleted.add(metadataPath);
      return null;
    }
    case "move_image_library_asset": {
      const imagePath = args?.imagePath as string;
      const metadataPath = args?.metadataPath as string;
      const destination = args?.destinationDirectory as string;
      const targetImage = `${destination}/${imagePath.split("/").pop()}`;
      const targetMetadata = `${destination}/${metadataPath.split("/").pop()}`;
      if (targetImage in mockFiles || targetMetadata in mockFiles) {
        throw new Error(`A file with that name already exists in ${destination}`);
      }
      mockFiles[targetImage] = mockFiles[imagePath] ?? "";
      mockFiles[targetMetadata] = mockFiles[metadataPath] ?? "";
      rememberMockPath(targetImage);
      rememberMockPath(targetMetadata);
      delete mockFiles[imagePath];
      delete mockFiles[metadataPath];
      mockDeleted.add(imagePath);
      mockDeleted.add(metadataPath);
      return null;
    }
    case "rename_image_library_asset": {
      const imagePath = args?.imagePath as string;
      const metadataPath = args?.metadataPath as string;
      const targetImagePath = args?.targetImagePath as string;
      const targetMetadataPath = args?.targetMetadataPath as string;
      if (targetImagePath in mockFiles || targetMetadataPath in mockFiles) {
        throw new Error("An image-library destination already exists");
      }
      mockFiles[targetImagePath] = mockFiles[imagePath] ?? "";
      mockFiles[targetMetadataPath] = args?.serializedMetadata as string;
      rememberMockPath(targetImagePath);
      rememberMockPath(targetMetadataPath);
      delete mockFiles[imagePath];
      delete mockFiles[metadataPath];
      mockDeleted.add(imagePath);
      mockDeleted.add(metadataPath);
      return null;
    }
    case "delete_media_directory":
    case "delete_image_library_directory": {
      const directory = args?.directoryPath as string;
      const root = (args?.mediaRoot ?? args?.libraryRoot) as string;
      if (!directory.startsWith(`${root}/`)) throw new Error("Media folder is outside its root");
      for (const path of Object.keys(mockFiles)) {
        if (path.startsWith(`${directory}/`)) {
          delete mockFiles[path];
          mockDeleted.add(path);
        }
      }
      for (const path of Array.from(mockDirectories)) {
        if (path === directory || path.startsWith(`${directory}/`)) mockDirectories.delete(path);
      }
      return null;
    }
    case "move_media_directory":
    case "move_image_library_directory": {
      const directory = args?.directoryPath as string;
      const destination = args?.destinationDirectory as string;
      const root = (args?.mediaRoot ?? args?.libraryRoot) as string;
      if (
        !directory.startsWith(`${root}/`) ||
        (destination !== root && !destination.startsWith(`${root}/`))
      ) {
        throw new Error("Media move is outside its root");
      }
      const target = `${destination}/${directory.split("/").pop()}`;
      if (mockDirectories.has(target)) throw new Error(`Folder already exists: ${target}`);
      for (const path of Object.keys(mockFiles)) {
        if (!path.startsWith(`${directory}/`)) continue;
        const moved = `${target}${path.slice(directory.length)}`;
        mockFiles[moved] = mockFiles[path];
        rememberMockPath(moved);
        delete mockFiles[path];
        mockDeleted.add(path);
      }
      for (const path of Array.from(mockDirectories)) {
        if (path !== directory && !path.startsWith(`${directory}/`)) continue;
        mockDirectories.delete(path);
        mockDirectories.add(`${target}${path.slice(directory.length)}`);
      }
      return null;
    }
    case "import_image_library_asset": {
      const plan = args?.plan as ImageLibraryImportRequest;
      if (plan.destinationImagePath in mockFiles || plan.destinationMetadataPath in mockFiles) {
        throw new Error("An image-library destination already exists");
      }
      mockFiles[plan.destinationImagePath] = "[mock image]";
      mockFiles[plan.destinationMetadataPath] = plan.serializedMetadata;
      rememberMockPath(plan.destinationImagePath);
      rememberMockPath(plan.destinationMetadataPath);
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
      if (mockCredentialDenied) throw new Error("The credential request was denied");
      return { signed_in: mockSignedIn, user: mockSignedIn ? { ...mockUser } : null };
    case "retry_auth_status":
      mockCredentialDenied = false;
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
      return root.includes("/mock/") ? { owner: "example-org", name: "posto" } : null;
    }
    case "github_pages_url":
      return "https://example-org.github.io/posto/";
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
    case "get_last_selection": {
      const root = localStorage.getItem("posto-last-root");
      if (!root) return null;
      const saved = localStorage.getItem(`posto-work-dir:${root}`);
      return { root, workDir: saved && mockDirectories.has(saved) ? saved : null };
    }
    case "get_work_dir": {
      const root = args?.root as string;
      const saved = localStorage.getItem(`posto-work-dir:${root}`);
      return saved && mockDirectories.has(saved) ? saved : null;
    }
    case "get_recent_roots": {
      const raw = localStorage.getItem("posto-recent-roots");
      return raw ? (JSON.parse(raw) as string[]) : [];
    }
    case "get_developer_mode":
      return localStorage.getItem("posto-developer-mode") === "true";
    case "set_developer_mode":
      localStorage.setItem("posto-developer-mode", String(args?.enabled === true));
      return null;
    case "set_last_root": {
      const root = args?.root as string;
      localStorage.setItem("posto-last-root", root);
      localStorage.setItem(`posto-work-dir:${root}`, (args?.workDir as string | undefined) ?? root);
      const raw = localStorage.getItem("posto-recent-roots");
      const recents = raw ? (JSON.parse(raw) as string[]) : [];
      const next = [root, ...recents.filter((r) => r !== root)].slice(0, 10);
      localStorage.setItem("posto-recent-roots", JSON.stringify(next));
      return null;
    }
    case "scan_projects": {
      const root = args?.root as string;
      return [{ dir: root, markers: ["package.json", "astro.config.mjs"] }];
    }
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

export function installMockBackend(): void {
  setBrowserBackend({
    invoke: mockInvoke as typeof import("@tauri-apps/api/core").invoke,
    openDirectory: async () => "/mock/site",
    openFile: async () => "/mock/uploads/document.pdf",
    openFiles: async () => ["/mock/uploads/document.pdf"],
    openImageFile: async () => "/mock/uploads/photo.jpg",
    openImageFiles: async () => ["/mock/uploads/photo.jpg"],
    onCloneProgress(handler) {
      mockCloneProgressHandlers.add(handler);
      return () => mockCloneProgressHandlers.delete(handler);
    },
    onAuthDeviceCode(handler) {
      mockDeviceCodeHandlers.add(handler);
      return () => mockDeviceCodeHandlers.delete(handler);
    },
  });
}

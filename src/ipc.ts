import { convertFileSrc, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { open as tauriOpen } from "@tauri-apps/plugin-dialog";

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
  files: FileEntry[];
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
    "      - { name: body, label: Body, type: rich-text }",
    "",
  ].join("\n"),
  "/mock/site/index.md": "# Home\n\nWelcome.\n",
  "/mock/site/posts/first.md": "# First post\n\nHello world.\n",
  "/mock/site/notes.txt": "Some notes.\n",
  "/mock/site/src/blog/with-slug.mdx":
    "---\ntitle: X\nslug: custom-slug\nimages:\n  - src: /public/images/photo.jpg\n    alt: A photo\n  - src: /public/images/nested/logo.png\n    alt: The logo\n---\n\nBody.\n",
  "/mock/site/src/blog/no-slug.mdx": "---\ntitle: Y\n---\n\nBody.\n",
};

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
    case "list_files":
      return [
        {
          label: "",
          path: "/mock/site",
          files: [
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
          ],
        },
      ].map((group) => ({
        ...group,
        files: group.files.map((file) => ({ ...file, title: mockTitle(file.path) })),
      }));
    case "list_dir_files":
      return [
        { name: "photo.jpg", path: `${args?.dir}/photo.jpg` },
        { name: "logo.png", path: `${args?.dir}/nested/logo.png` },
      ];
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
    case "needs_install":
      return false;
    case "install_dependencies":
      return null;
    case "start_dev_server":
      return 1420;
    case "ping_dev_server":
      return true;
    case "stop_dev_server":
      return null;
    case "publish":
      return "Published (mock).";
    case "get_last_route":
      return (window as { __mockLastRoute?: string }).__mockLastRoute ?? null;
    case "get_last_root":
      return localStorage.getItem("posto-last-root");
    case "set_last_root":
      localStorage.setItem("posto-last-root", args?.root as string);
      return null;
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

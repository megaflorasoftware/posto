import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { open as tauriOpen } from "@tauri-apps/plugin-dialog";

const inTauri = "__TAURI_INTERNALS__" in window;

// Browser-only mock so the UI can be developed and tested outside the Tauri
// shell (invoke/dialog are unavailable there).
const mockFiles: Record<string, string> = {
  "/mock/site/index.md": "# Home\n\nWelcome.\n",
  "/mock/site/posts/first.md": "# First post\n\nHello world.\n",
  "/mock/site/notes.txt": "Some notes.\n",
  "/mock/site/src/blog/with-slug.mdx": '---\ntitle: X\nslug: custom-slug\n---\n\nBody.\n',
  "/mock/site/src/blog/no-slug.mdx": "---\ntitle: Y\n---\n\nBody.\n",
};

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
      ];
    case "read_text_file":
      return mockFiles[args?.path as string] ?? "";
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

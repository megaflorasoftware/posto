// End-to-end engine flows against the in-memory demo backend: the same
// methods Swift calls, with the same JSON envelopes.
import { beforeAll, describe, expect, it } from "vitest";

const scope = globalThis as unknown as Record<string, unknown>;
scope.window = globalThis;

type Envelope = { ok?: unknown; error?: string };
let run: (method: string, args: Record<string, unknown>) => Promise<Envelope>;

/** Waits out the save queue, including a template rename queued after it,
 * and returns the open document's current path. */
async function settledPath(): Promise<string> {
  await call("doc.flush");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await call("doc.flush");
  return (await call<{ path: string }>("doc.view")).path;
}

async function call<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await run(method, args);
  if (response.error !== undefined) throw new Error(`${method}: ${response.error}`);
  return response.ok as T;
}

interface TreeNode {
  label: string;
  path: string;
  files: Array<{ key: string; label: string; name: string }>;
  children: TreeNode[];
  canCreate: boolean;
}

function allFiles(nodes: TreeNode[]): Array<{ key: string; label: string; name: string }> {
  return nodes.flatMap((node) => [...node.files, ...allFiles(node.children)]);
}

beforeAll(async () => {
  ({ run } = await import("../src/main"));
  await call("engine.useDemo");
});

describe("demo backend passthrough", () => {
  it("signs in and lists managed repositories", async () => {
    await call("backend.invoke", { command: "sign_in" });
    const status = await call<{ signed_in: boolean }>("backend.invoke", { command: "auth_status" });
    expect(status.signed_in).toBe(true);
    const repos = await call<Array<{ root: string }>>("backend.invoke", { command: "list_repos" });
    expect(repos.map((repo) => repo.root)).toContain("/mock/site");
  });
});

describe("repository session", () => {
  it("opens the fixture site with collections in sidebar order", async () => {
    const view = await call<{
      root: string;
      loading: boolean;
      tree: TreeNode[];
      looseFiles: Array<{ name: string }>;
      fileCount: number;
      branch: string | null;
      mediaLibraryCount: number;
      error: string | null;
    }>("repo.open", {
      repoRoot: "/mock/site",
      repo: {
        owner: "example-org",
        name: "posto",
        cloneUrl: "https://github.com/example-org/posto.git",
        defaultBranch: "main",
      },
      developerMode: true,
    });
    expect(view.error).toBeNull();
    expect(view.loading).toBe(false);
    expect(view.fileCount).toBeGreaterThan(3);
    expect(view.tree.map((node) => node.label)).toContain("Writing");
    expect(view.looseFiles.map((file) => file.name)).toContain("index.md");
    expect(view.branch).toBe("main");
  });

  it("edits frontmatter through the form and autosaves the file", async () => {
    const view = await call<{ tree: TreeNode[] }>("repo.view");
    const blog = view.tree.find((node) => node.label === "Writing")!;
    const file = allFiles([blog]).find((candidate) => candidate.name === "with-slug.mdx")!;
    const document = await call<{
      tabs: string[];
      form: { fields: Array<{ name: string; type: string }>; values: Record<string, unknown> };
      body: { kind: string; text: string };
    }>("doc.open", { key: file.key });
    expect(document.tabs).toEqual(["content", "raw"]);
    expect(document.form.fields.map((field) => field.name)).toContain("title");
    expect(document.body.kind).toBe("mdx");

    const edited = await call<{
      saveState: string;
      form: { values: Record<string, unknown>; errors: Record<string, string> };
    }>("form.edit", { path: ["title"], value: "Edited from the native app" });
    expect(edited.form.values.title).toBe("Edited from the native app");
    expect(edited.saveState).toBe("saving");

    const raw = await call<string>("backend.invoke", {
      command: "read_text_file",
      args: { path: await settledPath() },
    });
    expect(raw).toContain('title: "Edited from the native app"');
  });

  it("edits dates through native picker values in the document's spelling", async () => {
    const view = await call<{ tree: TreeNode[] }>("repo.view");
    const file = allFiles(view.tree).find((candidate) => candidate.label === "Y")!;
    const before = await call<{
      form: { values: Record<string, unknown>; dates: Record<string, { date: string }> };
    }>("doc.open", { key: file.key });
    const original = String(before.form.values.publish_date ?? "");
    const edited = await call<{
      form: { values: Record<string, unknown>; dates: Record<string, { date: string }> };
    }>("form.editDate", { path: ["publish_date"], control: "2024-03-09", time: false });
    expect(edited.form.dates.publish_date.date).toBe("2024-03-09");
    const stored = String(edited.form.values.publish_date);
    expect(stored).toContain("2024");
    // A value that already had a spelling keeps its shape (ISO stays ISO).
    if (/^\d{4}-\d{2}-\d{2}$/.test(original)) expect(stored).toBe("2024-03-09");
  });

  it("keeps MDX imports out of the body and drops unused ones", async () => {
    const view = await call<{ tree: TreeNode[] }>("repo.view");
    const file = allFiles(view.tree).find((candidate) => candidate.name === "mdx-demo.mdx")!;
    const document = await call<{ body: { text: string } }>("doc.open", { key: file.key });
    expect(document.body.text).not.toMatch(/^import /m);
    await call("doc.setBody", { text: "Just prose now." });
    const raw = await call<string>("backend.invoke", {
      command: "read_text_file",
      args: { path: await settledPath() },
    });
    expect(raw).toContain("Just prose now.");
    expect(raw).not.toMatch(/^import Callout/m);
  });

  it("creates a new entry in a collection and opens it", async () => {
    const view = await call<{ tree: TreeNode[]; root: string }>("repo.view");
    const blog = view.tree.find((node) => node.label === "Writing")!;
    const created = await call<{ path: string; form: { values: Record<string, unknown> } }>(
      "repo.createFile",
      { groupPath: blog.path, dataCollection: null },
    );
    expect(created.path.startsWith(blog.path)).toBe(true);
    expect(created.form.values.title).toBe("Untitled");
  });

  it("lists changes for the publish sheet and publishes", async () => {
    const publish = await call<{ changes: unknown[] | null; changesError: string | null }>(
      "git.loadChanges",
    );
    expect(publish.changesError).toBeNull();
    const result = await call<{ published: boolean }>("git.publish", { message: "Site updates" });
    expect(result.published).toBe(true);
  });

  it("lists branches and switches", async () => {
    const branches = await call<Array<{ name: string }>>("branch.load");
    expect(branches.map((branch) => branch.name)).toContain("drafts");
    const result = await call<{ error: string | null; view: { branch: string } }>("branch.switch", {
      name: "drafts",
    });
    expect(result.error).toBeNull();
    expect(result.view.branch).toBe("drafts");
  });
});

describe("media", () => {
  it("lists library, public, and source tabs", async () => {
    const tabs = await call<Array<{ id: string; kind: string }>>("media.tabs");
    expect(tabs.map((tab) => tab.kind)).toContain("public");
    const publicListing = await call<{ folders: Array<{ name: string }>; items: unknown[] }>(
      "media.list",
      { tab: "__posto_public__", directory: "" },
    );
    expect(publicListing.folders.map((folder) => folder.name)).toContain("images");
    const library = tabs.find((tab) => tab.kind === "library");
    if (library) {
      const listing = await call<{ folders: unknown[]; items: unknown[] }>("media.list", {
        tab: library.id,
        directory: "",
      });
      expect(listing.folders.length + listing.items.length).toBeGreaterThan(0);
    }
  });
});

describe("deployments", () => {
  it("computes the deployment ring from workflow runs", async () => {
    const status = await call<{ ring: { state: string }; siteUrl: string | null }>("deploy.status");
    expect(["running", "queued", "success", "failure", "idle"]).toContain(status.ring.state);
  });
});

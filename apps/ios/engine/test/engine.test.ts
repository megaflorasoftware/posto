// End-to-end engine flows against the in-memory demo backend: the same
// methods Swift calls, with the same JSON envelopes.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { scanBodyEmbeds } from "../src/bodyEmbeds";

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

  it("edits an existing component's props in place", async () => {
    const view = await call<{ tree: TreeNode[] }>("repo.view");
    const file = allFiles(view.tree).find((candidate) => candidate.name === "with-slug.mdx");
    const key = file?.key ?? allFiles(view.tree).find((c) => c.name.endsWith(".mdx"))!.key;
    await call("doc.open", { key });
    const text = 'Intro\n\n<Callout tone="info" extra={x}>\nBody\n</Callout>\n';
    const form = await call<{ name: string; values: Record<string, unknown> }>(
      "components.openAt",
      {
        text,
        offset: text.indexOf("tone"),
      },
    );
    expect(form.name).toBe("Callout");
    const done = await call<{ snippet: string; range: [number, number] }>("components.finish");
    expect(done.range[0]).toBe(text.indexOf("<Callout"));
    expect(done.snippet).toContain("extra={x}");
    expect(done.snippet).toContain("Body");
  });

  it("edits an inline component and a block component's children", async () => {
    const view = await call<{ tree: TreeNode[] }>("repo.view");
    // An earlier test renames it from its title.
    const file = allFiles(view.tree).find((candidate) =>
      /^mdx[ -]demo\.mdx$/i.test(candidate.name),
    )!;
    await call("doc.open", { key: file.key });
    type Form = { slotTexts: Array<{ name: string | null; text: string }> };
    type Done = { snippet: string; range: [number, number] };
    const text =
      'A <Callout kind="tip" /> chip.\n\n<Callout kind="warning">\n  Old text\n</Callout>\n';

    const inlineStart = text.indexOf("<Callout");
    const inline = await call<Form>("components.openAt", {
      text,
      offset: inlineStart,
      start: inlineStart,
    });
    expect(inline.slotTexts).toEqual([{ name: null, text: "" }]);
    const inlineDone = await call<Done>("components.finish", {
      slots: [{ name: null, text: "Hi" }],
    });
    expect(inlineDone.snippet).toBe('<Callout kind="tip">Hi</Callout>');
    expect(inlineDone.range).toEqual([inlineStart, inlineStart + '<Callout kind="tip" />'.length]);

    const blockStart = text.lastIndexOf("<Callout");
    const block = await call<Form>("components.openAt", {
      text,
      offset: blockStart,
      start: blockStart,
    });
    expect(block.slotTexts).toEqual([{ name: null, text: "Old text" }]);
    const unchanged = await call<Done>("components.finish", { slots: block.slotTexts });
    expect(unchanged.snippet).toBe('<Callout kind="warning">\n  Old text\n</Callout>');
    await call("components.openAt", { text, offset: blockStart, start: blockStart });
    const edited = await call<Done>("components.finish", {
      slots: [{ name: null, text: "New text" }],
    });
    expect(edited.snippet).toBe('<Callout kind="warning">\nNew text\n</Callout>');
  });

  it("lists the body's cards and pills with image previews", async () => {
    const view = await call<{ tree: TreeNode[] }>("repo.view");
    const file = allFiles(view.tree).find((candidate) =>
      /^mdx[ -]demo\.mdx$/i.test(candidate.name),
    )!;
    await call("doc.open", { key: file.key });
    const embeds = await call<
      Array<{ kind: string; label: string; image?: { path: string | null; url: string | null } }>
    >("body.embeds", {
      text: 'A <Callout kind="tip" /> pill.\n\n![A photo](/images/photo.jpg)\n\n![Remote](https://example.com/a.png)\n',
    });
    expect(embeds.map((embed) => [embed.kind, embed.label])).toEqual([
      ["component", "Callout"],
      ["image", "A photo"],
      ["image", "Remote"],
    ]);
    expect(embeds[1].image?.path).toMatch(/\/images\/photo\.jpg$/);
    expect(embeds[2].image).toEqual({ path: null, url: "https://example.com/a.png" });

    // Previews never resolve outside the site.
    const outside = await call<Array<{ image?: { path: string | null } }>>("body.embeds", {
      text: "![a](../../../../../../etc/x.png)\n\n![b](/../../../etc/y.png)\n\n![c](/%2e%2e/%2e%2e/z.png)\n",
    });
    expect(outside.map((embed) => embed.image?.path)).toEqual([null, null, null]);
  });

  it("keeps a component's source as written when saved unchanged", async () => {
    const view = await call<{ tree: TreeNode[] }>("repo.view");
    const file = allFiles(view.tree).find((candidate) =>
      /^mdx[ -]demo\.mdx$/i.test(candidate.name),
    )!;
    await call("doc.open", { key: file.key });
    const text = "Intro\n\n<Callout   kind='tip' extra={x}/>\n";
    const start = text.indexOf("<Callout");
    const form = await call<{ slotTexts: unknown }>("components.openAt", { text, offset: start, start });
    const done = await call<{ snippet: string }>("components.finish", { slots: form.slotTexts });
    expect(done.snippet).toBe("<Callout   kind='tip' extra={x}/>");
  });

  it("opens files one at a time and drops edits meant for a closed file", async () => {
    const view = await call<{ tree: TreeNode[] }>("repo.view");
    const [first, second] = allFiles(view.tree).filter((file) => /\.mdx?$/.test(file.name));
    // Overlapping opens (arrowing through the sidebar): the last one wins.
    const [, firstView, last] = await Promise.all([
      call<{ key: string; session: number }>("doc.open", { key: second.key }),
      call<{ key: string; session: number }>("doc.open", { key: first.key }),
      call<{ key: string; session: number }>("doc.open", { key: second.key }),
    ]);
    expect(last.key).toBe(second.key);
    expect((await call<{ key: string }>("doc.view")).key).toBe(second.key);
    await expect(
      call("doc.setBody", { session: firstView.session, text: "Typed into the other file" }),
    ).rejects.toThrow(/no longer open/);
    // The open one's session is accepted (it survives template renames).
    await call("doc.setBody", { session: last.session, text: (await call<{ body: { text: string } }>("doc.view")).body.text });
  });

  it("picks images for a component's props from the document's media", async () => {
    const view = await call<{ tree: TreeNode[] }>("repo.view");
    const file = allFiles(view.tree).find((candidate) =>
      /^mdx[ -]demo\.mdx$/i.test(candidate.name),
    )!;
    await call("doc.open", { key: file.key });
    // Inserting one (an earlier test dropped the document's unused imports).
    const form = await call<{ fields: Array<{ name: string; chooseImage: boolean }> }>(
      "components.open",
      { name: "CaptionedImage", path: "/mock/site/src/components/CaptionedImage.astro" },
    );
    expect(form.fields.find((field) => field.name === "src")?.chooseImage).toBe(true);
    const choices = await call<{ media: { input: string } | null; files: Array<{ value: string }> }>(
      "form.imageChoices",
      { form: "component", path: ["src"] },
    );
    // The entry's media, as the desktop editor resolves a component's fields.
    expect(choices.media).not.toBeNull();
    expect(Array.isArray(choices.files)).toBe(true);
    const preview = await call<{ path: string | null }>("form.imagePreview", {
      form: "component",
      path: ["src"],
      value: "/images/photo.jpg",
    });
    expect(preview.path).toMatch(/public\/images\/photo\.jpg$/);
  });

  it("gives a component's image-library props the library picker", async () => {
    const view = await call<{ tree: TreeNode[] }>("repo.view");
    const file = allFiles(view.tree).find((candidate) =>
      /^mdx[ -]demo\.mdx$/i.test(candidate.name),
    )!;
    await call("doc.open", { key: file.key });
    await call("backend.invoke", {
      command: "write_text_file",
      args: {
        path: "/mock/site/src/components/Pictured.astro",
        content: [
          "---",
          "import type { CollectionEntry } from 'astro:content';",
          "export interface Props {",
          "  media: CollectionEntry<'media'>['id'];",
          "  caption?: string;",
          "}",
          "---",
          "<figure />",
        ].join("\n"),
      },
    });
    const form = await call<{
      fields: Array<{ name: string; type: string; imageLibrary: string | null }>;
    }>("components.open", { name: "Pictured", path: "/mock/site/src/components/Pictured.astro" });
    expect(form.fields.find((field) => field.name === "media")).toMatchObject({
      type: "reference",
      imageLibrary: "media",
    });
    // An image field's value for a file picked in the media picker.
    const value = await call<string | null>("form.imageValue", {
      form: "component",
      path: ["media"],
      absolutePath: "/mock/site/public/images/photo.jpg",
    });
    expect(value).toBe("/images/photo.jpg");
  });

  it("edits props the form can't represent as source text, as desktop raw rows", async () => {
    const view = await call<{ tree: TreeNode[] }>("repo.view");
    const file = allFiles(view.tree).find((candidate) =>
      /^mdx[ -]demo\.mdx$/i.test(candidate.name),
    )!;
    await call("doc.open", { key: file.key });
    // A src whose type has no control (the site's ResponsiveVideo src).
    await call("backend.invoke", {
      command: "write_text_file",
      args: {
        path: "/mock/site/src/components/Video.astro",
        content: "---\nexport type VideoPath = `/src/media/videos/${string}.mp4`;\n---\n<video />",
      },
    });
    await call("backend.invoke", {
      command: "write_text_file",
      args: {
        path: "/mock/site/src/components/Timeline.astro",
        content: [
          "---",
          "interface VideoPath { url: string; poster: Poster }",
          "export type Props = {",
          "  name: string;",
          "  roles: { title: string }[];",
          "  src?: VideoPath;",
          "};",
          "---",
          "<li />",
        ].join("\n"),
      },
    });
    // Inserting it once adds the import the props schema is found through.
    await call("components.open", { name: "Timeline", path: "/mock/site/src/components/Timeline.astro" });
    await call("form.edit", { form: "component", path: ["name"], value: "Job" });
    await call("form.edit", { form: "component", path: ["roles"], value: [{ title: "Lead" }] });
    await call("components.finish");
    const text = '<Timeline name="Job" roles={roles} extra="x" />\n';
    type Field = { name: string; chooseImage: boolean; description: string | null };
    const form = await call<{ fields: Field[]; values: Record<string, unknown> }>(
      "components.openAt",
      { text, offset: 1, start: 0 },
    );
    // `roles={roles}` and the undeclared `extra` are raw rows with their source.
    expect(form.values.roles).toBe("roles");
    expect(form.values.extra).toBe("x");
    expect(form.fields.map((field) => field.name)).toEqual(["name", "roles", "src", "extra"]);
    // A raw-typed prop named src gets no image picker (desktop: a raw row).
    expect(form.fields.find((field) => field.name === "src")?.chooseImage).toBe(false);
    await call("form.edit", { form: "component", path: ["roles"], value: '[{ title: "Lead" }]' });
    const done = await call<{ snippet: string }>("components.finish");
    expect(done.snippet).toBe('<Timeline name="Job" roles={[{ title: "Lead" }]} extra="x" />');
  });

  it("writes image field values the site can serve", async () => {
    const view = await call<{ tree: TreeNode[] }>("repo.view");
    const file = allFiles(view.tree).find((candidate) => candidate.key.includes("/src/blog/"))!;
    await call("doc.open", { key: file.key });
    // Public files: their site path, unencoded.
    expect(
      await call("form.imageValue", { path: ["cover"], absolutePath: "/mock/site/public/images/my photo.jpg" }),
    ).toBe("/images/my photo.jpg");
  });

  it("edits only components outside code from the cursor", async () => {
    const text = 'Sample:\n\n```mdx\n<Callout kind="tip" />\n```\n';
    await expect(
      call("components.openAt", { text, offset: text.indexOf("kind") }),
    ).rejects.toThrow(/cursor inside a component/);
  });

  it("applies a controlled field template saved in developer mode", async () => {
    const view = await call<{ tree: TreeNode[] }>("repo.view");
    const file = allFiles(view.tree).find((candidate) => candidate.label === "Y")!;
    await call("doc.open", { key: file.key });
    const result = await call<{
      error: string | null;
      view: {
        form: {
          values: Record<string, unknown>;
          fields: Array<{ name: string; template: unknown }>;
        };
      };
    }>("collections.saveFieldTemplate", {
      fieldName: "slug",
      schema: { template: "{fields.title|slug}-post", editBehavior: "controlled" },
    });
    expect(result.error).toBeNull();
    expect(result.view.form.values.slug).toBe("y-post");
    expect(result.view.form.fields.find((field) => field.name === "slug")?.template).toMatchObject({
      controlled: true,
    });
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

  it("creates a referenced entry from a reference field", async () => {
    const view = await call<{ tree: TreeNode[] }>("repo.view");
    const file = allFiles(view.tree).find((candidate) => candidate.label === "Y")!;
    await call("doc.open", { key: file.key });
    const draft = await call<{ collection: { name: string }; values: Record<string, unknown> }>(
      "reference.start",
      { path: ["related"] },
    );
    expect(draft.collection.name).toBe("blog");
    await call("form.edit", { form: "reference", path: ["title"], value: "Fresh related post" });
    const document = await call<{ form: { values: Record<string, unknown> } }>("reference.finish");
    expect(String(document.form.values.related)).toContain("Fresh related post");
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

describe("repository home", () => {
  type Status = { id: number; message: string; severity: string } | null;
  type HomeView = {
    tree: TreeNode[];
    documentKey: string | null;
    status: Status;
    workspaceCandidates: Array<{ dir: string }> | null;
    canCancelWorkspaceChooser: boolean;
  };

  async function writeFile(path: string, content: string) {
    await call("backend.invoke", { command: "write_text_file", args: { path, content } });
  }

  it("lists the projects for Settings without leaving the open one", async () => {
    const candidates = await call<Array<{ dir: string; label: string; type: string }>>(
      "repo.listWorkspaceCandidates",
    );
    expect(candidates).toEqual([{ dir: "/mock/site", label: "Repository root", type: "astro" }]);
    const view = await call<HomeView>("repo.view");
    expect(view.workspaceCandidates).toBeNull();
    expect(view.canCancelWorkspaceChooser).toBe(false);

    // The chooser shown over an open project can go back to it.
    const choosing = await call<HomeView>("repo.showWorkspaceChooser");
    expect(choosing.workspaceCandidates).toHaveLength(1);
    expect(choosing.canCancelWorkspaceChooser).toBe(true);
    const back = await call<HomeView>("repo.cancelWorkspaceChooser");
    expect(back.workspaceCandidates).toBeNull();
  });

  it("deletes a file from the list and keeps the open one", async () => {
    await writeFile("/mock/site/src/blog/doomed.md", "---\ntitle: Doomed\n---\n\nBye.\n");
    const view = await call<HomeView>("repo.refresh");
    const doomed = allFiles(view.tree).find((file) => file.name === "doomed.md")!;
    const kept = allFiles(view.tree).find((file) => file.label === "Y")!;
    await call("doc.open", { key: kept.key });

    const after = await call<HomeView>("repo.deleteFile", { key: doomed.key });
    expect(allFiles(after.tree).map((file) => file.name)).not.toContain("doomed.md");
    expect(after.documentKey).toBe(kept.key);
    expect((await call<{ key: string }>("doc.view")).key).toBe(kept.key);
    await expect(call("repo.deleteFile", { key: doomed.key })).rejects.toThrow(/no longer exists/);
  });

  it("deletes the open file, closing it without its pending save", async () => {
    await writeFile("/mock/site/src/blog/open-doomed.md", "---\ntitle: Open doomed\n---\n\nBye.\n");
    const view = await call<HomeView>("repo.refresh");
    const doomed = allFiles(view.tree).find((file) => file.name === "open-doomed.md")!;
    const opened = await call<{ session: number }>("doc.open", { key: doomed.key });
    // A pending autosave must not write the file back after the delete.
    await call("doc.setBody", { session: opened.session, text: "Typed just before deleting." });

    const after = await call<HomeView>("repo.deleteFile", { key: doomed.key });
    expect(after.documentKey).toBeNull();
    await expect(call("doc.view")).rejects.toThrow(/No file is open/);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const refreshed = await call<HomeView>("repo.refresh");
    expect(allFiles(refreshed.tree).map((file) => file.name)).not.toContain("open-doomed.md");
  });

  it("deletes data-document entries, reloading an open sibling", async () => {
    const configPath = "/mock/site/src/content.config.ts";
    const schemaPath = "/mock/site/.astro/collections/team.schema.json";
    const dataPath = "/mock/site/src/data/team.json";
    const originalConfig = await call<string>("backend.invoke", {
      command: "read_text_file",
      args: { path: configPath },
    });
    const readData = async () =>
      JSON.parse(
        await call<string>("backend.invoke", { command: "read_text_file", args: { path: dataPath } }),
      ) as Record<string, { name: string }>;
    try {
      await writeFile(
        configPath,
        originalConfig.replace(
          "export const collections = { posts, media };",
          [
            "const team = defineCollection({",
            '  loader: file("src/data/team.json"),',
            "  schema: z.object({ name: z.string() }),",
            "});",
            "",
            "export const collections = { posts, media, team };",
          ].join("\n"),
        ),
      );
      await writeFile(
        schemaPath,
        JSON.stringify({
          $ref: "#/definitions/team",
          definitions: {
            team: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
        }),
      );
      await writeFile(dataPath, JSON.stringify({ ada: { name: "Ada" }, bob: { name: "Bob" } }));
      const view = await call<HomeView>("repo.refresh");
      const team = view.tree.find((node) => node.label === "Team")!;
      expect(team.files.map((file) => file.name)).toEqual(["ada", "bob"]);
      const [ada, bob] = team.files;

      // Ada is open with an edit not yet saved; deleting Bob (same file)
      // keeps that edit and Ada stays open.
      await call("doc.open", { key: ada.key });
      await call("form.edit", { path: ["name"], value: "Ada L." });
      const afterBob = await call<HomeView>("repo.deleteFile", { key: bob.key });
      expect(afterBob.documentKey).toBe(ada.key);
      expect(afterBob.tree.find((node) => node.label === "Team")!.files.map((f) => f.name)).toEqual(
        ["ada"],
      );
      expect(await readData()).toEqual({ ada: { name: "Ada L." } });
      expect((await call<{ form: { values: { name: string } } }>("doc.view")).form.values.name).toBe(
        "Ada L.",
      );

      const afterAda = await call<HomeView>("repo.deleteFile", { key: ada.key });
      expect(afterAda.documentKey).toBeNull();
      expect(await readData()).toEqual({});
    } finally {
      await writeFile(configPath, originalConfig);
      await call("backend.invoke", { command: "delete_file", args: { path: schemaPath } });
      await call("backend.invoke", { command: "delete_file", args: { path: dataPath } });
      await call("repo.refresh");
    }
  });

  it("keeps error notices until they're dismissed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await call("repo.setStatus", { message: "Saved", severity: "success" });
      vi.advanceTimersByTime(6_000);
      expect((await call<HomeView>("repo.view")).status).toBeNull();

      await call("repo.setStatus", { message: "Something broke", severity: "error" });
      vi.advanceTimersByTime(60_000);
      const status = (await call<HomeView>("repo.view")).status!;
      expect(status).toMatchObject({ message: "Something broke", severity: "error" });
      // Dismissing an older notice leaves a newer one.
      expect((await call<HomeView>("repo.dismissStatus", { id: status.id - 1 })).status).toEqual(
        status,
      );
      expect((await call<HomeView>("repo.dismissStatus", { id: status.id })).status).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a failed branch switch as an error notice", async () => {
    const result = await call<{ error: string | null; view: HomeView }>("branch.switch", {
      name: "no-such-branch",
    });
    expect(result.error).toMatch(/Could not switch branch/);
    expect(result.view.status).toMatchObject({ message: result.error, severity: "error" });
    await call("repo.dismissStatus", { id: result.view.status!.id });
  });
});

describe("body embeds", () => {
  const text = [
    "# Title",
    "",
    'Inline <Callout kind="tip" /> and <kbd>K</kbd> here.',
    "",
    '<CaptionedImage src="/a.jpg" width={640}>',
    "  A caption with *emphasis*.",
    "</CaptionedImage>",
    "",
    "export const updated = '2026';",
    "",
    "![A photo](/images/photo.jpg)",
    "",
    "Text with ![inline](x.png) image and `<Code />` in a span.",
    "",
    "```",
    "<NotAComponent />",
    "```",
    "",
    "<div>",
    "block html",
    "</div>",
    "",
    "{1 + 1}",
  ].join("\n");

  it("finds the elements the desktop editor renders as nodes", () => {
    const embeds = scanBodyEmbeds(text, true);
    expect(embeds.map((embed) => [embed.kind, embed.block, embed.label])).toEqual([
      ["component", false, "Callout"],
      ["html", false, "kbd"],
      ["component", true, "CaptionedImage"],
      ["raw", true, "Export"],
      ["image", true, "A photo"],
      ["image", false, "inline"],
      ["html", true, "div"],
      ["raw", true, "Expression"],
    ]);
    const card = embeds[2];
    expect(text.slice(card.start, card.end)).toMatch(/^<CaptionedImage[\s\S]*<\/CaptionedImage>$/);
    expect(card.detail).toBe("src: /a.jpg · width: {640}");
    expect(card.preview).toBe("A caption with emphasis.");
    expect(text.slice(embeds[4].start, embeds[4].end)).toBe("![A photo](/images/photo.jpg)");
    expect(embeds[4].src).toBe("/images/photo.jpg");
  });

  it("treats capitalized tags as HTML outside MDX", () => {
    const embeds = scanBodyEmbeds("A <Kbd>x</Kbd> chip and an\nimport line.", false);
    expect(embeds.map((embed) => [embed.kind, embed.label])).toEqual([["html", "Kbd"]]);
  });

  it("skips code in quotes, list items, comments and multi-line code spans", () => {
    const body = [
      "> ```html",
      "> <div>hi</div>",
      "> ```",
      "",
      "- ```jsx",
      '  <Callout kind="tip" />',
      "  ```",
      "",
      "<!-- <div>old</div> -->",
      "",
      "Use `<Callout",
      'kind="tip" />` like so, then <kbd>K</kbd>.',
    ].join("\n");
    const embeds = scanBodyEmbeds(body, true);
    expect(embeds.map((embed) => [embed.kind, embed.label])).toEqual([["html", "kbd"]]);
  });

  it("reads images as the desktop does", () => {
    const body = "Some text\n![alt](a.png)\nMore\n\n![a\\]b](foo(1).png)";
    const embeds = scanBodyEmbeds(body, false);
    expect(embeds.map((embed) => [embed.block, embed.alt, embed.src])).toEqual([
      [true, "alt", "a.png"],
      [true, "a]b", "foo(1).png"],
    ]);
    expect(body.slice(embeds[1].start, embeds[1].end)).toBe("![a\\]b](foo(1).png)");
  });

  it("never splits a surrogate pair in a clipped preview", () => {
    const body = `<Callout kind="tip">\n${"a".repeat(198)}😀 more\n</Callout>`;
    const [embed] = scanBodyEmbeds(body, true);
    expect(embed.preview).toMatch(/…$/);
    expect(embed.preview).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("scans unclosed elements in linear time", () => {
    const body = Array.from({ length: 3000 }, (_, n) => `<p>Paragraph ${n} with words`).join("\n\n");
    const started = performance.now();
    expect(scanBodyEmbeds(body, false)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(300);
  });

  it("counts offsets in UTF-16 units", () => {
    const body = "Emoji 🎉 then <Callout />";
    const [embed] = scanBodyEmbeds(body, true);
    expect(body.slice(embed.start, embed.end)).toBe("<Callout />");
    expect(embed.start).toBe(14);
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

  it("opens the picker at a folder and gives library items their entry ids", async () => {
    expect(await call("media.locate", { folder: "/mock/site/public/images/nested" })).toEqual({
      tab: "__posto_public__",
      directory: "images/nested",
    });
    const library = await call<{ tab: string; directory: string } | null>("media.locate", {
      folder: "/mock/site/media/portraits",
    });
    expect(library).toEqual({ tab: "media", directory: "portraits" });
    const listing = await call<{ items: Array<{ entryId?: string }> }>("media.list", {
      tab: "media",
      directory: "portraits",
    });
    expect(listing.items.map((item) => item.entryId)).toContain("portraits/person");
  });
});

describe("deployments", () => {
  it("computes the deployment ring from workflow runs", async () => {
    const status = await call<{ ring: { state: string }; siteUrl: string | null }>("deploy.status");
    expect(["running", "queued", "success", "failure", "idle"]).toContain(status.ring.state);
  });
});

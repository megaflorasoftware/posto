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

  it("inserts body media with the paths and markup the desktop body editor writes", async () => {
    const view = await call<{ tree: TreeNode[] }>("repo.view");
    const file = allFiles(view.tree).find((candidate) => candidate.key.includes("/src/blog/"))!;
    await call("doc.open", { key: file.key });
    type Snippet = { snippet: string; kind: string };
    const snippet = (args: Record<string, unknown>) => call<Snippet>("doc.bodyMediaSnippet", args);

    // `public/` files are site paths, encoded as the desktop encodes them.
    expect(
      await snippet({ absolutePath: "/mock/site/public/images/photo.jpg", alt: "A photo" }),
    ).toEqual({ snippet: "![A photo](/images/photo.jpg)", kind: "image" });
    expect(
      (await snippet({ absolutePath: "/mock/site/public/images/my photo (1).jpg", alt: "x" }))
        .snippet,
    ).toBe("![x](/images/my%20photo%20%281%29.jpg)");
    // Everything else, image libraries included, is relative to the document
    // (it used to fail unless inside the entry's media folder).
    expect(
      await snippet({ absolutePath: "/mock/site/media/portraits/person.jpg", alt: "Portrait" }),
    ).toEqual({ snippet: "![Portrait](../../media/portraits/person.jpg)", kind: "image" });
    expect(
      await call("doc.bodyMediaValue", { absolutePath: "/mock/site/media/portraits/person.jpg" }),
    ).toBe("../../media/portraits/person.jpg");
    // Alt text stays one label; a path with spaces stays one destination.
    const spaced = await snippet({
      absolutePath: "/mock/site/src/assets/my photo.jpg",
      alt: "A [bracketed]\nalt \\ text",
    });
    expect(spaced.snippet).toBe("![A \\[bracketed\\] alt \\\\ text](<../assets/my photo.jpg>)");
    const [embed] = await call<Array<{ kind: string; src: string; alt: string }>>("body.embeds", {
      text: spaced.snippet,
    });
    expect(embed).toMatchObject({
      kind: "image",
      src: "../assets/my photo.jpg",
      alt: "A [bracketed] alt \\ text",
    });
    // Without alt text: a library image's own (as desktop), else the file's
    // name without its extension.
    expect(
      (await snippet({ absolutePath: "/mock/site/media/portraits/person.jpg", label: "person.jpg" }))
        .snippet,
    ).toBe("![Portrait](../../media/portraits/person.jpg)");
    expect(
      (await snippet({ absolutePath: "/mock/site/public/images/photo.jpg", label: "photo.jpg" }))
        .snippet,
    ).toBe("![photo](/images/photo.jpg)");

    // Audio and video as escaped HTML, other files as links.
    expect(await snippet({ absolutePath: "/mock/site/public/media/theme.mp3" })).toEqual({
      snippet: '<audio controls src="/media/theme.mp3"></audio>',
      kind: "audio",
    });
    expect(
      await snippet({ url: 'https://cdn.example.com/clip.mp4?a=1&b="2"', kind: "video" }),
    ).toEqual({
      snippet: '<video controls src="https://cdn.example.com/clip.mp4?a=1&amp;b=&quot;2&quot;"></video>',
      kind: "video",
    });
    expect(
      await snippet({
        absolutePath: "/mock/site/public/downloads/guide.pdf",
        label: "guide.pdf",
        alt: "ignored for links",
      }),
    ).toEqual({ snippet: "[guide.pdf](/downloads/guide.pdf)", kind: "link" });
    // CDN images keep their URL.
    expect(
      (await snippet({ url: "https://cdn.example.com/a.png", kind: "image", alt: "A" })).snippet,
    ).toBe("![A](https://cdn.example.com/a.png)");
  });

  it("finds the image-library entry a body image shows", async () => {
    const view = await call<{ tree: TreeNode[] }>("repo.view");
    const file = allFiles(view.tree).find((candidate) => candidate.key.includes("/src/blog/"))!;
    await call("doc.open", { key: file.key });
    type Found = { library: string; asset: { id: string; entryId: string; imagePath: string } };
    const lookup = (src: string) => call<Found | null>("body.imageAsset", { src });

    // As desktop: a site path under the library's folder.
    const served = await lookup("/media/portraits/person.jpg");
    expect(served).toMatchObject({
      library: "media",
      asset: {
        id: "/mock/site/media/portraits/person.yaml",
        entryId: "portraits/person",
        imagePath: "/mock/site/media/portraits/person.jpg",
      },
    });
    // Relative to the document, as images are inserted.
    expect(await lookup("../../media/portraits/person.jpg")).toEqual(served);
    // Not a library image, or not an entry.
    expect(await lookup("/images/photo.jpg")).toBeNull();
    expect(await lookup("/media/portraits/nobody.jpg")).toBeNull();
    expect(await lookup("https://example.com/a.png")).toBeNull();
    // The asset editor opens it from there.
    const asset = await call<{ entryId: string }>("media.openAsset", {
      tab: served!.library,
      id: served!.asset.id,
    });
    expect(asset.entryId).toBe("portraits/person");
    await call("media.closeAsset");
  });

  it("inserts a component inline when the cursor is inside text", async () => {
    const view = await call<{ tree: TreeNode[] }>("repo.view");
    const file = allFiles(view.tree).find((candidate) =>
      /^mdx[ -]demo\.mdx$/i.test(candidate.name),
    )!;
    await call("doc.open", { key: file.key });
    const path = "/mock/site/src/components/Badge.astro";
    await call("backend.invoke", {
      command: "write_text_file",
      args: {
        path,
        content: "---\nexport interface Props {\n  tone?: string;\n}\n---\n<span><slot /></span>\n",
      },
    });
    type Done = { snippet: string; range: null };
    await call("components.open", { name: "Badge", path });
    expect(await call<Done>("components.finish", { inline: true })).toEqual({
      snippet: "<Badge />",
      range: null,
    });
    await call("components.open", { name: "Badge", path });
    await call("form.edit", { form: "component", path: ["tone"], value: "new" });
    const withChildren = await call<Done>("components.finish", {
      inline: true,
      slots: [{ name: null, text: "Hot" }],
    });
    expect(withChildren.snippet).toBe('<Badge tone="new">Hot</Badge>');
    // A block insert leaves room for its children, as before.
    await call("components.open", { name: "Badge", path });
    expect((await call<Done>("components.finish")).snippet).toBe("<Badge>\n</Badge>");
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

// Rewrites the fixture's config, so it runs last: an `authors` collection
// whose photos live in a media folder templated by the entry's slug, a blog
// reference to it, and an Astro `file()` data collection.
describe("form fields", () => {
  const write = (path: string, content: string) =>
    call("backend.invoke", { command: "write_text_file", args: { path, content } });
  const read = (path: string) =>
    call<string>("backend.invoke", { command: "read_text_file", args: { path } });

  beforeAll(async () => {
    const pages = await read("/mock/site/.pages.yml");
    await write(
      "/mock/site/.pages.yml",
      pages
        .replace(
          "media: public/images",
          [
            "media:",
            "  - { name: images, input: public/images, output: /images }",
            "  - { name: people, input: 'public/people/{fields.slug}', output: '/people/{fields.slug}' }",
          ].join("\n"),
        )
        .replace(
          "      - { name: body, label: Body, type: rich-text }",
          [
            "      - { name: author, label: Author, type: reference, options: { collection: authors } }",
            "      - { name: body, label: Body, type: rich-text }",
          ].join("\n"),
        ) +
        [
          "  - name: authors",
          "    label: Authors",
          "    type: collection",
          "    path: src/authors",
          "    fields:",
          "      - { name: name, label: Name, type: string, required: true }",
          "      - { name: slug, label: Slug, type: string }",
          "      - { name: photo, label: Photo, type: image, options: { media: people } }",
          "      - { name: mentor, label: Mentor, type: reference, options: { collection: blog } }",
          "",
        ].join("\n"),
    );
    const astro = await read("/mock/site/src/content.config.ts");
    await write(
      "/mock/site/src/content.config.ts",
      astro
        .replace(
          'import { glob } from "astro/loaders";',
          'import { file, glob } from "astro/loaders";',
        )
        .replace(
          "export const collections = { posts, media };",
          [
            "const team = defineCollection({",
            '  loader: file("src/data/team.json"),',
            "  schema: z.object({ name: z.string(), role: z.string() }),",
            "});",
            "",
            "export const collections = { posts, media, team };",
          ].join("\n"),
        ),
    );
    await write(
      "/mock/site/.astro/collections/team.schema.json",
      JSON.stringify({
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" }, role: { type: "string" } },
        required: ["id", "name", "role"],
      }),
    );
    await write(
      "/mock/site/src/data/team.json",
      JSON.stringify([{ id: "ada", name: "Ada", role: "Engineer" }], null, 2),
    );
    // An enum as long as an icon set's names (the Lucide one has ~2,400).
    const posts = JSON.parse(await read("/mock/site/.astro/collections/posts.schema.json")) as {
      definitions: { posts: { properties: Record<string, unknown> } };
    };
    posts.definitions.posts.properties.icon = {
      type: "string",
      enum: Array.from({ length: 3000 }, (_, n) => `icon-${n}`),
    };
    await write("/mock/site/.astro/collections/posts.schema.json", JSON.stringify(posts));
    await call("repo.open", { repoRoot: "/mock/site", repo: null, developerMode: true });
  });

  it("keeps a long select's options out of the form view", async () => {
    const view = await call<{ tree: TreeNode[] }>("repo.view");
    const posts = view.tree.find((node) => node.label === "Posts")!;
    type Field = { name: string; type: string; selectValues: unknown[]; selectCount: number };
    const opened = await call<{ form: { fields: Field[] } }>("doc.open", {
      key: posts.files[0].key,
    });
    const icon = opened.form.fields.find((field) => field.name === "icon")!;
    expect(icon).toMatchObject({ type: "select", selectValues: [], selectCount: 3000 });
    // Short lists still travel with the field.
    const status = opened.form.fields.find((field) => field.name === "status")!;
    expect(status.selectValues).toHaveLength(3);
    expect(status.selectCount).toBe(3);

    const options = await call<Array<{ value: string; label: string }>>("form.selectOptions", {
      path: ["icon"],
    });
    expect(options).toHaveLength(3000);
    expect(options[2999]).toEqual({ value: "icon-2999", label: "icon-2999" });

    // Every edit's reply stays small.
    const edited = await call<{ form: { values: Record<string, unknown> } }>("form.edit", {
      path: ["icon"],
      value: "icon-2999",
    });
    expect(edited.form.values.icon).toBe("icon-2999");
    expect(JSON.stringify(edited)).not.toContain("icon-2998");
  });

  async function openBlogPost() {
    const view = await call<{ tree: TreeNode[] }>("repo.view");
    const blog = view.tree.find((node) => node.label === "Writing")!;
    await call("doc.open", { key: blog.files[0].key });
  }

  it("resolves a new referenced entry's fields against its own collection", async () => {
    await openBlogPost();
    const draft = await call<{
      collection: { name: string };
      fields: Array<{ name: string; type: string; referenceCollection: string | null }>;
    }>("reference.start", { path: ["author"] });
    expect(draft.collection.name).toBe("authors");
    expect(draft.fields.find((field) => field.name === "photo")?.type).toBe("image");
    await call("form.edit", { form: "reference", path: ["slug"], value: "ada" });

    // The photo's media folder expands from the draft's slug, not the
    // open post's.
    const choices = await call<{ media: { input: string } | null }>("form.imageChoices", {
      form: "reference",
      path: ["photo"],
    });
    expect(choices.media?.input).toBe("public/people/ada");
    expect(
      await call("form.imageValue", {
        form: "reference",
        path: ["photo"],
        absolutePath: "/mock/site/public/people/ada/portrait.jpg",
      }),
    ).toBe("/people/ada/portrait.jpg");
    const preview = await call<{ path: string | null }>("form.imagePreview", {
      form: "reference",
      path: ["photo"],
      value: "/people/ada/portrait.jpg",
    });
    expect(preview.path).toBe("/mock/site/public/people/ada/portrait.jpg");

    // The draft's own references list their collection's entries.
    const options = await call<{
      collection: { name: string } | null;
      options: Array<{ value: string; label: string }>;
    }>("form.referenceOptions", { form: "reference", path: ["mentor"] });
    expect(options.collection?.name).toBe("blog");
    expect(options.options.length).toBeGreaterThan(0);
    expect(options.options.every((option) => option.value.startsWith("src/blog/"))).toBe(true);
    await call("reference.cancel");
  });

  it("saves field templates and row counts on data collection entries", async () => {
    const view = await call<{ tree: TreeNode[] }>("repo.view");
    const team = view.tree.find((node) => node.label === "Team")!;
    const opened = await call<{ isData: boolean }>("doc.open", { key: team.files[0].key });
    expect(opened.isData).toBe(true);
    type Saved = {
      error: string | null;
      view: {
        form: {
          values: Record<string, unknown>;
          fields: Array<{
            name: string;
            template: { controlled: boolean; rows: number | null } | null;
          }>;
        };
      };
    };
    const templated = await call<Saved>("collections.saveFieldTemplate", {
      fieldName: "role",
      schema: { template: "{fields.name|slug}-role", editBehavior: "controlled" },
    });
    expect(templated.error).toBeNull();
    expect(templated.view.form.values.role).toBe("ada-role");
    expect(
      templated.view.form.fields.find((field) => field.name === "role")?.template,
    ).toMatchObject({ controlled: true });
    // Later edits keep the new template applied.
    const edited = await call<{ form: { values: Record<string, unknown> } }>("form.edit", {
      path: ["name"],
      value: "Grace Hopper",
    });
    expect(edited.form.values.role).toBe("grace-hopper-role");
    await call("doc.flush");
    expect(await read("/mock/site/src/data/team.json")).toContain('"role": "grace-hopper-role"');

    const rows = await call<Saved>("collections.saveFieldTemplate", {
      fieldName: "name",
      schema: { editBehavior: "manual", rows: 4 },
    });
    expect(rows.view.form.fields.find((field) => field.name === "name")?.template?.rows).toBe(4);
    // Data entries have no filename of their own.
    await expect(
      call("collections.saveFieldTemplate", {
        fieldName: "filename",
        schema: { template: "{fields.name}.json", editBehavior: "controlled" },
      }),
    ).rejects.toThrow(/no filename template/);
  });

  it("reports a data file's own parse error", async () => {
    const view = await call<{ tree: TreeNode[] }>("repo.view");
    const team = view.tree.find((node) => node.label === "Team")!;
    await call("doc.open", { key: team.files[0].key });
    const original = await read("/mock/site/src/data/team.json");
    await call("doc.setTab", { tab: "raw" });
    await call("doc.setRaw", { text: "[{ broken" });
    const broken = await call<{ form: { parseError: string | null } }>("doc.setTab", {
      tab: "content",
    });
    // The JSON parser's message, not the frontmatter's YAML notice.
    expect(broken.form.parseError).toMatch(/JSON|property|token/i);
    await call("doc.setTab", { tab: "raw" });
    await call("doc.setRaw", { text: original });
    await call("doc.flush");
  });

  it("tells whether a component's props are typed", async () => {
    await openBlogPost();
    const typed = await call<{ typed: boolean }>("components.open", {
      name: "CaptionedImage",
      path: "/mock/site/src/components/CaptionedImage.astro",
    });
    expect(typed.typed).toBe(true);
    await write("/mock/site/src/components/Plain.astro", "<div><slot /></div>");
    const untyped = await call<{ typed: boolean }>("components.open", {
      name: "Plain",
      path: "/mock/site/src/components/Plain.astro",
    });
    expect(untyped.typed).toBe(false);
  });
});

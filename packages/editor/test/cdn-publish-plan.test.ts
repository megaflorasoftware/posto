import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CdnSource } from "@posto/core/media/sources";
import type { Field, MediaLibrary, PagesConfig } from "@posto/core/pagescms/config";
import type { FileGroup, MediaFileInspection } from "@posto/ipc";

const { deletes, files, images, invoke, inspectMediaFile } = vi.hoisted(() => {
  const deletes: Array<{ sourceName: string; key: string; url: string }> = [];
  const files = new Map<string, string>();
  const images = new Map<string, Partial<MediaFileInspection>>();
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    const path = args?.path as string;
    switch (command) {
      case "read_text_file":
        if (!files.has(path)) throw new Error(`Missing: ${path}`);
        return files.get(path);
      case "read_text_file_optional":
        return files.get(path) ?? null;
      case "path_exists":
        return files.has(path) || images.has(path);
      case "list_dir_files_optional": {
        const dir = args?.dir as string;
        const extensions = args?.extensions as string[];
        const listed = [...files.keys(), ...images.keys()]
          .filter((item) => item.startsWith(`${dir}/`))
          .filter(
            (item) =>
              extensions.length === 0 ||
              extensions.includes(item.split(".").pop()?.toLowerCase() ?? ""),
          )
          .map((item) => ({ name: item.split("/").pop(), path: item }));
        return listed.length > 0 ? listed : null;
      }
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });
  const inspectMediaFile = vi.fn(async (path: string) => {
    const image = images.get(path);
    if (!image) throw new Error("The file is missing");
    return {
      sha256: "a1b2c3d4".repeat(8),
      size: 2048,
      contentType: "image/jpeg",
      dimensions: { width: 1600, height: 900 },
      ...image,
    };
  });
  return { deletes, files, images, invoke, inspectMediaFile };
});

vi.mock("@posto/ipc", () => ({
  invoke,
  inspectMediaFile,
  pendingMediaDeletes: vi.fn(async () => deletes),
}));

import { countPendingCdnMedia, planCdnPublish } from "../src/cdnPublish/plan";

const root = "/site";
const source: CdnSource = {
  name: "cdn",
  provider: "bunny",
  bucket: "site-media",
  prefix: "images",
  publicUrl: "https://media.example.com",
};
const url = "https://media.example.com/images/trips/harbor-a1b2c3d4.jpg";
const library: MediaLibrary = {
  collection: "photos",
  base: "src/data/photos",
  patterns: ["**/*.yaml"],
  metadataExtensions: ["yaml"],
  imageFieldPath: ["src"],
  mediaSource: "cdn",
  fields: [
    { name: "src", type: "image", required: true },
    { name: "alt", type: "string" },
    { name: "width", type: "number" },
    { name: "height", type: "number" },
  ],
};
const posts = (fields: Field[] = []) => ({
  name: "posts",
  type: "collection" as const,
  path: "src/content/posts",
  fields,
});
const groupFor = (...paths: string[]): FileGroup[] => [
  {
    label: "Posts",
    path: "src/content/posts",
    files: paths.map((path) => ({ name: path.split("/").pop()!, path })),
  },
];
const config = (overrides: Partial<PagesConfig> = {}): PagesConfig => ({
  media: [{ name: "default", input: "public", output: "/" }],
  content: [posts()],
  mediaLibraries: [library],
  cdnSources: [source],
  ...overrides,
});

function addLibraryImage() {
  images.set(`${root}/src/data/photos/trips/harbor.jpg`, {});
  files.set(
    `${root}/src/data/photos/trips/harbor.yaml`,
    "# Taken at dawn\nsrc: ./harbor.jpg\nalt: Boats # shown on cards\n",
  );
}

beforeEach(() => {
  deletes.length = 0;
  files.clear();
  images.clear();
  invoke.mockClear();
  inspectMediaFile.mockClear();
});

describe("CDN-bound libraries", () => {
  test("plans the upload, metadata rewrite, dimensions, and local removal", async () => {
    addLibraryImage();

    const plan = await planCdnPublish({ root, config: config(), groups: [] });

    expect(plan.blockers).toEqual([]);
    expect(plan.uploads).toEqual([
      {
        sourceName: "cdn",
        path: `${root}/src/data/photos/trips/harbor.jpg`,
        key: "images/trips/harbor-a1b2c3d4.jpg",
        url,
        sha256: "a1b2c3d4".repeat(8),
        size: 2048,
        contentType: "image/jpeg",
      },
    ]);
    expect(plan.removals).toEqual([`${root}/src/data/photos/trips/harbor.jpg`]);
    const [write] = plan.writes;
    expect(write.path).toBe(`${root}/src/data/photos/trips/harbor.yaml`);
    expect(write.content).toContain("# Taken at dawn");
    expect(write.content).toContain("# shown on cards");
    expect(write.content).toContain(`src: "${url}"`);
    expect(write.content).toContain("width: 1600");
    expect(write.content).toContain("height: 900");
  });

  test("rewrites references in frontmatter and Markdown bodies", async () => {
    addLibraryImage();
    const post = `${root}/src/content/posts/hello.md`;
    files.set(
      post,
      [
        "---",
        "title: Hello",
        "hero: ../../data/photos/trips/harbor.jpg",
        "---",
        "![Relative](../../data/photos/trips/harbor.jpg)",
        "![Rooted](/src/data/photos/trips/harbor.jpg)",
        '<img src="../../data/photos/trips/harbor.jpg" />',
        "```md",
        "![Example](../../data/photos/trips/harbor.jpg)",
        "```",
        "",
      ].join("\n"),
    );
    const media = [
      { name: "src", input: "src", output: "src", relative: true },
      { name: "default", input: "public", output: "/" },
    ];

    const plan = await planCdnPublish({
      root,
      config: config({ media, content: [posts([{ name: "hero", type: "image" }])] }),
      groups: groupFor(post),
    });

    const content = plan.writes.find((write) => write.path === post)!.content;
    expect(content).toContain(`hero: "${url}"`);
    expect(content).toContain(`![Relative](${url})`);
    expect(content).toContain(`![Rooted](${url})`);
    expect(content).toContain(`<img src="${url}" />`);
    expect(content).toContain("![Example](../../data/photos/trips/harbor.jpg)");
  });

  test("leaves images that are already published alone", async () => {
    files.set(`${root}/src/data/photos/live.yaml`, `src: ${url}\nalt: Live\n`);

    const plan = await planCdnPublish({ root, config: config(), groups: [] });

    expect(plan.uploads).toEqual([]);
    expect(plan.writes).toEqual([]);
    expect(inspectMediaFile).not.toHaveBeenCalled();
  });

  test("ignores libraries that aren't bound to a defined source", async () => {
    addLibraryImage();
    const local = { ...library, mediaSource: undefined };
    const undefinedSource = { ...library, mediaSource: "missing" };

    for (const mediaLibraries of [[local], [undefinedSource]]) {
      const plan = await planCdnPublish({ root, config: config({ mediaLibraries }), groups: [] });
      expect(plan.uploads).toEqual([]);
    }
  });

  test("uploads an image shared by two entries once", async () => {
    addLibraryImage();
    files.set(`${root}/src/data/photos/trips/copy.yaml`, "src: ./harbor.jpg\nalt: Copy\n");

    const plan = await planCdnPublish({ root, config: config(), groups: [] });

    expect(plan.uploads).toHaveLength(1);
    expect(plan.writes).toHaveLength(2);
    expect(plan.removals).toHaveLength(1);
  });

  test("blocks when required dimensions can't be read", async () => {
    addLibraryImage();
    images.set(`${root}/src/data/photos/trips/harbor.jpg`, { dimensions: null });
    const required = {
      ...library,
      fields: library.fields.map((field) =>
        field.name === "width" ? { ...field, required: true } : field,
      ),
    };

    const plan = await planCdnPublish({
      root,
      config: config({ mediaLibraries: [required] }),
      groups: [],
    });

    expect(plan.blockers[0]).toContain("couldn't read the dimensions of harbor.jpg");
  });

  test("continues when optional dimensions can't be read", async () => {
    addLibraryImage();
    images.set(`${root}/src/data/photos/trips/harbor.jpg`, { dimensions: null });

    const plan = await planCdnPublish({ root, config: config(), groups: [] });

    expect(plan.blockers).toEqual([]);
    expect(plan.writes[0].content).not.toContain("width:");
  });
});

describe("local file safety", () => {
  test.each([
    ["an Astro component", "src/pages/index.astro", 'import hero from "../data/harbor.jpg";'],
    ["a stylesheet", "src/styles/site.css", "body { background: url(harbor.jpg); }"],
    ["an untyped frontmatter key", "src/content/notes.md", "---\nbanner: ./harbor.jpg\n---\n"],
  ])("keeps a file still used by %s", async (_label, path, content) => {
    addLibraryImage();
    files.set(`${root}/${path}`, content);

    const plan = await planCdnPublish({ root, config: config(), groups: [] });

    expect(plan.uploads).toHaveLength(1);
    expect(plan.removals).toEqual([]);
    expect(plan.warnings[0].message).toContain(path);
  });

  test("keeps an image stored outside the library folder", async () => {
    images.set(`${root}/src/assets/shared.jpg`, {});
    files.set(`${root}/src/data/photos/shared.yaml`, "src: ../../assets/shared.jpg\n");

    const plan = await planCdnPublish({ root, config: config(), groups: [] });

    expect(plan.uploads).toHaveLength(1);
    expect(plan.removals).toEqual([]);
    expect(plan.warnings[0].message).toContain("outside the CDN library");
  });

  test("reports an image that disappears during planning", async () => {
    addLibraryImage();
    inspectMediaFile.mockRejectedValueOnce(new Error("Could not read the image"));

    const plan = await planCdnPublish({ root, config: config(), groups: [] });

    expect(plan.uploads).toEqual([]);
    expect(plan.writes).toEqual([]);
    expect(plan.warnings[0].message).toContain("Could not read the image");
  });

  test("never writes, deletes, or uploads while planning", async () => {
    addLibraryImage();

    await planCdnPublish({ root, config: config(), groups: [] });

    const readOnly = new Set([
      "list_dir_files_optional",
      "path_exists",
      "read_text_file",
      "read_text_file_optional",
    ]);
    for (const [command] of invoke.mock.calls) expect(readOnly).toContain(command);
  });

  test("doesn't reformat content that has no image changes", async () => {
    addLibraryImage();
    const post = `${root}/src/content/posts/untouched.md`;
    files.set(post, "---\ntitle:    'Spaced   out'\ntags: [a,   b]\n---\n![Other](/other.jpg)\n");

    const plan = await planCdnPublish({ root, config: config(), groups: groupFor(post) });

    expect(plan.writes.map((write) => write.path)).not.toContain(post);
  });
});

describe("CDN-bound fields", () => {
  test("uploads a local value from an annotated Astro image field", async () => {
    const post = `${root}/src/content/posts/hello.md`;
    images.set(`${root}/src/content/posts/hero.jpg`, {});
    images.set(`${root}/src/content/posts/other.jpg`, {});
    files.set(post, "---\nhero: ./hero.jpg\nthumb: ./other.jpg\n---\nBody\n");
    const fields = [
      { name: "hero", type: "image", options: { mediaSource: "cdn" } },
      { name: "thumb", type: "image" },
    ];

    const plan = await planCdnPublish({
      root,
      config: config({
        media: [{ name: "src", input: "src", output: "src", relative: true }],
        content: [posts(fields)],
        mediaLibraries: [],
      }),
      groups: groupFor(post),
    });

    expect(plan.uploads.map((upload) => upload.key)).toEqual([
      "images/content/posts/hero-a1b2c3d4.jpg",
    ]);
    const content = plan.writes[0].content;
    expect(content).toContain('hero: "https://media.example.com/images/content/posts/hero-');
    expect(content).toContain("thumb: ./other.jpg");
  });

  test("hands a Pages CMS media folder named after the source to the CDN", async () => {
    const post = `${root}/content/posts/hello.md`;
    images.set(`${root}/public/uploads/used one.jpg`, {});
    images.set(`${root}/public/uploads/unused.jpg`, {});
    files.set(`${root}/public/uploads/notes.txt`, "not an image");
    files.set(post, "---\ncover: /uploads/used%20one.jpg\n---\n![Used](/uploads/used%20one.jpg)\n");

    const plan = await planCdnPublish({
      root,
      config: config({
        media: [{ name: "cdn", input: "public/uploads", output: "/uploads" }],
        content: [{ ...posts([{ name: "cover", type: "image" }]), path: "content/posts" }],
        mediaLibraries: [],
      }),
      groups: groupFor(post),
    });

    expect(plan.uploads.map((upload) => upload.key).sort()).toEqual([
      "images/unused-a1b2c3d4.jpg",
      "images/used-one-a1b2c3d4.jpg",
    ]);
    const used = "https://media.example.com/images/used-one-a1b2c3d4.jpg";
    expect(plan.writes[0].content).toContain(`cover: "${used}"`);
    expect(plan.writes[0].content).toContain(`![Used](${used})`);
    expect(plan.removals).toHaveLength(2);
  });

  test("rewrites values inside data documents", async () => {
    const data = `${root}/src/data/team.json`;
    addLibraryImage();
    files.set(
      data,
      JSON.stringify([{ id: "ana", photo: "/src/data/photos/trips/harbor.jpg" }], null, 2),
    );

    const plan = await planCdnPublish({
      root,
      config: config({
        content: [
          {
            name: "team",
            type: "collection",
            path: "src/data/team.json",
            fields: [{ name: "photo", type: "image" }],
            dataFile: { path: "src/data/team.json", format: "json" },
          },
        ],
      }),
      groups: groupFor(data),
    });

    const write = plan.writes.find((item) => item.path === data)!;
    expect(JSON.parse(write.content)[0].photo).toBe(url);
  });

  test("reports content that can't be parsed", async () => {
    addLibraryImage();
    const post = `${root}/src/content/posts/broken.md`;
    files.set(post, "---\ntitle: [unclosed\n---\nBody\n");

    const plan = await planCdnPublish({ root, config: config(), groups: groupFor(post) });

    expect(plan.blockers[0]).toContain("broken.md");
  });
});

describe("recorded deletes", () => {
  const deleted = {
    sourceName: "cdn",
    key: "images/old-1a2b3c4d.jpg",
    url: "https://media.example.com/images/old-1a2b3c4d.jpg",
  };

  test("plans recorded deletes even without uploads", async () => {
    deletes.push(deleted);

    const plan = await planCdnPublish({ root, config: config(), groups: [] });

    expect(plan.uploads).toEqual([]);
    expect(plan.deletes).toEqual([deleted]);
    expect(await countPendingCdnMedia(root, config())).toBe(1);
  });

  test("never deletes an object another library entry still uses", async () => {
    deletes.push(deleted);
    files.set(`${root}/src/data/photos/copy.yaml`, `src: ${deleted.url}\n`);

    const plan = await planCdnPublish({ root, config: config(), groups: [] });

    expect(plan.deletes).toEqual([]);
  });

  test("keeps deletes for sources this site no longer defines", async () => {
    deletes.push({ ...deleted, sourceName: "retired" });

    const plan = await planCdnPublish({ root, config: config(), groups: [] });

    expect(plan.deletes).toEqual([]);
  });
});

describe("first migrations", () => {
  test("flags a library moving its first images to the CDN", async () => {
    addLibraryImage();

    const plan = await planCdnPublish({ root, config: config(), groups: [] });

    expect(plan.firstMigrations).toEqual(["photos"]);
  });

  test("libraries that already use the CDN aren't flagged again", async () => {
    addLibraryImage();
    files.set(`${root}/src/data/photos/live.yaml`, `src: ${url}\nalt: Live\n`);

    const plan = await planCdnPublish({ root, config: config(), groups: [] });

    expect(plan.uploads).toHaveLength(1);
    expect(plan.firstMigrations).toEqual([]);
  });

  test("counts pending images without hashing them", async () => {
    addLibraryImage();
    files.set(`${root}/src/data/photos/live.yaml`, `src: ${url}\nalt: Live\n`);

    expect(await countPendingCdnMedia(root, config())).toBe(1);
    expect(await countPendingCdnMedia(root, config({ cdnSources: [] }))).toBe(0);
    expect(inspectMediaFile).not.toHaveBeenCalled();
  });
});

describe("unreadable schemas", () => {
  test("blocks when the content config names a source Posto can't resolve", async () => {
    files.set(`${root}/src/content.config.ts`, 'src: image().describe("posto:store=cdn")');

    const plan = await planCdnPublish({
      root,
      config: config({ mediaLibraries: [], content: [] }),
      groups: [],
    });

    expect(plan.blockers[0]).toContain("commit .astro/collections");
  });

  test("an annotation without a defined source doesn't block publishing", async () => {
    files.set(`${root}/src/content.config.ts`, 'src: image().describe("posto:store=cdn")');

    const plan = await planCdnPublish({
      root,
      config: config({ cdnSources: undefined, mediaLibraries: [], content: [] }),
      groups: [],
    });

    expect(plan.blockers).toEqual([]);
  });

  test("sites without CDN media plan nothing", async () => {
    addLibraryImage();

    const plan = await planCdnPublish({
      root,
      config: config({ cdnSources: undefined, mediaLibraries: [] }),
      groups: [],
    });

    expect(plan).toEqual({
      uploads: [],
      writes: [],
      removals: [],
      deletes: [],
      warnings: [],
      blockers: [],
      firstMigrations: [],
    });
    expect(inspectMediaFile).not.toHaveBeenCalled();
  });
});

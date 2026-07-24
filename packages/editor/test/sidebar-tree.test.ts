// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import type { PagesConfig } from "@posto/core/pagescms/config";
import type { FileGroup } from "@posto/ipc";
import { sidebarDisplayTree } from "../src/components/Sidebar";

const file = (path: string) => ({ name: path.split("/").pop()!, path });

describe("sidebarDisplayTree", () => {
  test("models the docs app as one open collection with closed nested folders", () => {
    const root = "/repo/apps/docs";
    const directory = `${root}/src/content/docs`;
    const groups: FileGroup[] = [
      {
        label: "src/content/docs",
        path: directory,
        files: [file(`${directory}/index.mdx`), file(`${directory}/install.mdx`)],
      },
      {
        label: "src/content/docs/development",
        path: `${directory}/development`,
        files: [file(`${directory}/development/getting-started.md`)],
      },
      {
        label: "src/content/docs/deployment/github",
        path: `${directory}/deployment/github`,
        files: [file(`${directory}/deployment/github/tracking-deployment-status.md`)],
      },
      {
        label: "src/content/docs/features",
        path: `${directory}/features`,
        files: [file(`${directory}/features/editing-a-site.md`)],
      },
      {
        label: "src/content/docs/frameworks/astro",
        path: `${directory}/frameworks/astro`,
        files: [file(`${directory}/frameworks/astro/getting-started.md`)],
      },
      {
        label: "src/content/docs/frameworks/pages-cms",
        path: `${directory}/frameworks/pages-cms`,
        files: [file(`${directory}/frameworks/pages-cms/getting-started.md`)],
      },
    ];
    const config: PagesConfig = {
      media: [],
      content: [
        {
          name: "docs",
          label: "Docs",
          type: "collection",
          path: "src/content/docs",
          fields: [],
        },
      ],
    };

    const [docs] = sidebarDisplayTree(groups, config, root);

    expect(docs.group.label).toBe("Docs");
    expect(docs.exact).toBe(true);
    expect(docs.defaultOpen).toBe(true);
    expect(docs.group.files.map((entry) => entry.name)).toEqual(["index.mdx", "install.mdx"]);
    expect(docs.children.map((child) => child.group.label)).toEqual([
      "development",
      "deployment",
      "features",
      "frameworks",
    ]);
    expect(docs.children.every((child) => child.defaultOpen === false)).toBe(true);

    const deployment = docs.children[1];
    expect(deployment.group.files).toEqual([]);
    expect(deployment.children[0]).toMatchObject({
      depth: 2,
      defaultOpen: false,
      group: { label: "github" },
    });

    const frameworks = docs.children[3];
    expect(frameworks.group.files).toEqual([]);
    expect(frameworks.children.map((child) => child.group.label)).toEqual(["astro", "pages-cms"]);
  });

  test("infers ordinary parent folders and keeps each filesystem root open", () => {
    const groups: FileGroup[] = [
      {
        label: "public",
        path: "/site/public",
        files: [file("/site/public/robots.txt")],
      },
      {
        label: "src/pages",
        path: "/site/src/pages",
        files: [file("/site/src/pages/index.mdx")],
      },
      {
        label: "src/pages/blog",
        path: "/site/src/pages/blog",
        files: [file("/site/src/pages/blog/index.mdx")],
      },
      {
        label: "Styles",
        path: "/site",
        kind: "styles",
        files: [file("/site/src/styles/global.css")],
      },
    ];

    const tree = sidebarDisplayTree(groups, null, "/site");

    expect(tree.map((node) => node.group.label)).toEqual(["public", "src", "Styles"]);
    expect(tree.map((node) => node.defaultOpen)).toEqual([true, true, true]);
    expect(tree[1].children[0]).toMatchObject({
      depth: 1,
      defaultOpen: false,
      group: { label: "pages" },
    });
    expect(tree[1].children[0].children[0]).toMatchObject({
      depth: 2,
      defaultOpen: false,
      group: { label: "blog" },
    });
  });
});

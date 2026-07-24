// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// https://astro.build/config
export default defineConfig({
  integrations: [
    starlight({
      title: "Posto",
      logo: {
        src: "../desktop/public/icon.png",
        alt: "Posto app logo",
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/megaflorasoftware/posto",
        },
      ],
      sidebar: [
        {
          label: "Getting started",
          items: [
            { label: "What is Posto?", slug: "what-is-posto" },
            { label: "Opening your first site", slug: "getting-started" },
          ],
        },
        {
          label: "Features",
          items: [
            { label: "Editing a site", slug: "features/editing-a-site" },
            { label: "Previewing a site", slug: "features/previewing-a-site" },
            { label: "Publishing a site", slug: "features/publishing-a-site" },
            {
              label: "Managing site media",
              slug: "features/managing-site-media",
            },
            {
              label: "Environment setup",
              slug: "features/environment-setup",
            },
          ],
        },
        {
          label: "Using Posto with Astro",
          items: [
            {
              label: "Getting started",
              slug: "frameworks/astro/getting-started",
            },
            {
              label: "Typed collections",
              slug: "frameworks/astro/typed-collections",
            },
            {
              label: "Media libraries",
              slug: "frameworks/astro/media-libraries",
            },
            {
              label: "Components and MDX",
              slug: "frameworks/astro/components-and-mdx",
            },
          ],
        },
        {
          label: "Using Posto with Pages CMS",
          items: [
            {
              label: "Getting started",
              slug: "frameworks/pages-cms/getting-started",
            },
            {
              label: "Typed collections",
              slug: "frameworks/pages-cms/typed-collections",
            },
            {
              label: "Media libraries",
              slug: "frameworks/pages-cms/media-libraries",
            },
          ],
        },
        {
          label: "Deploying with GitHub",
          items: [
            {
              label: "Tracking deployment status",
              slug: "deployment/github/tracking-deployment-status",
            },
          ],
        },
        {
          label: "Contributing",
          items: [{ autogenerate: { directory: "development" } }],
        },
      ],
    }),
  ],
});

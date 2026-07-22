import { useEffect, useState } from "react";
import { invoke } from "@posto/ipc";

// Astro config file names, in the order Astro itself resolves them.
const ASTRO_CONFIG_FILES = [
  "astro.config.mjs",
  "astro.config.ts",
  "astro.config.js",
  "astro.config.mts",
  "astro.config.cjs",
];

// `site: 'https://example.com'` in the Astro config — the canonical deploy URL.
const SITE_FIELD = /(?:^|[\s,{(])site\s*:\s*(['"`])([^'"`]+)\1/m;

function normalizeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withProtocol).toString();
  } catch {
    return null;
  }
}

async function readFile(path: string): Promise<string | null> {
  return invoke<string | null>("read_text_file_optional", { path });
}

/** Resolves the site's live URL from, in order of confidence: the Astro
 * config's `site` field, a `public/CNAME` (GitHub Pages / custom domains), or
 * package.json's `homepage`. Null when none is found. */
async function resolveSiteUrl(root: string): Promise<string | null> {
  for (const file of ASTRO_CONFIG_FILES) {
    const source = await readFile(`${root}/${file}`);
    const match = source?.match(SITE_FIELD);
    if (match) {
      const url = normalizeUrl(match[2]);
      if (url) return url;
    }
  }

  const cname = await readFile(`${root}/public/CNAME`);
  if (cname) {
    const host = cname.split(/\r?\n/).find((line) => line.trim() !== "");
    const url = host ? normalizeUrl(host) : null;
    if (url) return url;
  }

  const pkg = await readFile(`${root}/package.json`);
  if (pkg) {
    try {
      const homepage = (JSON.parse(pkg) as { homepage?: unknown }).homepage;
      if (typeof homepage === "string") {
        const url = normalizeUrl(homepage);
        if (url) return url;
      }
    } catch {
      // Malformed package.json — nothing to learn from it.
    }
  }

  return null;
}

/** The open site's live URL, re-resolved whenever the root changes. */
export function useSiteUrl(root: string | null): string | null {
  const [siteUrl, setSiteUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!root) {
      setSiteUrl(null);
      return;
    }
    let active = true;
    setSiteUrl(null);
    void resolveSiteUrl(root)
      .then((url) => {
        if (active) setSiteUrl(url);
      })
      .catch(() => {
        // URL discovery is optional, but an unreadable candidate must stop the
        // search rather than masquerade as an absent file.
      });
    return () => {
      active = false;
    };
  }, [root]);
  return siteUrl;
}

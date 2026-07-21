// Root Vite+ config. This drives `vp check` / `vp lint` / `vp fmt` for the whole
// monorepo; each app keeps its own vite.config.ts for dev and build. Exported as
// a plain object so it resolves without a `vite-plus` dependency on PATH-only
// installs. See https://viteplus.dev/guide/check
// Generated, vendored, and build output — never linted or hand-formatted.
const ignorePatterns = [
  "**/dist/**",
  "**/node_modules/**",
  "temp/**",
  ".claude/**",
  "**/.astro/**",
  "src-tauri/gen/**",
  "src-tauri/target/**",
  // Cargo owns these; rustfmt doesn't touch them and oxfmt shouldn't fight it.
  "**/Cargo.toml",
  "**/Cargo.lock",
];

export default {
  fmt: {
    ignorePatterns,
    overrides: [
      // Docs prose: don't reflow. Reflowing breaks Markdown list items and links
      // across lines (e.g. the download lists in apps/docs/.../index.mdx).
      {
        // `proseWrap: never` keeps list items and links on one line.
        files: ["**/*.md"],
        options: {
          proseWrap: "never",
        },
      },
      {
        // In MDX, prose lives inside JSX (e.g. <Card> children) and is filled to
        // printWidth as JSX text, which proseWrap doesn't govern — so widen it
        // too so those lines aren't wrapped either.
        files: ["**/*.mdx"],
        options: {
          proseWrap: "never",
          printWidth: 320,
        },
      },
    ],
  },
  lint: {
    ignorePatterns,
    options: {
      // Type-aware lint rules (via tsgolint). Type checking itself stays in the
      // per-package `typecheck` scripts so it also runs without Vite+ installed.
      typeAware: true,
    },
  },
};

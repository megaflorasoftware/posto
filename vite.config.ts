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
  "src-tauri/gen/**",
  "src-tauri/target/**",
];

export default {
  fmt: {
    ignorePatterns,
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

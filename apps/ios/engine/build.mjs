// Bundles the engine into one script for JavaScriptCore. `@posto/ipc` (and
// the demo backend's relative import of it) resolves to the native shim, so
// none of the Tauri APIs ship in the bundle.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const shim = resolve(here, "src/ipc.ts");
const realIpc = resolve(here, "../../../packages/ipc/src/index.ts");
const outfile = process.argv[2] ?? resolve(here, "../Posto/Resources/engine.js");

const ipcShim = {
  name: "posto-ipc-shim",
  setup(context) {
    context.onResolve({ filter: /^@posto\/ipc$/ }, () => ({ path: shim }));
    context.onResolve({ filter: /^\.\/index$/ }, (args) =>
      resolve(args.resolveDir, "index.ts") === realIpc ? { path: shim } : undefined,
    );
  },
};

await build({
  entryPoints: [resolve(here, "src/main.ts")],
  outfile,
  bundle: true,
  format: "iife",
  platform: "neutral",
  mainFields: ["module", "main"],
  // JavaScriptCore on iOS 17+ handles ES2022.
  target: "es2022",
  minify: process.env.POSTO_ENGINE_MINIFY === "1",
  sourcemap: false,
  legalComments: "none",
  plugins: [ipcShim],
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});

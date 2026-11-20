import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const shim = resolve(__dirname, "src/ipc.ts");
const realIpc = resolve(__dirname, "../../../packages/ipc/src/index.ts");

// Same aliasing as build.mjs: the engine (and the demo backend) see the
// native `@posto/ipc` shim, never the Tauri module.
export default defineConfig({
  plugins: [
    {
      name: "posto-ipc-shim",
      enforce: "pre",
      resolveId(source, importer) {
        if (source === "@posto/ipc") return shim;
        if (source === "./index" && importer && resolve(importer, "..", "index.ts") === realIpc) {
          return shim;
        }
        return null;
      },
    },
  ],
  test: { environment: "node", testTimeout: 20_000 },
});

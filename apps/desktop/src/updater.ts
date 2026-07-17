import { ask, message } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

const inTauri = "__TAURI_INTERNALS__" in window;

/**
 * Checks GitHub releases for a newer version and, if the user accepts,
 * downloads it and relaunches. Every failure path is silent (logged only):
 * update checks must never get in the way of using the app — the endpoint
 * being unreachable (offline, private repo, deleted release) is normal.
 */
export async function checkForAppUpdate(): Promise<void> {
  if (!inTauri) return;
  try {
    const update = await check();
    if (!update) return;
    const install = await ask(
      `Posto ${update.version} is available (you have ${update.currentVersion}).\n\nDownload and install it now?`,
      { title: "Update available", kind: "info", okLabel: "Install", cancelLabel: "Later" },
    );
    if (!install) return;
    // From here the user has opted in, so failures get a dialog — unlike the
    // background check above, whose failures stay silent.
    try {
      await update.downloadAndInstall();
    } catch (e) {
      await message(`The update could not be installed: ${e}`, {
        title: "Update failed",
        kind: "error",
      });
      return;
    }
    const restart = await ask(
      "The update is installed and will be used the next time Posto starts.\n\nRestart now?",
      { title: "Update ready", kind: "info", okLabel: "Restart", cancelLabel: "Later" },
    );
    if (restart) await relaunch();
  } catch (e) {
    console.warn("update check failed:", e);
  }
}

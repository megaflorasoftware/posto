import { convertFileSrc, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as tauriOpen } from "@tauri-apps/plugin-dialog";
import { openPath as tauriOpenPath, openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener";
import { createFileDropRouter, type FileDropHandler } from "./fileDropRouter";

const inTauri = "__TAURI_INTERNALS__" in window;

export interface FileEntry {
  name: string;
  path: string;
  /** Frontmatter `title:` (else `name:`) for display; filename when absent. */
  title?: string | null;
  /** Top-level scalar frontmatter pairs, for `.posto` collection settings
   * (entry-name templates, sorting). Absent for non-markdown files. */
  frontmatter?: Record<string, string> | null;
  /** Stable UI identity when several logical entries share one physical file. */
  key?: string;
  /** Logical entry inside an Astro file-loader data document. */
  dataEntry?: {
    collection: string;
    id: string;
    path: (string | number)[];
    format: "json" | "yaml" | "toml";
  };
}

export interface FileGroup {
  label: string;
  path: string;
  /** Synthetic-group marker ("styles" for the tree-wide CSS section). */
  kind?: string | null;
  files: FileEntry[];
  /** Astro collection represented by a synthetic data-document group. */
  dataCollection?: string;
}

export interface ChangedFile {
  /** Git porcelain status collapsed to one code: "M", "A", "D", "R", "??", … */
  status: string;
  path: string;
}

export interface ManagedRepo {
  owner: string;
  name: string;
  root: string;
  url: string;
}

export interface CloneProgress {
  received_objects: number;
  total_objects: number;
  indexed_objects: number;
  received_bytes: number;
  checkout_completed: number;
  checkout_total: number;
  phase: "downloading" | "checking_out";
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string;
  avatar_url: string;
  commit_email: string;
}

export interface AuthStatus {
  signed_in: boolean;
  user: GitHubUser | null;
}

export interface DeviceAuthorization {
  user_code: string;
  verification_uri: string;
  expires_in: number;
}

export interface GitHubRepo {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  private: boolean;
  clone_url: string;
  default_branch: string;
  updated_at: string;
}

/** `owner/name` parsed from a local repository's GitHub remote. */
export interface GitHubSlug {
  owner: string;
  name: string;
}

/** A GitHub Actions run, trimmed to what the deployment ring needs. */
export interface WorkflowRun {
  id: number;
  name: string;
  /** Groups runs "of that type" for duration averaging. */
  workflow_id: number;
  /** "queued" | "in_progress" | "completed" (other values pass through). */
  status: string;
  /** "success" | "failure" | "cancelled" | …; null while still running. */
  conclusion: string | null;
  run_started_at: string | null;
  updated_at: string;
  created_at: string;
  html_url: string;
}

export interface ImageLibraryImportRequest {
  libraryRoot: string;
  sourceImagePath: string;
  destinationImagePath: string;
  destinationMetadataPath: string;
  serializedMetadata: string;
  entryId: string;
}

export interface ImageLibraryImportResult {
  entryId: string;
  imagePath: string;
  metadataPath: string;
}

type BrowserBackend = {
  invoke: typeof tauriInvoke;
  openDirectory: (defaultPath?: string) => Promise<string | null>;
  openImageFile: () => Promise<string | null>;
  openImageFiles: () => Promise<string[]>;
  onCloneProgress: (handler: (progress: CloneProgress) => void) => () => void;
  onAuthDeviceCode: (handler: (authorization: DeviceAuthorization) => void) => () => void;
};

let browserBackend: BrowserBackend | null = null;

/** Installs an explicit browser backend. Production Tauri builds never call this. */
export function setBrowserBackend(backend: BrowserBackend): void {
  browserBackend = backend;
}

function requireBrowserBackend(): BrowserBackend {
  if (!browserBackend) {
    throw new Error(
      "No browser IPC backend is installed. Set VITE_POSTO_MOCK=true for browser builds.",
    );
  }
  return browserBackend;
}

const browserInvoke = ((...args: Parameters<typeof tauriInvoke>) =>
  requireBrowserBackend().invoke(...args)) as typeof tauriInvoke;

export const invoke: typeof tauriInvoke = inTauri ? tauriInvoke : browserInvoke;

export function importImageLibraryAsset(
  plan: ImageLibraryImportRequest,
): Promise<ImageLibraryImportResult> {
  return invoke("import_image_library_asset", { plan });
}

export const openDirectory: (defaultPath?: string) => Promise<string | null> = inTauri
  ? (defaultPath) => tauriOpen({ directory: true, defaultPath })
  : (defaultPath) => requireBrowserBackend().openDirectory(defaultPath);

const IMAGE_FILE_FILTERS = [
  {
    name: "Images",
    extensions: ["avif", "gif", "heic", "heif", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp"],
  },
];

async function decodeBitmap(blob: Blob): Promise<ImageBitmap> {
  // EXIF orientation is baked in so portrait photos aren't rotated; retry
  // without the option for engines that reject it.
  try {
    return await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    return createImageBitmap(blob);
  }
}

/** Transcodes already-read image bytes to a JPEG temp file and returns its
 * absolute path. Decoding from an in-memory Blob keeps the canvas same-origin
 * (no asset-protocol taint blocking the export); WKWebView supplies the HEIC
 * decoder. */
async function convertBytesToJpeg(bytes: Uint8Array): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await decodeBitmap(new Blob([bytes]));
  } catch {
    throw new Error("Could not decode the selected image.");
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare the image for import.");
    context.drawImage(bitmap, 0, 0);
    const output = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) =>
          result ? resolve(result) : reject(new Error("Could not convert the image to JPEG.")),
        "image/jpeg",
        0.92,
      );
    });
    const out = Array.from(new Uint8Array(await output.arrayBuffer()));
    return invoke<string>("write_temp_image", { bytes: out, extension: "jpg" });
  } finally {
    bitmap.close();
  }
}

async function prepareImageSource(path: string): Promise<string> {
  // The picker's extension can't be trusted — iOS hands HEIFs back named
  // ".jpeg" — so sniff the file's actual content server-side and only re-encode
  // true HEIFs, which the site (and most browsers) can't render.
  if (!(await invoke<boolean>("probe_image_is_heif", { path }))) return path;
  const bytes = new Uint8Array(await invoke<number[]>("read_image_bytes", { path }));
  return convertBytesToJpeg(bytes);
}

/** Normalizes chosen or dropped source images so the importer always receives a
 * format the app can preview and the published site can render — HEIC/HEIF are
 * transcoded to JPEG, everything else passes through untouched. */
export async function prepareImageSources(paths: string[]): Promise<string[]> {
  if (!inTauri) return paths;
  return Promise.all(paths.map(prepareImageSource));
}

/** The iOS picker returns `file://` URLs, but every filesystem consumer (the
 * native importer, the byte reader, the format probe) expects a plain path, so
 * strip the scheme and percent-decode. Plain paths (desktop) pass through. */
function toFilesystemPath(path: string): string {
  if (!path.startsWith("file://")) return path;
  try {
    return decodeURIComponent(new URL(path).pathname);
  } catch {
    return decodeURIComponent(path.slice("file://".length));
  }
}

export const openImageFile: () => Promise<string | null> = inTauri
  ? async () => {
      const selected = await tauriOpen({ multiple: false, filters: IMAGE_FILE_FILTERS });
      return typeof selected === "string" ? toFilesystemPath(selected) : null;
    }
  : () => requireBrowserBackend().openImageFile();

export const openImageFiles: () => Promise<string[]> = inTauri
  ? async () => {
      const selected = await tauriOpen({ multiple: true, filters: IMAGE_FILE_FILTERS });
      const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
      return paths.map(toFilesystemPath);
    }
  : () => requireBrowserBackend().openImageFiles();

const fileDropRouter = createFileDropRouter();
let fileDropUnlisten: Promise<() => void> | null = null;

/** Routes native desktop file drops through one shared integration point.
 * The highest-priority surface owns the event; recency breaks priority ties. */
export function onFileDrop(handler: FileDropHandler, options: { priority: number }): () => void {
  const unregister = fileDropRouter.register(handler, options.priority);
  if (inTauri && !fileDropUnlisten) {
    fileDropUnlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        fileDropRouter.dispatch(event.payload.paths);
      }
    });
  }
  return () => {
    unregister();
    if (fileDropRouter.size === 0 && fileDropUnlisten) {
      const unlisten = fileDropUnlisten;
      fileDropUnlisten = null;
      void unlisten.then((stop) => stop());
    }
  };
}

/** URL that loads a local file in the webview, or null outside Tauri. */
export function assetUrl(absolutePath: string): string | null {
  return inTauri ? convertFileSrc(absolutePath) : null;
}

const thumbnailRequests = new Map<string, Promise<string | null>>();

/** Returns a cached, bounded preview URL and falls back to the source when its
 * format cannot be decoded by the native thumbnailer. Requests are only
 * deduplicated while in flight so filesystem edits get a fresh cache key. */
export function thumbnailUrl(
  absolutePath: string,
  maxWidth = 320,
  maxHeight = 240,
): Promise<string | null> {
  const original = assetUrl(absolutePath);
  if (!original) return Promise.resolve(null);
  const key = `${absolutePath}:${maxWidth}:${maxHeight}`;
  const pending = thumbnailRequests.get(key);
  if (pending) return pending;
  const request = invoke<string>("image_thumbnail", {
    path: absolutePath,
    maxWidth,
    maxHeight,
  })
    .then((path) => assetUrl(path) ?? original)
    .catch(() => original)
    .finally(() => thumbnailRequests.delete(key));
  thumbnailRequests.set(key, request);
  return request;
}

/** Open a path in the OS file manager; no-op outside Tauri. */
export const openPath: (absolutePath: string) => Promise<void> = inTauri
  ? tauriOpenPath
  : async () => {};

/** Open an external URL in the system browser. */
export const openUrl: (url: string) => Promise<void> = inTauri
  ? tauriOpenUrl
  : async (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    };

/** Open a URL in an in-app browser tab over the app (mobile; falls back to
 * the system browser where no in-app tab exists). */
export function openUrlInApp(url: string): Promise<void> {
  return invoke("open_in_app_browser", { url });
}

/** Dismiss the in-app browser tab if one is presented. */
export function closeInAppBrowser(): Promise<void> {
  return invoke("close_in_app_browser");
}

/**
 * Subscribes to the backend's debounced `fs-changed` events (absolute paths
 * touched outside or inside the app). Returns an unsubscribe function; no-op
 * outside Tauri, where there is no real filesystem to watch.
 */
export function onFsChanged(handler: (paths: string[]) => void): () => void {
  if (!inTauri) return () => {};
  const unlisten = listen<string[]>("fs-changed", (event) => handler(event.payload));
  return () => {
    void unlisten.then((fn) => fn());
  };
}

/** Subscribes to progress updates for the active managed-repository clone. */
export function onCloneProgress(handler: (progress: CloneProgress) => void): () => void {
  if (!inTauri) return requireBrowserBackend().onCloneProgress(handler);
  const unlisten = listen<CloneProgress>("clone-progress", (event) => handler(event.payload));
  return () => {
    void unlisten.then((fn) => fn());
  };
}

/** Subscribes to the public code emitted while GitHub sign-in is pending. */
export function onAuthDeviceCode(
  handler: (authorization: DeviceAuthorization) => void,
): () => void {
  if (!inTauri) return requireBrowserBackend().onAuthDeviceCode(handler);
  const unlisten = listen<DeviceAuthorization>("auth-device-code", (event) =>
    handler(event.payload),
  );
  return () => {
    void unlisten.then((fn) => fn());
  };
}

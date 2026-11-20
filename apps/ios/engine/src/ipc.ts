/**
 * Stands in for `@posto/ipc` inside the engine bundle (and its typecheck).
 * Same exports and command shapes as the Tauri module, routed through the
 * engine's transport. Pickers and drag-and-drop belong to SwiftUI here, so
 * their functions refuse rather than pretend.
 */
import { dispatchBackendEvent, invoke as hostInvoke, onBackendEvent, setTransport } from "./host";
import type {
  ChangedFile,
  CloneProgress,
  DeviceAuthorization,
  FileDropDetails,
  FileMediaImportRequest,
  FileMediaItemRequest,
  ImageDetails,
  ImageLibraryImportRequest,
  ImageLibraryImportResult,
  MediaCredential,
  MediaDeleteIntent,
  MediaFileInspection,
  MediaListing,
  MediaPublishProgress,
  MediaPublishRequest,
  MediaPublishSummary,
  MoveFileMediaItemRequest,
  PublicMediaImportRequest,
  RemoteDeriveRequest,
  RenameFileMediaItemRequest,
} from "../../../../packages/ipc/src/index";

export type * from "../../../../packages/ipc/src/index";

export const invoke = <T>(command: string, args?: Record<string, unknown>): Promise<T> =>
  hostInvoke<T>(command, args);

type BrowserBackend = {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  onCloneProgress: (handler: (progress: CloneProgress) => void) => () => void;
  onAuthDeviceCode: (handler: (authorization: DeviceAuthorization) => void) => () => void;
};

/** The demo backend (`@posto/ipc/mock`) installs itself through this, as it
 * does in browser builds; its events are forwarded like the Rust bridge's. */
export function setBrowserBackend(backend: BrowserBackend): void {
  setTransport({ invoke: (command, args) => backend.invoke(command, args) });
  backend.onCloneProgress((progress) => dispatchBackendEvent("clone-progress", progress));
  backend.onAuthDeviceCode((authorization) =>
    dispatchBackendEvent("auth-device-code", authorization),
  );
}

let nextChannelId = 1;
const channels = new Map<number, (message: unknown) => void>();

onBackendEvent<{ id: number; message: unknown }>("channel", ({ id, message }) => {
  channels.get(id)?.(message);
});

export function listMediaObjects(source: unknown, prefix: string): Promise<MediaListing> {
  return invoke("media_list_objects", { source, prefix });
}

export function saveMediaCredential(
  source: unknown,
  credential: MediaCredential,
  prefix: string,
): Promise<void> {
  return invoke("media_credential_save", { source, credential, prefix });
}

export function recordMediaDelete(root: string, intent: MediaDeleteIntent): Promise<void> {
  return invoke("media_record_delete", { root, intent });
}

export function pendingMediaDeletes(root: string): Promise<MediaDeleteIntent[]> {
  return invoke("media_pending_deletes", { root });
}

export function changedFilesPreview(
  root: string,
  writes: Array<{ path: string; content: string }>,
  removals: string[],
): Promise<ChangedFile[]> {
  return invoke("changed_files_preview", { root, writes, removals });
}

export async function publishMedia(
  request: MediaPublishRequest,
  onProgress: (progress: MediaPublishProgress) => void,
): Promise<MediaPublishSummary> {
  const id = nextChannelId++;
  channels.set(id, onProgress as (message: unknown) => void);
  try {
    return await invoke("media_publish", { request, onProgress: id });
  } finally {
    channels.delete(id);
  }
}

export function importImageLibraryAsset(
  plan: ImageLibraryImportRequest,
): Promise<ImageLibraryImportResult> {
  return invoke("import_image_library_asset", { plan });
}

export function inspectMediaFile(path: string): Promise<MediaFileInspection> {
  return invoke("media_inspect_file", { path });
}

export function importPublicMediaFile(request: PublicMediaImportRequest): Promise<string> {
  return importFileMediaItem({ ...request, mediaRoot: `${request.repositoryRoot}/public` });
}

export function importFileMediaItem(request: FileMediaImportRequest): Promise<string> {
  return invoke("import_file_media_item", { request });
}

export function createFileMediaDirectory(request: {
  repositoryRoot: string;
  mediaRoot: string;
  directory: string;
}): Promise<void> {
  return invoke("create_file_media_directory", request);
}

export function deleteFileMediaItem(request: FileMediaItemRequest): Promise<void> {
  return invoke("delete_media_file", { mediaRoot: request.mediaRoot, filePath: request.path });
}

export function renameFileMediaItem(request: RenameFileMediaItemRequest): Promise<void> {
  return invoke("rename_media_file", {
    mediaRoot: request.mediaRoot,
    filePath: request.path,
    targetFilePath: request.targetPath,
  });
}

export function deleteFileMediaDirectory(request: FileMediaItemRequest): Promise<void> {
  return invoke("delete_media_directory", {
    mediaRoot: request.mediaRoot,
    directoryPath: request.path,
  });
}

export function moveFileMediaItem(request: MoveFileMediaItemRequest): Promise<void> {
  return invoke("move_media_file", {
    mediaRoot: request.mediaRoot,
    filePath: request.path,
    destinationDirectory: request.destinationDirectory,
  });
}

export function moveFileMediaDirectory(request: MoveFileMediaItemRequest): Promise<void> {
  return invoke("move_media_directory", {
    mediaRoot: request.mediaRoot,
    directoryPath: request.path,
    destinationDirectory: request.destinationDirectory,
  });
}

export function readRemoteImageDetails(url: string, needsDate: boolean): Promise<ImageDetails> {
  return invoke("media_remote_image_details", { url, needsDate });
}

export function mediaPlaceholder(path: string): Promise<string> {
  return invoke("media_placeholder", { path });
}

export function deriveRemoteMedia(
  request: RemoteDeriveRequest,
): Promise<{ placeholder: string | null; uploaded: number }> {
  return invoke("media_derive_remote", { request });
}

/** Swift converts HEIC photos to JPEG before they reach the engine and
 * records which original each came from, so the capture date survives. */
const convertedSources = new Map<string, string>();

export function rememberConvertedSource(converted: string, original: string): void {
  convertedSources.set(converted, original);
}

export async function readImageDetails(path: string): Promise<ImageDetails> {
  const details = await invoke<ImageDetails>("media_image_details", { path });
  const original = convertedSources.get(path);
  if (!original) return details;
  const source = await invoke<ImageDetails>("media_image_details", { path: original });
  return { ...details, captureDate: source.captureDate ?? details.captureDate };
}

export async function prepareImageSources(paths: string[]): Promise<string[]> {
  return paths;
}

function unavailable(name: string): never {
  throw new Error(`${name} is handled by the native app`);
}

export const openDirectory = async (): Promise<string | null> => unavailable("openDirectory");
export const openFile = async (): Promise<string | null> => unavailable("openFile");
export const openFiles = async (): Promise<string[]> => unavailable("openFiles");
export const openImageFile = async (): Promise<string | null> => unavailable("openImageFile");
export const openImageFiles = async (): Promise<string[]> => unavailable("openImageFiles");
export const openPath = async (): Promise<void> => {};
export const openUrl = async (url: string): Promise<void> => {
  const { notify } = await import("./host");
  notify("open-url", { url });
};
export const openUrlInApp = openUrl;
export const closeInAppBrowser = async (): Promise<void> => {};

export function onFileDrop(
  _handler: (paths: string[], details: FileDropDetails) => boolean | void,
  _options: { priority: number },
): () => void {
  return () => {};
}

export function assetUrl(): string | null {
  return null;
}

export function thumbnailUrl(): Promise<string | null> {
  return Promise.resolve(null);
}

export function onFsChanged(handler: (paths: string[]) => void): () => void {
  return onBackendEvent<string[]>("fs-changed", handler);
}

export function onCloneProgress(handler: (progress: CloneProgress) => void): () => void {
  return onBackendEvent("clone-progress", handler);
}

export function onAuthDeviceCode(
  handler: (authorization: DeviceAuthorization) => void,
): () => void {
  return onBackendEvent("auth-device-code", handler);
}

const noop = () => () => {};
export const onOpenSettings = noop;
export const onOpenFile = noop;
export const onOpenRepository = noop;
export const onOpenRecent = noop;
export const onOpenSiblingProject = noop;
export const onOpenFullscreenEditor = noop;
export const onToggleSidebar = noop;
export const setOpenFileMenuEnabled = async () => {};
export const setRepositoryMenuItemsEnabled = async () => {};
export const setFullscreenEditorMenuEnabled = async () => {};

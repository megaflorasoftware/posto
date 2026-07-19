import { useEffect, useMemo, useState } from "react";
import {
  discoverImageLibraryAssets,
  matchesImageLibraryPath,
  type ImageLibraryAsset,
} from "@posto/core/astro/imageLibrary";
import type { AstroImageLibrary, ImageLibraryMetadataExtension } from "@posto/core/pagescms/config";
import { invoke, onFsChanged, type FileEntry } from "@posto/ipc";

interface LibrarySnapshot {
  assets: ImageLibraryAsset[];
  directories: string[];
  error: string | null;
  loading: boolean;
}

interface LibraryStore {
  root: string;
  libraryRoot: string;
  library: AstroImageLibrary;
  snapshot: LibrarySnapshot;
  listeners: Set<() => void>;
  loading: Promise<void> | null;
  stopWatching: (() => void) | null;
}

const stores = new Map<string, LibraryStore>();

function storeKey(root: string, library: AstroImageLibrary): string {
  return JSON.stringify([
    root,
    library.collection,
    library.base,
    library.patterns,
    library.metadataExtensions,
    library.imageFieldPath,
  ]);
}

function getStore(root: string, library: AstroImageLibrary): LibraryStore {
  const key = storeKey(root, library);
  let store = stores.get(key);
  if (!store) {
    store = {
      root,
      libraryRoot: `${root}/${library.base}`,
      library,
      snapshot: { assets: [], directories: [], error: null, loading: false },
      listeners: new Set(),
      loading: null,
      stopWatching: null,
    };
    stores.set(key, store);
  }
  return store;
}

function publish(store: LibraryStore, snapshot: Partial<LibrarySnapshot>): void {
  store.snapshot = { ...store.snapshot, ...snapshot };
  for (const listener of store.listeners) listener();
}

async function loadStore(store: LibraryStore): Promise<void> {
  if (store.loading) return store.loading;
  publish(store, { loading: true });
  store.loading = (async () => {
    try {
      const [files, directories] = await Promise.all([
        invoke<FileEntry[]>("list_dir_files", { dir: store.libraryRoot, extensions: [] }),
        invoke<string[]>("list_directories", { dir: store.libraryRoot }),
      ]);
      const metadata = files.filter((file) => {
        const extension = file.name.split(".").pop()?.toLowerCase() as ImageLibraryMetadataExtension;
        const relativePath = file.path.slice(store.libraryRoot.length + 1);
        return store.library.metadataExtensions.includes(extension)
          && matchesImageLibraryPath(store.library, relativePath);
      });
      const documents = await Promise.all(
        metadata.map(async (file) => ({
          path: file.path,
          content: await invoke<string>("read_text_file", { path: file.path }),
        })),
      );
      publish(store, {
        assets: discoverImageLibraryAssets(
          store.library,
          store.root,
          documents,
          files.map((file) => file.path),
        ),
        directories,
        error: null,
      });
    } catch (error) {
      publish(store, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      store.loading = null;
      publish(store, { loading: false });
    }
  })();
  return store.loading;
}

/** One shared asset index and filesystem subscription per repository library. */
export function useImageLibraryAssets(root: string, library: AstroImageLibrary) {
  const store = useMemo(() => getStore(root, library), [root, library]);
  const [, render] = useState(0);

  useEffect(() => {
    const listener = () => render((value) => value + 1);
    store.listeners.add(listener);
    if (!store.stopWatching) {
      store.stopWatching = onFsChanged((paths) => {
        if (paths.some((path) => path === store.libraryRoot || path.startsWith(`${store.libraryRoot}/`))) {
          void loadStore(store);
        }
      });
    }
    void loadStore(store);
    return () => {
      store.listeners.delete(listener);
      if (store.listeners.size === 0) {
        store.stopWatching?.();
        store.stopWatching = null;
      }
    };
  }, [store]);

  return { ...store.snapshot, refresh: () => loadStore(store) };
}

// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { useSchemas } from "../src/hooks/useSchemas";
import { genericAdapter } from "@posto/core/project/generic";
import type { ProjectIO } from "@posto/core/project/adapter";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function projectIO(input: {
  read?: (path: string) => string | null;
  list?: (dir: string) => { name: string; path: string }[] | null;
}): ProjectIO {
  return {
    async pathExists() {
      return false;
    },
    async readTextFileOptional(path) {
      return input.read?.(path) ?? null;
    },
    async listDirFilesOptional(dir) {
      return input.list?.(dir) ?? null;
    },
  };
}

test("malformed posto JSON is skipped without discarding valid preferences", async () => {
  const io = projectIO({
    list() {
      return [
        { name: "bad.json", path: "/site/.posto/collections/bad.json" },
        { name: "good.json", path: "/site/.posto/collections/good.json" },
      ];
    },
    read(path) {
      if (path.endsWith("index.json")) return "{ invalid";
      if (path.endsWith("bad.json")) return "{ invalid";
      if (path.endsWith("good.json")) return '{"displayName":"Good"}';
      return null;
    },
  });
  const { result } = renderHook(() => useSchemas(genericAdapter, io));

  let config = null;
  await act(async () => {
    config = await result.current.loadPostoConfig("/site");
  });

  expect(config).toEqual({
    collections: { good: { displayName: "Good" } },
  });
  expect(result.current.configError).toBeNull();
});

test("pages-only projects retain the conventional public media source", async () => {
  const io = projectIO({
    read(path) {
      if (path.endsWith("/.pages.yml")) return "content: []\n";
      return null;
    },
  });
  const { result } = renderHook(() => useSchemas(genericAdapter, io));

  await act(async () => {
    await result.current.loadSchemas("/site", genericAdapter);
  });

  expect(result.current.config.media).toEqual([{ name: "default", input: "public", output: "/" }]);
});

test("adapter diagnostics are merged into the effective config once", async () => {
  const io = projectIO({});
  const diagnostic = {
    feature: "adapter",
    code: "fixture",
    message: "Adapter diagnostic",
  };
  const adapter = {
    ...genericAdapter,
    async loadDerivedConfig() {
      return {
        config: { media: [], content: [], diagnostics: [diagnostic] },
        diagnostics: [diagnostic],
      };
    },
  };
  const { result } = renderHook(() => useSchemas(adapter, io));

  await act(async () => {
    await result.current.loadSchemas("/site", adapter);
  });

  expect(result.current.config.diagnostics).toEqual([diagnostic]);
});

test("an obsolete project load cannot overwrite the active schemas", async () => {
  const slowPages = deferred<string | null>();
  const io = projectIO({
    read(path) {
      if (path === "/second/.pages.yml")
        return "content:\n  - name: second\n    path: posts\n    type: collection\n";
      return null;
    },
  });
  io.readTextFileOptional = async (path) => {
    if (path === "/first/.pages.yml") return slowPages.promise;
    if (path === "/second/.pages.yml") {
      return "content:\n  - name: second\n    path: posts\n    type: collection\n";
    }
    return null;
  };
  const { result } = renderHook(() => useSchemas(genericAdapter, io));

  let first!: Promise<unknown>;
  await act(async () => {
    first = result.current.loadSchemas("/first", genericAdapter);
    await result.current.loadSchemas("/second", genericAdapter);
  });
  expect(result.current.config.content.map((entry) => entry.name)).toEqual(["second"]);

  await act(async () => {
    slowPages.resolve("content:\n  - name: first\n    path: notes\n    type: collection\n");
    await first;
  });
  expect(result.current.config.content.map((entry) => entry.name)).toEqual(["second"]);
});

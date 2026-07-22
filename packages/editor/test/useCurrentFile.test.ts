// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { invoke } from "@posto/ipc";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AUTOSAVE_DELAY_MS } from "../src/autosave";
import { useCurrentFile } from "../src/hooks/useCurrentFile";

vi.mock("@posto/ipc", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function commandCalls(command: string) {
  return invokeMock.mock.calls.filter(([called]) => called === command);
}

describe("useCurrentFile concurrency", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "read_text_file") return `disk:${String(args?.path)}`;
      return undefined;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("retargets an autosave queued behind a rename", async () => {
    const rename = deferred<void>();
    const afterSave = vi.fn();
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "read_text_file") return `disk:${String(args?.path)}`;
      if (command === "rename_file") return rename.promise;
      return undefined;
    });
    const { result } = renderHook(() => useCurrentFile({ onAfterSave: afterSave }));
    await act(() => result.current.openFile("/site/old.md"));

    let renameResult!: Promise<boolean>;
    act(() => {
      renameResult = result.current.renameOpenFile("/site/old.md", "/site/new.md");
      result.current.onEdit("changed");
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    });
    expect(commandCalls("write_text_file")).toHaveLength(0);

    await act(async () => {
      rename.resolve();
      await renameResult;
    });

    expect(commandCalls("write_text_file")).toEqual([
      ["write_text_file", { path: "/site/new.md", content: "changed" }],
    ]);
    expect(afterSave).toHaveBeenCalledWith("/site/new.md", "changed");
  });

  test("queues rename behind an in-flight save", async () => {
    const write = deferred<void>();
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "read_text_file") return `disk:${String(args?.path)}`;
      if (command === "write_text_file") return write.promise;
      return undefined;
    });
    const { result } = renderHook(() => useCurrentFile({}));
    await act(() => result.current.openFile("/site/old.md"));
    await act(async () => {
      result.current.onEdit("changed");
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
      await Promise.resolve();
    });
    expect(commandCalls("write_text_file")[0]?.[1]).toEqual({
      path: "/site/old.md",
      content: "changed",
    });

    let renameResult!: Promise<boolean>;
    act(() => {
      renameResult = result.current.renameOpenFile("/site/old.md", "/site/new.md");
    });
    expect(commandCalls("rename_file")).toHaveLength(0);

    await act(async () => {
      write.resolve();
      await renameResult;
    });
    expect(commandCalls("rename_file")).toEqual([
      ["rename_file", { from: "/site/old.md", to: "/site/new.md" }],
    ]);
    expect(result.current.filePath).toBe("/site/new.md");
  });

  test("flushes pending edits to the old file before opening another", async () => {
    const { result } = renderHook(() => useCurrentFile({}));
    await act(() => result.current.openFile("/site/old.md"));
    act(() => result.current.onEdit("changed"));

    await act(() => result.current.openFile("/site/next.md"));

    const calls = invokeMock.mock.calls.filter(([command]) =>
      ["write_text_file", "read_text_file"].includes(command),
    );
    expect(calls.slice(-2)).toEqual([
      ["write_text_file", { path: "/site/old.md", content: "changed" }],
      ["read_text_file", { path: "/site/next.md" }],
    ]);
    expect(result.current.filePath).toBe("/site/next.md");
  });

  test("clearPendingSave prevents a deleted or reverted file from being rewritten", () => {
    const { result } = renderHook(() => useCurrentFile({}));
    act(() => {
      result.current.onEdit("changed");
      result.current.clearPendingSave();
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    });
    expect(commandCalls("write_text_file")).toHaveLength(0);
  });

  test("reloadFromDisk does not clobber a pending edit", async () => {
    const { result } = renderHook(() => useCurrentFile({}));
    await act(() => result.current.openFile("/site/post.md"));
    act(() => result.current.onEdit("local edit"));

    await act(() => result.current.reloadFromDisk());

    expect(commandCalls("read_text_file")).toHaveLength(1);
    expect(result.current.fileContent).toBe("local edit");
  });

  test("a failed template rename leaves later autosaves on the original path", async () => {
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "read_text_file") return `disk:${String(args?.path)}`;
      if (command === "rename_file") throw new Error("target exists");
      return undefined;
    });
    const { result } = renderHook(() => useCurrentFile({}));
    await act(() => result.current.openFile("/site/old.md"));

    let renamed = true;
    await act(async () => {
      renamed = await result.current.renameOpenFile("/site/old.md", "/site/taken.md");
    });
    expect(renamed).toBe(false);
    expect(result.current.filePath).toBe("/site/old.md");

    act(() => {
      result.current.onEdit("still here");
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
    });
    await act(async () => Promise.resolve());
    expect(commandCalls("write_text_file").at(-1)?.[1]).toEqual({
      path: "/site/old.md",
      content: "still here",
    });
  });
});

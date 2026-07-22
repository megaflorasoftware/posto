// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { invoke } from "@posto/ipc";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useGitSync } from "../src/hooks/useGitSync";

vi.mock("@posto/ipc", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("useGitSync concurrency", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command) => {
      if (command === "fetch_upstream") return false;
      if (command === "changed_files") return [];
      return "ok";
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("locks publish before awaiting pending saves", async () => {
    const publish = deferred<string>();
    const beforeSync = vi.fn(async () => {});
    invokeMock.mockImplementation(async (command) => {
      if (command === "fetch_upstream") return false;
      if (command === "changed_files") return [];
      if (command === "publish") return publish.promise;
      return "ok";
    });
    const { result } = renderHook(() =>
      useGitSync("/site", { onStatus: vi.fn(), beforeSync }),
    );

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.publish("ship it");
      second = result.current.publish("duplicate");
    });
    await act(async () => Promise.resolve());

    expect(beforeSync).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls.filter(([command]) => command === "publish")).toEqual([
      ["publish", { root: "/site", message: "ship it" }],
    ]);
    await act(async () => {
      publish.resolve("published");
      await Promise.all([first, second]);
    });
    expect(result.current.publishing).toBe(false);
  });

  test("flushes before pull and refreshes content afterward", async () => {
    const order: string[] = [];
    const onStatus = vi.fn();
    invokeMock.mockImplementation(async (command) => {
      if (command === "fetch_upstream") return false;
      if (command === "pull_upstream") {
        order.push("pull");
        return "updated";
      }
      return [];
    });
    const { result } = renderHook(() =>
      useGitSync("/site", {
        onStatus,
        beforeSync: () => {
          order.push("flush");
        },
        afterPull: () => {
          order.push("refresh");
        },
      }),
    );

    await act(() => result.current.fetchChanges());

    expect(order).toEqual(["flush", "pull", "refresh"]);
    expect(onStatus).toHaveBeenNthCalledWith(1, "Fetching changes…", "progress");
    expect(onStatus).toHaveBeenNthCalledWith(2, "updated", "success");
  });
});

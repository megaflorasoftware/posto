// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { invoke } from "@posto/ipc";
import { beforeEach, expect, test, vi } from "vitest";
import { useSchemas } from "../src/hooks/useSchemas";

vi.mock("@posto/ipc", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

beforeEach(() => invokeMock.mockReset());

test("malformed posto JSON is skipped without discarding valid preferences", async () => {
  invokeMock.mockImplementation(async (command, args) => {
    if (command === "list_dir_files_optional") {
      return [
        { name: "bad.json", path: "/site/.posto/collections/bad.json" },
        { name: "good.json", path: "/site/.posto/collections/good.json" },
      ];
    }
    if (command === "read_text_file_optional") {
      const path = String(args?.path);
      if (path.endsWith("index.json")) return "{ invalid";
      if (path.endsWith("bad.json")) return "{ invalid";
      if (path.endsWith("good.json")) return '{"displayName":"Good"}';
    }
    return null;
  });
  const { result } = renderHook(() => useSchemas());

  let config = null;
  await act(async () => {
    config = await result.current.loadPostoConfig("/site");
  });

  expect(config).toEqual({
    collections: { good: { displayName: "Good" } },
  });
  expect(result.current.configError).toBeNull();
});

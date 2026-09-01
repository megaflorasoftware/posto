// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { invoke } from "@posto/ipc";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { slugifyBranchName, useBranches } from "../src/hooks/useBranches";

vi.mock("@posto/ipc", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

describe("slugifyBranchName", () => {
  test("lowercases and dashes free text", () => {
    expect(slugifyBranchName("My New Feature")).toBe("my-new-feature");
  });

  test("keeps grouping slashes", () => {
    expect(slugifyBranchName("feature/Summer Refresh")).toBe("feature/summer-refresh");
  });

  test("strips characters git refs disallow", () => {
    expect(slugifyBranchName("what?~is:this*[here]")).toBe("whatisthishere");
    expect(slugifyBranchName("--odd..name//x--")).toBe("odd.name/x");
  });

  test("empty input stays empty", () => {
    expect(slugifyBranchName("  ")).toBe("");
  });
});

describe("useBranches", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  test("loads the current branch for the root", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "current_branch") return "drafts";
      return null;
    });
    const { result } = renderHook(() => useBranches("/site", { onError: vi.fn() }));
    await act(async () => Promise.resolve());
    expect(result.current.branch).toBe("drafts");
  });

  test("a refused checkout surfaces the conflict and force retries it", async () => {
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "current_branch") return "main";
      if (command === "checkout_branch") {
        return (args as { force: boolean }).force
          ? { switched: true, conflicts: [] }
          : { switched: false, conflicts: ["src/blog/post.mdx"] };
      }
      return null;
    });
    const onSwitched = vi.fn();
    const { result } = renderHook(() => useBranches("/site", { onError: vi.fn(), onSwitched }));
    await act(async () => Promise.resolve());

    await act(async () => {
      await result.current.switchTo("drafts");
    });
    expect(result.current.conflict).toEqual({ branch: "drafts", files: ["src/blog/post.mdx"] });
    expect(result.current.branch).toBe("main");
    expect(onSwitched).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.forceSwitch();
    });
    expect(result.current.conflict).toBeNull();
    expect(result.current.branch).toBe("drafts");
    expect(onSwitched).toHaveBeenCalledWith("/site");
  });

  test("switch errors are reported, not thrown", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "current_branch") return "main";
      if (command === "checkout_branch") throw new Error("boom");
      return null;
    });
    const onError = vi.fn();
    const { result } = renderHook(() => useBranches("/site", { onError }));
    await act(async () => Promise.resolve());
    await act(async () => {
      await result.current.switchTo("drafts");
    });
    expect(onError).toHaveBeenCalledWith("Could not switch branch: boom");
    expect(result.current.branch).toBe("main");
  });
});

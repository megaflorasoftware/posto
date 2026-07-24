import { describe, expect, test } from "vitest";
import { filePathBasename, filePathDirname, normalizeFilePath } from "../src/filePaths";

describe("filesystem path helpers", () => {
  test("normalizes native Windows separators", () => {
    expect(normalizeFilePath("C:\\Projects\\Site\\public")).toBe("C:/Projects/Site/public");
  });

  test("finds basenames and parent directories for either separator", () => {
    expect(filePathBasename("C:\\Projects\\Site\\public\\hero.png")).toBe("hero.png");
    expect(filePathDirname("C:\\Projects\\Site\\public\\hero.png")).toBe("C:/Projects/Site/public");
    expect(filePathBasename("/site/public/images/")).toBe("images");
    expect(filePathDirname("/site/public/images/")).toBe("/site/public");
  });
});

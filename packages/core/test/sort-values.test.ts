import { describe, expect, test } from "vitest";
import { compareSortValues, sortComparisonMode } from "../src/posto/config";

function sorted(values: string[]) {
  const mode = sortComparisonMode(values);
  return [...values].sort((a, b) => compareSortValues(a, b, "asc", mode));
}

describe("collection sort comparison", () => {
  test("sorts homogeneous numbers numerically", () => {
    expect(sorted(["10", "2", "1.5"])).toEqual(["1.5", "2", "10"]);
  });

  test("sorts a mixed column lexically for every pair", () => {
    expect(sorted(["2", "word", "10"])).toEqual(["10", "2", "word"]);
    expect(sorted(["word", "10", "2"])).toEqual(["10", "2", "word"]);
  });
});

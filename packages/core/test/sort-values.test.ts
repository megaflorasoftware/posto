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

  test("ignores empty values when selecting numeric mode", () => {
    expect(sortComparisonMode(["10", "", "2"])).toBe("numeric");
    expect(sorted(["10", "", "2"])).toEqual(["", "2", "10"]);
    expect(sorted(["-1", "", "-10"])).toEqual(["", "-10", "-1"]);
  });

  test("sorts a mixed column lexically for every pair", () => {
    expect(sorted(["2", "word", "10"])).toEqual(["2", "10", "word"]);
    expect(sorted(["word", "10", "2"])).toEqual(["2", "10", "word"]);
  });

  test("keeps natural collation for labels", () => {
    expect(sorted(["Chapter 10", "Chapter 2"])).toEqual(["Chapter 2", "Chapter 10"]);
  });
});

import { describe, expect, test } from "vitest";
import { dateControlValue, dateValueFromControl } from "../src/dateValues";

describe("date field values", () => {
  test("supports the Astro blog template format", () => {
    expect(dateControlValue("Jul 08 2022")).toBe("2022-07-08");
    expect(dateValueFromControl("2022-07-09", "Jul 08 2022")).toBe("Jul 09 2022");
  });

  test("preserves other recognized frontmatter date styles", () => {
    expect(dateControlValue("July 8, 2022")).toBe("2022-07-08");
    expect(dateValueFromControl("2023-11-03", "July 8, 2022")).toBe("November 3, 2023");
    expect(dateValueFromControl("2023-11-03", "07/08/2022")).toBe("11/03/2023");
    expect(dateValueFromControl("2023-11-03", "2022-07-08T10:30:00Z")).toBe("2023-11-03T10:30:00Z");
  });

  test("rejects invalid calendar dates instead of normalizing them", () => {
    expect(dateControlValue("Feb 30 2022")).toBe("");
    expect(dateControlValue("not a date")).toBe("");
  });
});

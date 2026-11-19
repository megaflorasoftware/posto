import { describe, expect, test } from "vitest";
import {
  dateControlValue,
  dateTimeControlValue,
  dateTimeValueFromControl,
  dateValueFromControl,
  hasTimeOfDay,
} from "../src/dateValues";

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

describe("date-and-time values", () => {
  test("a value with a time of day needs a date-and-time picker", () => {
    expect(hasTimeOfDay("2026-10-06T14:27:43")).toBe(true);
    expect(hasTimeOfDay("2026-10-06 14:27")).toBe(true);
    expect(hasTimeOfDay("2022-07-08T10:30:00.000Z")).toBe(true);
    expect(hasTimeOfDay("2026-10-06")).toBe(false);
    expect(hasTimeOfDay("Jul 08 2022")).toBe(false);
    expect(hasTimeOfDay("2026-02-30T10:00:00")).toBe(false);
  });

  test("converts to and from the native input", () => {
    expect(dateTimeControlValue("2026-10-06 14:27:43")).toBe("2026-10-06T14:27:43");
    expect(dateTimeControlValue("2022-07-08T10:30:00Z")).toBe("2022-07-08T10:30:00");
    expect(dateTimeControlValue("")).toBe("");
    expect(dateTimeValueFromControl("2026-10-07T09:05:12", "2026-10-06T14:27:43")).toBe(
      "2026-10-07T09:05:12",
    );
  });

  test("keeps the document's separator and time zone", () => {
    expect(dateTimeValueFromControl("2026-10-07T09:05", "2026-10-06 14:27:43")).toBe(
      "2026-10-07 09:05:00",
    );
    expect(dateTimeValueFromControl("2026-10-07T09:05:12", "2022-07-08T10:30:00.123+02:00")).toBe(
      "2026-10-07T09:05:12+02:00",
    );
    expect(dateTimeValueFromControl("2026-10-07T09:05", "")).toBe("2026-10-07T09:05:00");
    expect(dateTimeValueFromControl("", "2026-10-06T14:27:43")).toBe("");
  });
});
